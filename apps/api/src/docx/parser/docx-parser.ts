import { type Block, type BlockKind, type DocumentModel, PARSER_VERSION } from '@wordfix/shared';
import { DocxPackage, PART_LIMITS } from '../package-reader.js';
import { parseDeclaredPages, plausiblePages } from '../docx-validator.js';
import type { RawParagraph, WalkStats } from './body-walker.js';
import {
  ENDNOTES_PART,
  FOOTNOTES_PART,
  HEADER_FOOTER_PART,
  type PartWalk,
  walkPart,
} from './parts.js';
import { buildSections } from './sections.js';
import { StyleMap } from './styles.js';
import { countWords, splitSentences } from './text.js';
import { parseXml } from './xml.js';

const DEFAULT_WORDS_PER_PAGE = 400;
/** Motif d'un titre numéroté : « 2. », « 2.3 », « II. », « A. ». */
const NUMBERED_HEADING = /^((?:\d+(?:\.\d+)*\.?)|(?:[IVXLC]+\.)|(?:[A-Z]\.))\s+\S/;

/**
 * Transforme un fichier .docx en représentation structurée (DocumentModel) :
 * sections, blocs ordonnés, phrases, pages estimées et ancres vers le XML.
 *
 * Limites connues (documentées) : le numéro affiché des listes n'est pas recalculé,
 * les zones de texte, images et équations ne sont pas analysées, et la pagination
 * n'est qu'une estimation (un .docx ne stocke pas de pages).
 */
export async function parseDocx(buffer: Buffer): Promise<DocumentModel> {
  const pkg = await DocxPackage.open(buffer);
  try {
    const [documentXml, stylesXml, appXml, footnotesXml, endnotesXml] = await Promise.all([
      pkg.readPart(pkg.mainPart, PART_LIMITS.mainDocument),
      pkg.readOptionalPart('word/styles.xml', PART_LIMITS.styles),
      pkg.readOptionalPart('docProps/app.xml', PART_LIMITS.docProps),
      pkg.readOptionalPart(FOOTNOTES_PART, PART_LIMITS.notes),
      pkg.readOptionalPart(ENDNOTES_PART, PART_LIMITS.notes),
    ]);

    const styles = StyleMap.parse(stylesXml);
    const body = walkPart(pkg.mainPart, 'body', parseXml(documentXml, pkg.mainPart));

    const headerFooterParagraphs: RawParagraph[] = [];
    for (const part of pkg.partsMatching(HEADER_FOOTER_PART)) {
      const xml = await pkg.readPart(part, PART_LIMITS.headerFooter);
      const kind = part.includes('header') ? 'header' : 'footer';
      headerFooterParagraphs.push(...walkPart(part, kind, parseXml(xml, part)).paragraphs);
    }

    const builder = new ModelBuilder(styles);
    builder.addBody(body.paragraphs);
    builder.inferHeadingsIfNeeded();
    builder.addNotes(
      footnotesXml
        ? walkPart(FOOTNOTES_PART, 'footnotes', parseXml(footnotesXml, FOOTNOTES_PART))
        : null,
      'footnote',
    );
    builder.addNotes(
      endnotesXml
        ? walkPart(ENDNOTES_PART, 'endnotes', parseXml(endnotesXml, ENDNOTES_PART))
        : null,
      'endnote',
    );
    builder.addHeadersFooters(headerFooterParagraphs);

    return builder.build({
      declaredPages: parseDeclaredPages(appXml),
      producer: appXml ? (/<Application>([^<]*)<\/Application>/.exec(appXml)?.[1] ?? null) : null,
      stats: body.stats,
    });
  } finally {
    pkg.close();
  }
}

interface PendingBlock {
  block: Block;
  raw: RawParagraph;
}

class ModelBuilder {
  private readonly body: PendingBlock[] = [];
  private readonly extra: Block[] = [];
  private headingsInferred = false;
  /** Sauts de page situés avant le premier paragraphe non vide. */
  private pendingLeadingBreaks = 0;
  private readonly footnoteOwners = new Map<string, string>();
  private readonly endnoteOwners = new Map<string, string>();
  private nextId = 0;

  constructor(private readonly styles: StyleMap) {}

  addBody(paragraphs: RawParagraph[]): void {
    for (const raw of paragraphs) {
      if (raw.text.trim().length === 0) {
        // Paragraphe vide : pas de bloc, mais ses sauts de page comptent.
        if (this.body.length > 0) {
          const last = this.body.at(-1);
          if (last)
            last.raw.renderedBreaksInside += raw.renderedBreaksBefore + raw.renderedBreaksInside;
        } else if (raw.renderedBreaksBefore + raw.renderedBreaksInside > 0) {
          this.pendingLeadingBreaks += raw.renderedBreaksBefore + raw.renderedBreaksInside;
        }
        continue;
      }
      const block = this.makeBlock(raw, this.classify(raw));
      this.body.push({ block, raw });
      for (const id of raw.footnoteRefs) this.footnoteOwners.set(id, block.id);
      for (const id of raw.endnoteRefs) this.endnoteOwners.set(id, block.id);
    }
  }

  /**
   * Beaucoup de rapports ont des titres mis en forme à la main (gras, numérotés)
   * sans style « Titre ». Si aucun titre n'est stylé, on les déduit : le résultat
   * est marqué « inferred » et signalé comme incertain.
   */
  inferHeadingsIfNeeded(): void {
    if (this.body.some(({ block }) => block.kind === 'heading')) return;

    for (const entry of this.body) {
      const { block, raw } = entry;
      if (block.kind !== 'paragraph' || raw.table) continue;
      const text = block.text.trim();
      const numbered = NUMBERED_HEADING.exec(text);
      const looksShort = block.wordCount <= 15 && text.length <= 120 && !/[.;,:]$/.test(text);
      if (!looksShort || !(raw.allBold || numbered)) continue;

      const marker = numbered?.[1] ?? '';
      const level = /^\d/.test(marker) ? marker.replace(/\.$/, '').split('.').length : 1;
      block.kind = 'heading';
      block.heading = { level: Math.min(level, 9), source: 'inferred' };
      this.headingsInferred = true;
    }
  }

  /** Notes (séparateurs déjà exclus par walkPart), rattachées au paragraphe qui les appelle. */
  addNotes(walk: PartWalk | null, kind: 'footnote' | 'endnote'): void {
    if (!walk) return;
    const owners = kind === 'footnote' ? this.footnoteOwners : this.endnoteOwners;
    for (const raw of walk.paragraphs) {
      if (raw.text.trim().length === 0) continue;
      const ownerId = owners.get(raw.noteId ?? '');
      const owner = this.body.find(({ block }) => block.id === ownerId)?.block;
      const block = this.makeBlock(raw, kind);
      if (owner) block.noteOf = owner.id;
      this.extra.push(block);
    }
  }

  addHeadersFooters(paragraphs: RawParagraph[]): void {
    // Les en-têtes et pieds de page se répètent : chaque texte n'est gardé qu'une fois.
    const seen = new Set<string>();
    for (const raw of paragraphs) {
      const key = `${raw.part}:${raw.text.trim()}`;
      if (raw.text.trim().length === 0 || seen.has(key)) continue;
      seen.add(key);
      this.extra.push(this.makeBlock(raw, raw.part === 'header' ? 'header' : 'footer'));
    }
  }

  build(input: {
    declaredPages: number | null;
    producer: string | null;
    stats: WalkStats;
  }): DocumentModel {
    const bodyBlocks = this.body.map(({ block }) => block);
    const sections = buildSections(bodyBlocks);
    const totalWords = bodyBlocks.reduce((sum, block) => sum + block.wordCount, 0);
    input = { ...input, declaredPages: plausiblePages(input.declaredPages, totalWords) };

    // Pages estimées.
    let pageMethod: DocumentModel['meta']['pageMethod'];
    let estimatedPages: number;
    if (input.stats.renderedBreaks > 0) {
      pageMethod = 'rendered_break';
      let page = 1 + this.pendingLeadingBreaks;
      for (const { block, raw } of this.body) {
        page += raw.renderedBreaksBefore;
        block.page = page;
        page += raw.renderedBreaksInside;
      }
      estimatedPages = Math.max(page, input.declaredPages ?? 0);
    } else {
      pageMethod = 'word_count';
      const wordsPerPage =
        input.declaredPages && totalWords > 0
          ? Math.max(150, totalWords / input.declaredPages)
          : DEFAULT_WORDS_PER_PAGE;
      let cumulative = 0;
      for (const block of bodyBlocks) {
        block.page = Math.floor(cumulative / wordsPerPage) + 1;
        cumulative += block.wordCount;
      }
      estimatedPages = input.declaredPages ?? Math.max(1, Math.ceil(totalWords / wordsPerPage));
    }

    // Les notes héritent de la page et de la section du paragraphe qui les appelle.
    const ownerById = new Map(bodyBlocks.map((block) => [block.id, block]));
    for (const block of this.extra) {
      const owner = block.noteOf ? ownerById.get(block.noteOf) : undefined;
      block.page = owner?.page ?? null;
      block.sectionId = owner?.sectionId ?? null;
    }

    const blocks = [...bodyBlocks, ...this.extra];
    blocks.forEach((block, index) => {
      block.order = index;
    });

    return {
      parserVersion: PARSER_VERSION,
      meta: {
        wordCount:
          totalWords +
          this.extra
            .filter((block) => block.kind === 'footnote' || block.kind === 'endnote')
            .reduce((sum, block) => sum + block.wordCount, 0),
        declaredPages: input.declaredPages,
        estimatedPages,
        pageMethod,
        producer: input.producer,
        headingsInferred: this.headingsInferred,
        tableCount: input.stats.tables,
        skipped: {
          images: input.stats.images,
          equations: input.stats.equations,
          textBoxes: input.stats.textBoxes,
        },
      },
      sections,
      blocks,
    };
  }

  private classify(raw: RawParagraph): BlockKind {
    if (raw.inToc) return 'toc_entry';
    const style = this.styles.resolve(raw.styleId);
    if (style.role === 'toc') return 'toc_entry';
    if (raw.table) return 'table_cell';
    if (style.role === 'heading' || style.role === 'title') return 'heading';
    if (raw.outlineLevel !== null && raw.outlineLevel < 9) return 'heading';
    if (style.role === 'caption') return 'caption';
    if (raw.numbering) return 'list_item';
    return 'paragraph';
  }

  private makeBlock(raw: RawParagraph, kind: BlockKind): Block {
    const block: Block = {
      id: `b_${String(this.nextId++).padStart(6, '0')}`,
      kind,
      part: raw.part,
      order: 0,
      sectionId: null,
      text: raw.text,
      wordCount: countWords(raw.text),
      sentences: splitSentences(raw.text),
      style: { id: raw.styleId, name: this.styles.nameOf(raw.styleId) },
      page: null,
      anchor: { xmlPart: raw.xmlPart, paragraphIndex: raw.paragraphIndex, runs: raw.runs },
    };
    if (kind === 'heading') {
      const style = this.styles.resolve(raw.styleId);
      block.heading =
        style.level !== null
          ? { level: style.level, source: style.source ?? 'style' }
          : { level: (raw.outlineLevel ?? 0) + 1, source: 'outline' };
    }
    if (raw.numbering) block.list = raw.numbering;
    if (raw.table) block.table = raw.table;
    return block;
  }
}
