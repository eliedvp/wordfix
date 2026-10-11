import type { BlockPart, RunAnchor } from '@wordfix/shared';
import { attrOf, childByTag, childrenOf, isOn, tagOf, textOf, type XmlNode } from './xml.js';

/** Paragraphe brut, tel que lu dans le XML, avant classement en bloc. */
export interface RawParagraph {
  xmlPart: string;
  part: BlockPart;
  paragraphIndex: number;
  text: string;
  runs: RunAnchor[];
  styleId: string | null;
  /** Niveau de plan défini directement sur le paragraphe (0 = niveau 1). */
  outlineLevel: number | null;
  numbering: { numId: string; level: number } | null;
  /** Tout le texte visible est en gras (indice de titre non stylé). */
  allBold: boolean;
  table: { index: number; row: number; col: number } | null;
  inToc: boolean;
  /** Sauts de page de rendu Word situés avant tout texte du paragraphe. */
  renderedBreaksBefore: number;
  /** Sauts de page de rendu Word situés après du texte. */
  renderedBreaksInside: number;
  footnoteRefs: string[];
  endnoteRefs: string[];
  /**
   * Nœuds XML lus (paragraphe w:p, runs w:r indexés par RunAnchor.runIndex, morceaux
   * de texte). Ils servent à retrouver, pour l'écriture, exactement les éléments que
   * la lecture a numérotés. Jamais enregistrés dans le modèle.
   */
  xml: { paragraph: XmlNode; runs: XmlNode[]; segments: TextSegment[] };
}

/** Contexte d'un morceau de texte : où il se trouve dans la structure Word. */
export interface SegmentContext {
  /** Dans un contrôle de contenu (w:sdt) ou une balise XML personnalisée (w:customXml). */
  contentControl: boolean;
  /** Dans une insertion ou un déplacement suivis (mode révision : w:ins, w:moveTo). */
  trackedInsertion: boolean;
  /** Run dont la mise en forme a été modifiée en mode révision (w:rPrChange). */
  trackedFormatting: boolean;
  /** Dans le résultat affiché d'un champ (w:fldChar) ou un champ simple (w:fldSimple). */
  field: boolean;
  /** Dans un lien hypertexte. */
  hyperlink: boolean;
}

/** Nature d'un morceau de texte : texte d'un w:t, ou caractère produit par une balise. */
export type SegmentKind = 'text' | 'tab' | 'break' | 'hyphen';

/** Morceau du texte du paragraphe, relié à l'élément XML qui le produit. */
export interface TextSegment {
  /** Position dans le texte du paragraphe. */
  start: number;
  end: number;
  kind: SegmentKind;
  runIndex: number;
  run: XmlNode;
  /** Élément source (w:t pour kind = text). */
  node: XmlNode;
  /** Liste des frères du run (enfants du paragraphe, du lien…). */
  container: XmlNode[];
  context: SegmentContext;
}

const NO_CONTEXT: SegmentContext = {
  contentControl: false,
  trackedInsertion: false,
  trackedFormatting: false,
  field: false,
  hyperlink: false,
};

export interface WalkStats {
  images: number;
  equations: number;
  textBoxes: number;
  renderedBreaks: number;
  tables: number;
}

/** Balises dont on parcourt simplement le contenu (texte affiché conservé). */
const TRANSPARENT = new Set([
  'w:hyperlink',
  'w:smartTag',
  'w:customXml',
  'w:ins',
  'w:moveTo',
  'w:fldSimple',
  'w:dir',
  'w:bdo',
]);
/** Balises dont le contenu ne fait pas partie du texte lu (suppressions suivies). */
const SKIPPED = new Set(['w:del', 'w:moveFrom', 'w:proofErr', 'w:bookmarkStart', 'w:bookmarkEnd']);

interface ParagraphState {
  text: string;
  runs: RunAnchor[];
  runIndex: number;
  boldChars: number;
  visibleChars: number;
  renderedBefore: number;
  renderedInside: number;
  footnoteRefs: string[];
  endnoteRefs: string[];
  /** Nœuds w:r lus, dans l'ordre de leur runIndex. */
  runNodes: XmlNode[];
  segments: TextSegment[];
  /** Pile des champs Word : on ignore les instructions, on garde le résultat affiché. */
  fieldStack: ('instr' | 'result')[];
}

/**
 * Parcourt le XML d'une partie Word (corps, notes, en-têtes) et produit la liste
 * ordonnée de ses paragraphes, y compris ceux des tableaux et des contrôles de
 * contenu (dont la table des matières automatique).
 */
export class BodyWalker {
  readonly stats: WalkStats = {
    images: 0,
    equations: 0,
    textBoxes: 0,
    renderedBreaks: 0,
    tables: 0,
  };
  private paragraphIndex = 0;

  constructor(
    private readonly xmlPart: string,
    private readonly part: BlockPart,
  ) {}

  walk(nodes: XmlNode[]): RawParagraph[] {
    const out: RawParagraph[] = [];
    this.walkContainer(nodes, out, null, false, NO_CONTEXT);
    return out;
  }

  private walkContainer(
    nodes: XmlNode[],
    out: RawParagraph[],
    table: RawParagraph['table'],
    inToc: boolean,
    context: SegmentContext,
  ): void {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'w:p') {
        out.push(this.readParagraph(node, table, inToc, context));
      } else if (tag === 'w:tbl') {
        this.walkTable(node, out, inToc, context);
      } else if (tag === 'w:sdt') {
        const sdtPr = childByTag(node, 'w:sdtPr');
        const gallery = sdtPr ? findGallery(sdtPr) : undefined;
        const content = childByTag(node, 'w:sdtContent');
        const isToc = inToc || /table of contents/i.test(gallery ?? '');
        if (content) {
          this.walkContainer(childrenOf(content), out, table, isToc, {
            ...context,
            contentControl: true,
          });
        }
      } else if (tag === 'w:customXml') {
        this.walkContainer(childrenOf(node), out, table, inToc, {
          ...context,
          contentControl: true,
        });
      } else if (tag === 'w:ins') {
        this.walkContainer(childrenOf(node), out, table, inToc, {
          ...context,
          trackedInsertion: true,
        });
      }
    }
  }

  private walkTable(
    node: XmlNode,
    out: RawParagraph[],
    inToc: boolean,
    context: SegmentContext,
  ): void {
    const index = this.stats.tables++;
    let row = 0;
    for (const tr of childrenOf(node)) {
      if (tagOf(tr) !== 'w:tr') continue;
      let col = 0;
      for (const tc of childrenOf(tr)) {
        if (tagOf(tc) !== 'w:tc') continue;
        this.walkContainer(childrenOf(tc), out, { index, row, col }, inToc, context);
        col++;
      }
      row++;
    }
  }

  private readParagraph(
    node: XmlNode,
    table: RawParagraph['table'],
    inToc: boolean,
    context: SegmentContext,
  ): RawParagraph {
    const state: ParagraphState = {
      text: '',
      runs: [],
      runIndex: 0,
      boldChars: 0,
      visibleChars: 0,
      renderedBefore: 0,
      renderedInside: 0,
      footnoteRefs: [],
      endnoteRefs: [],
      runNodes: [],
      segments: [],
      fieldStack: [],
    };

    let styleId: string | null = null;
    let outlineLevel: number | null = null;
    let numbering: RawParagraph['numbering'] = null;

    for (const child of childrenOf(node)) {
      if (tagOf(child) === 'w:pPr') {
        const pStyle = childByTag(child, 'w:pStyle');
        styleId = pStyle ? (attrOf(pStyle, 'w:val') ?? null) : null;
        const outline = childByTag(child, 'w:outlineLvl');
        const outlineValue = outline ? Number(attrOf(outline, 'w:val')) : NaN;
        outlineLevel = Number.isInteger(outlineValue) ? outlineValue : null;
        const numPr = childByTag(child, 'w:numPr');
        if (numPr) {
          const numId = attrOf(childByTag(numPr, 'w:numId') ?? {}, 'w:val');
          const ilvl = Number(attrOf(childByTag(numPr, 'w:ilvl') ?? {}, 'w:val') ?? 0);
          if (numId && numId !== '0')
            numbering = { numId, level: Number.isFinite(ilvl) ? ilvl : 0 };
        }
      }
    }

    this.readInline(childrenOf(node), state, context);

    return {
      xmlPart: this.xmlPart,
      part: this.part,
      paragraphIndex: this.paragraphIndex++,
      text: state.text,
      runs: state.runs,
      styleId,
      outlineLevel,
      numbering,
      allBold: state.visibleChars > 0 && state.boldChars === state.visibleChars,
      table,
      inToc,
      renderedBreaksBefore: state.renderedBefore,
      renderedBreaksInside: state.renderedInside,
      footnoteRefs: state.footnoteRefs,
      endnoteRefs: state.endnoteRefs,
      xml: { paragraph: node, runs: state.runNodes, segments: state.segments },
    };
  }

  private readInline(nodes: XmlNode[], state: ParagraphState, context: SegmentContext): void {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'w:r') {
        this.readRun(node, state, context, nodes);
      } else if (tag === 'w:sdt') {
        const content = childByTag(node, 'w:sdtContent');
        if (content)
          this.readInline(childrenOf(content), state, { ...context, contentControl: true });
      } else if (TRANSPARENT.has(tag)) {
        this.readInline(childrenOf(node), state, inlineContext(tag, context));
      } else if (tag === 'm:oMath' || tag === 'm:oMathPara') {
        this.stats.equations++;
      } else if (SKIPPED.has(tag)) {
        continue;
      }
    }
  }

  private readRun(
    run: XmlNode,
    state: ParagraphState,
    inherited: SegmentContext,
    container: XmlNode[],
  ): void {
    const runIndex = state.runIndex++;
    state.runNodes.push(run);
    const rPr = childByTag(run, 'w:rPr');
    const bold = rPr ? isOn(childByTag(rPr, 'w:b')) : false;
    const hidden = rPr ? isOn(childByTag(rPr, 'w:vanish')) : false;
    const runContext: SegmentContext =
      rPr && childByTag(rPr, 'w:rPrChange') ? { ...inherited, trackedFormatting: true } : inherited;
    const source = (node: XmlNode, kind: SegmentKind): SegmentSource => ({
      kind,
      node,
      run,
      container,
      context: state.fieldStack.length > 0 ? { ...runContext, field: true } : runContext,
    });

    for (const child of childrenOf(run)) {
      const tag = tagOf(child);
      const inInstruction = state.fieldStack.at(-1) === 'instr';

      switch (tag) {
        case 'w:fldChar': {
          const type = attrOf(child, 'w:fldCharType');
          if (type === 'begin') state.fieldStack.push('instr');
          else if (type === 'separate' && state.fieldStack.length > 0) {
            state.fieldStack[state.fieldStack.length - 1] = 'result';
          } else if (type === 'end') state.fieldStack.pop();
          break;
        }
        case 'w:t': {
          if (inInstruction || hidden) break;
          const value = childrenOf(child).map(textOf).join('');
          this.append(state, value, runIndex, bold, true, source(child, 'text'));
          break;
        }
        case 'w:tab':
        case 'w:ptab':
          if (!inInstruction) this.append(state, '\t', runIndex, bold, false, source(child, 'tab'));
          break;
        case 'w:br':
        case 'w:cr':
          if (!inInstruction && attrOf(child, 'w:type') !== 'page') {
            this.append(state, '\n', runIndex, bold, false, source(child, 'break'));
          }
          break;
        case 'w:noBreakHyphen':
          if (!inInstruction)
            this.append(state, '-', runIndex, bold, true, source(child, 'hyphen'));
          break;
        case 'w:lastRenderedPageBreak':
          this.stats.renderedBreaks++;
          if (state.text.trim().length === 0) state.renderedBefore++;
          else state.renderedInside++;
          break;
        case 'w:footnoteReference': {
          const id = attrOf(child, 'w:id');
          if (id) state.footnoteRefs.push(id);
          break;
        }
        case 'w:endnoteReference': {
          const id = attrOf(child, 'w:id');
          if (id) state.endnoteRefs.push(id);
          break;
        }
        case 'w:drawing':
        case 'w:pict':
        case 'w:object':
        case 'mc:AlternateContent':
          if (JSON.stringify(child).includes('txbx')) this.stats.textBoxes++;
          else this.stats.images++;
          break;
        default:
          break;
      }
    }
  }

  private append(
    state: ParagraphState,
    value: string,
    runIndex: number,
    bold: boolean,
    visible: boolean,
    source: SegmentSource,
  ): void {
    if (value.length === 0) return;
    const start = state.text.length;
    state.text += value;
    state.segments.push({ ...source, start, end: state.text.length, runIndex });
    const last = state.runs.at(-1);
    if (last && last.runIndex === runIndex && last.end === start) last.end = state.text.length;
    else state.runs.push({ runIndex, start, end: state.text.length });
    if (visible) {
      const visibleCount = value.replace(/\s/g, '').length;
      state.visibleChars += visibleCount;
      if (bold) state.boldChars += visibleCount;
    }
  }
}

type SegmentSource = Omit<TextSegment, 'start' | 'end' | 'runIndex'>;

/** Contexte hérité par le contenu d'une balise en ligne « transparente ». */
function inlineContext(tag: string, context: SegmentContext): SegmentContext {
  switch (tag) {
    case 'w:hyperlink':
      return { ...context, hyperlink: true };
    case 'w:ins':
    case 'w:moveTo':
      return { ...context, trackedInsertion: true };
    case 'w:fldSimple':
      return { ...context, field: true };
    case 'w:customXml':
      return { ...context, contentControl: true };
    default:
      return context;
  }
}

function findGallery(sdtPr: XmlNode): string | undefined {
  for (const child of childrenOf(sdtPr)) {
    if (tagOf(child) === 'w:docPartObj') {
      const gallery = childByTag(child, 'w:docPartGallery');
      if (gallery) return attrOf(gallery, 'w:val');
    }
  }
  return undefined;
}
