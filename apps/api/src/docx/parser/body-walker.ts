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
}

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
    this.walkContainer(nodes, out, null, false);
    return out;
  }

  private walkContainer(
    nodes: XmlNode[],
    out: RawParagraph[],
    table: RawParagraph['table'],
    inToc: boolean,
  ): void {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'w:p') {
        out.push(this.readParagraph(node, table, inToc));
      } else if (tag === 'w:tbl') {
        this.walkTable(node, out, inToc);
      } else if (tag === 'w:sdt') {
        const sdtPr = childByTag(node, 'w:sdtPr');
        const gallery = sdtPr ? findGallery(sdtPr) : undefined;
        const content = childByTag(node, 'w:sdtContent');
        const isToc = inToc || /table of contents/i.test(gallery ?? '');
        if (content) this.walkContainer(childrenOf(content), out, table, isToc);
      } else if (tag === 'w:customXml' || tag === 'w:ins') {
        this.walkContainer(childrenOf(node), out, table, inToc);
      }
    }
  }

  private walkTable(node: XmlNode, out: RawParagraph[], inToc: boolean): void {
    const index = this.stats.tables++;
    let row = 0;
    for (const tr of childrenOf(node)) {
      if (tagOf(tr) !== 'w:tr') continue;
      let col = 0;
      for (const tc of childrenOf(tr)) {
        if (tagOf(tc) !== 'w:tc') continue;
        this.walkContainer(childrenOf(tc), out, { index, row, col }, inToc);
        col++;
      }
      row++;
    }
  }

  private readParagraph(node: XmlNode, table: RawParagraph['table'], inToc: boolean): RawParagraph {
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

    this.readInline(childrenOf(node), state);

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
    };
  }

  private readInline(nodes: XmlNode[], state: ParagraphState): void {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'w:r') {
        this.readRun(node, state);
      } else if (tag === 'w:sdt') {
        const content = childByTag(node, 'w:sdtContent');
        if (content) this.readInline(childrenOf(content), state);
      } else if (TRANSPARENT.has(tag)) {
        this.readInline(childrenOf(node), state);
      } else if (tag === 'm:oMath' || tag === 'm:oMathPara') {
        this.stats.equations++;
      } else if (SKIPPED.has(tag)) {
        continue;
      }
    }
  }

  private readRun(run: XmlNode, state: ParagraphState): void {
    const runIndex = state.runIndex++;
    const rPr = childByTag(run, 'w:rPr');
    const bold = rPr ? isOn(childByTag(rPr, 'w:b')) : false;
    const hidden = rPr ? isOn(childByTag(rPr, 'w:vanish')) : false;

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
          this.append(state, value, runIndex, bold);
          break;
        }
        case 'w:tab':
        case 'w:ptab':
          if (!inInstruction) this.append(state, '\t', runIndex, bold, false);
          break;
        case 'w:br':
        case 'w:cr':
          if (!inInstruction && attrOf(child, 'w:type') !== 'page') {
            this.append(state, '\n', runIndex, bold, false);
          }
          break;
        case 'w:noBreakHyphen':
          if (!inInstruction) this.append(state, '-', runIndex, bold);
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
    visible = true,
  ): void {
    if (value.length === 0) return;
    const start = state.text.length;
    state.text += value;
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

function findGallery(sdtPr: XmlNode): string | undefined {
  for (const child of childrenOf(sdtPr)) {
    if (tagOf(child) === 'w:docPartObj') {
      const gallery = childByTag(child, 'w:docPartGallery');
      if (gallery) return attrOf(gallery, 'w:val');
    }
  }
  return undefined;
}
