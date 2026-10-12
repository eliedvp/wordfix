import type { Block, DocumentModel } from '@wordfix/shared';
import { findProtectedRanges, isContinuousText, overlapsAny } from '../../engine/language/text.js';
import { DocxPackage } from '../package-reader.js';
import { parseDocx } from '../parser/docx-parser.js';
import { walkPart } from '../parser/parts.js';
import { childrenOf, tagOf, type XmlNode } from '../parser/xml.js';
import { type PartEdit, rewriteDocx } from './rewrite-docx.js';
import { applyTextEdits, type TextEdit } from './text-edits.js';

/**
 * « Embellir mon document » : présentation améliorée sans changer le sens du texte.
 * Deux options, appliquées à une copie (jamais à l'original) :
 *
 * - Typographie française (usage de France) : espace insécable avant « ; : ! ? »
 *   et à l'intérieur des guillemets « », espaces doubles réduites. Seuls des espaces
 *   sont ajoutés, remplacés ou retirés : les autres caractères ne changent jamais
 *   (contrôlé après coup). Les zones techniques (adresses web, e-mails, fichiers,
 *   code) et les passages non continus dans Word sont laissés tels quels ; chaque
 *   modification passe par le moteur de corrections ciblées (mêmes garde-fous :
 *   champs, contrôles de contenu, révisions, changements de mise en forme).
 *
 * - Mise en page harmonisée des paragraphes de texte courant du corps du document
 *   (ni titres, ni listes, ni tableaux, ni sommaire, ni en-têtes/pieds de page,
 *   ni notes) : texte justifié s'il est aligné à gauche ou sans alignement propre,
 *   interligne 1,15 et 6 pt après le paragraphe s'il n'a pas d'espacement propre.
 *   Aucun texte n'est modifié (contrôlé après coup).
 */

export interface BeautifyOptions {
  typography: boolean;
  layout: boolean;
}

export interface BeautifyResult {
  buffer: Buffer;
  /** Modifications typographiques appliquées. */
  typography: number;
  /** Paragraphes dont la mise en page a été harmonisée. */
  layout: number;
}

export class BeautifyError extends Error {
  readonly problem = 'beautify_verification_failed';
  constructor(detail: string) {
    super(detail);
    this.name = 'BeautifyError';
  }
}

const NBSP = '\u00a0';
/** Blocs de texte rédigé où la typographie est harmonisée. */
const TYPOGRAPHY_KINDS: ReadonlySet<Block['kind']> = new Set([
  'paragraph',
  'list_item',
  'table_cell',
  'caption',
  'heading',
  'footnote',
  'endnote',
]);

export async function beautifyDocx(
  source: Buffer,
  options: BeautifyOptions,
): Promise<BeautifyResult> {
  const before = await parseDocx(source);
  let buffer = source;
  let typography = 0;
  let layout = 0;

  if (options.typography) {
    const edits = typographyEdits(before);
    if (edits.length > 0) {
      const result = await applyTextEdits(buffer, edits);
      if (result.changed) buffer = result.buffer;
      typography = result.applied.length;
    }
  }
  if (options.layout) {
    const result = await harmonizeLayout(buffer);
    buffer = result.buffer;
    layout = result.paragraphs;
  }
  if (buffer !== source) assertSameMeaning(before, await parseDocx(buffer));
  return { buffer, typography, layout };
}

/** Modifications typographiques proposées pour un document (positions du modèle). */
export function typographyEdits(model: DocumentModel): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const block of model.blocks) {
    if (!TYPOGRAPHY_KINDS.has(block.kind)) continue;
    const text = block.text;
    const protectedRanges = findProtectedRanges(text);
    const candidates: { start: number; end: number; replacement: string }[] = [];
    const add = (start: number, end: number, replacement: string) => {
      if (text.slice(start, end) === replacement) return;
      if (overlapsAny(protectedRanges, start, end)) return;
      if (!isContinuousText(block, start, end)) return;
      candidates.push({ start, end, replacement });
    };

    // Espaces (ordinaires) avant « ; : ! ? » et « » » : une seule espace insécable.
    for (const m of text.matchAll(/(?<=\S)( +)(?=[;:!?»])/g)) {
      add(m.index, m.index + m[0].length, NBSP);
    }
    // Espace absente avant « ; ! ? » collé à un mot (« Attention! »), suivi d'une
    // espace, de la fin du paragraphe ou d'un guillemet fermant.
    for (const m of text.matchAll(/(\p{L})([;!?])(?=\s|$|»)/gu)) {
      add(m.index, m.index + m[0].length, `${m[1]}${NBSP}${m[2]}`);
    }
    // « : » collé à un mot et suivi d'une espace (« Note: »), jamais « 10:30 » ni une URL.
    for (const m of text.matchAll(/(\p{L})(:)(?=\s)/gu)) {
      add(m.index, m.index + m[0].length, `${m[1]}${NBSP}${m[2]}`);
    }
    // Guillemet ouvrant : espace(s) ordinaire(s) après « → une insécable ; absente → ajoutée.
    for (const m of text.matchAll(/«( +)(?=\S)/g)) add(m.index, m.index + m[0].length, `«${NBSP}`);
    for (const m of text.matchAll(/«(?=[^\s\u00a0\u202f])(.)/gu)) {
      add(m.index, m.index + m[0].length, `«${NBSP}${m[1]}`);
    }
    // Guillemet fermant collé au mot précédent.
    for (const m of text.matchAll(/([^\s\u00a0\u202f«])»/gu)) {
      add(m.index, m.index + m[0].length, `${m[1]}${NBSP}»`);
    }
    // Espaces doubles (ou plus) entre deux mots.
    for (const m of text.matchAll(/(?<=\S) {2,}(?=[^\s;:!?»])/g)) {
      add(m.index, m.index + m[0].length, ' ');
    }

    // Une seule modification par endroit : les chevauchements sont écartés.
    candidates.sort((a, b) => a.start - b.start || a.end - b.end);
    let lastEnd = -1;
    for (const candidate of candidates) {
      if (candidate.start < lastEnd) continue;
      lastEnd = candidate.end;
      edits.push({
        id: `typo_${block.id}_${candidate.start}`,
        blockId: block.id,
        start: candidate.start,
        end: candidate.end,
        expectedBlockText: text,
        expectedOriginal: text.slice(candidate.start, candidate.end),
        replacement: candidate.replacement,
      });
    }
  }
  return edits;
}

/**
 * Contrôle final : même structure (blocs, natures) et, dans chaque bloc, les mêmes
 * caractères une fois les espaces retirés. Sinon : aucune version embellie.
 */
function assertSameMeaning(before: DocumentModel, after: DocumentModel): void {
  const strip = (text: string) => text.replace(/[\s\u00a0\u202f]+/g, '');
  if (before.blocks.length !== after.blocks.length) {
    throw new BeautifyError('nombre de blocs modifié');
  }
  for (const [index, block] of before.blocks.entries()) {
    const other = after.blocks[index];
    if (!other || other.kind !== block.kind || strip(other.text) !== strip(block.text)) {
      throw new BeautifyError(`texte modifié au-delà des espaces (bloc ${index})`);
    }
  }
}

/* ---------------------------------------------------------------------------------
 * Mise en page des paragraphes de texte courant.
 * ------------------------------------------------------------------------------- */

/** Ordre des éléments de w:pPr (schéma WordprocessingML) après w:spacing et après w:jc. */
const AFTER_SPACING = new Set([
  'w:ind',
  'w:contextualSpacing',
  'w:mirrorIndents',
  'w:suppressOverlap',
  'w:jc',
  'w:textDirection',
  'w:textAlignment',
  'w:textboxTightWrap',
  'w:outlineLvl',
  'w:divId',
  'w:cnfStyle',
  'w:rPr',
  'w:sectPr',
  'w:pPrChange',
]);
const AFTER_JC = new Set([
  'w:textDirection',
  'w:textAlignment',
  'w:textboxTightWrap',
  'w:outlineLvl',
  'w:divId',
  'w:cnfStyle',
  'w:rPr',
  'w:sectPr',
  'w:pPrChange',
]);
const LEFT_ALIGNMENTS = new Set(['left', 'start']);

function element(tag: string, attrs: Record<string, string>): XmlNode {
  return { [tag]: [], ':@': attrs };
}

/** Insère `node` dans `children` avant le premier élément qui doit le suivre. */
function insertOrdered(children: XmlNode[], node: XmlNode, after: ReadonlySet<string>): void {
  const index = children.findIndex((child) => after.has(tagOf(child)));
  if (index < 0) children.push(node);
  else children.splice(index, 0, node);
}

/**
 * Harmonise la mise en page des paragraphes de texte courant du corps. Renvoie le
 * nombre de paragraphes modifiés ; le texte de chaque paragraphe est contrôlé
 * identique après réécriture (sinon : erreur, aucun fichier).
 */
export async function harmonizeLayout(
  source: Buffer,
): Promise<{ buffer: Buffer; paragraphs: number }> {
  const model = await parseDocx(source);
  const pkg = await DocxPackage.open(source);
  const mainPart = pkg.mainPart;
  pkg.close();
  const eligible = new Set(
    model.blocks
      .filter(
        (block) =>
          block.kind === 'paragraph' &&
          block.part === 'body' &&
          block.anchor.xmlPart === mainPart &&
          !block.table &&
          !block.list &&
          !block.heading &&
          block.text.trim().length > 0,
      )
      .map((block) => block.anchor.paragraphIndex),
  );
  if (eligible.size === 0) return { buffer: source, paragraphs: 0 };

  let changed = 0;
  const edit: PartEdit = {
    part: mainPart,
    apply: (_tree, context) => {
      for (const [index, paragraph] of context.paragraphs) {
        if (!eligible.has(index)) continue;
        if (setBodyLayout(paragraph.xml.paragraph)) changed++;
      }
      return changed > 0;
    },
    verify: (reread, context) => {
      const after = walkPart(mainPart, 'body', reread).paragraphs;
      const before = [...context.paragraphs.values()];
      if (after.length !== before.length) {
        throw new BeautifyError('nombre de paragraphes modifié par la mise en page');
      }
      for (const [i, paragraph] of before.entries()) {
        if (after[i]?.text !== paragraph.text) {
          throw new BeautifyError('texte modifié par la mise en page');
        }
      }
    },
  };
  const result = await rewriteDocx(source, [edit]);
  return { buffer: result.buffer, paragraphs: result.changedParts.length > 0 ? changed : 0 };
}

/** Justification et espacement d'un paragraphe ; true si le paragraphe a changé. */
function setBodyLayout(paragraph: XmlNode): boolean {
  const children = childrenOf(paragraph);
  let pPr = children.find((child) => tagOf(child) === 'w:pPr');
  const pPrChildren = pPr ? childrenOf(pPr) : [];
  // Mise en forme suivie (révision) : laissée telle quelle.
  if (pPrChildren.some((child) => tagOf(child) === 'w:pPrChange')) return false;

  let changed = false;
  const nodes = [...pPrChildren];
  if (!nodes.some((child) => tagOf(child) === 'w:spacing')) {
    insertOrdered(
      nodes,
      element('w:spacing', { 'w:after': '120', 'w:line': '276', 'w:lineRule': 'auto' }),
      AFTER_SPACING,
    );
    changed = true;
  }
  const jc = nodes.find((child) => tagOf(child) === 'w:jc');
  if (!jc) {
    insertOrdered(nodes, element('w:jc', { 'w:val': 'both' }), AFTER_JC);
    changed = true;
  } else {
    const attrs = (jc[':@'] ?? {}) as Record<string, string>;
    if (LEFT_ALIGNMENTS.has(attrs['w:val'] ?? '')) {
      jc[':@'] = { ...attrs, 'w:val': 'both' };
      changed = true;
    }
  }
  if (!changed) return false;

  if (pPr) {
    pPr['w:pPr'] = nodes;
  } else {
    pPr = { 'w:pPr': nodes };
    children.unshift(pPr);
  }
  return true;
}
