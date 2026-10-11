import type { Block } from '@wordfix/shared';
import type { SegmentContext, TextSegment } from '../parser/body-walker.js';
import { DocxPackage, PART_LIMITS } from '../package-reader.js';
import { parseDocx } from '../parser/docx-parser.js';
import { HEADER_FOOTER_PART, walkPart, type WalkedParagraph } from '../parser/parts.js';
import { childByTag, childrenOf, parseXml, tagOf, textOf, type XmlNode } from '../parser/xml.js';
import { type PartEdit, type PartEditContext, rewriteDocx } from './rewrite-docx.js';
import { hasInvalidXmlChar, sameXml, xmlFingerprint } from './xml-writer.js';

/**
 * Remplacements de texte ciblés dans un .docx existant (T2).
 *
 * Chaque correction désigne un passage d'un bloc du modèle (positions dans son texte).
 * Elle n'est appliquée que si l'on est sûr de la correspondance entre l'analyse et le
 * fichier, et seulement dans du texte simple : sinon elle est écartée avec un motif.
 * Le fichier d'origine n'est jamais modifié ; si la vérification finale échoue, aucun
 * fichier n'est produit.
 */

export interface TextEdit {
  /** Identifiant de l'appelant (ex. identifiant du problème), repris dans le compte rendu. */
  id: string;
  blockId: string;
  /** Positions dans le texte du bloc, tel qu'il a été analysé. */
  start: number;
  end: number;
  /** Texte du bloc au moment de l'analyse. */
  expectedBlockText: string;
  /** Passage remplacé, tel qu'il a été analysé. */
  expectedOriginal: string;
  replacement: string;
}

export type TextEditSkipReason =
  /** Bloc absent du document actuel. */
  | 'block_not_found'
  /** Texte du paragraphe différent de celui qui a été analysé. */
  | 'block_changed'
  /** Passage différent de celui qui a été analysé. */
  | 'original_mismatch'
  | 'invalid_range'
  /** Bloc où aucune correction automatique n'est faite (entrée de sommaire). */
  | 'unsupported_block'
  /** Remplacement vide de sens pour le fichier : tabulation, saut de ligne, caractère interdit, trop long. */
  | 'invalid_replacement'
  /** Chevauche une autre correction du même paragraphe. */
  | 'overlap'
  /** Touche une tabulation, un saut de ligne ou un trait d'union insécable. */
  | 'not_plain_text'
  /** Dans le résultat d'un champ (sommaire, renvoi, date…), recalculé par Word. */
  | 'field'
  | 'content_control'
  /** Dans une insertion suivie ou une zone de révision ambiguë. */
  | 'tracked_change'
  /** À cheval sur des runs de mises en forme différentes. */
  | 'format_boundary'
  /** À cheval sur des éléments non voisins (texte masqué, suppression suivie, note…). */
  | 'non_adjacent'
  /** Paragraphe retrouvé dans le XML différent du bloc analysé. */
  | 'anchor_mismatch'
  /**
   * Texte d'en-tête ou de pied de page présent à plusieurs endroits (première page,
   * pages paires…) : le modèle n'en garde qu'une occurrence, la corriger seule
   * laisserait les autres inchangées.
   */
  | 'repeated_header_footer';

export interface TextEditsResult {
  /** Nouveau fichier, ou le fichier d'origine si aucune correction n'a été appliquée. */
  buffer: Buffer;
  changed: boolean;
  applied: string[];
  skipped: { id: string; reason: TextEditSkipReason }[];
}

export class TextEditError extends Error {
  constructor(
    readonly problem: 'verification_failed',
    detail: string,
  ) {
    super(detail);
    this.name = 'TextEditError';
  }
}

export const MAX_REPLACEMENT_LENGTH = 1000;

/** Éléments sans contenu visible qui peuvent séparer deux morceaux de texte voisins. */
const NEUTRAL = new Set([
  'w:rPr',
  'w:proofErr',
  'w:bookmarkStart',
  'w:bookmarkEnd',
  'w:lastRenderedPageBreak',
]);

interface PlannedEdit {
  edit: TextEdit;
  block: Block;
}

export async function applyTextEdits(
  source: Buffer,
  edits: readonly TextEdit[],
): Promise<TextEditsResult> {
  const skipped: TextEditsResult['skipped'] = [];
  if (edits.length === 0) return { buffer: source, changed: false, applied: [], skipped };

  // Lecture du fichier actuel : c'est elle, et non le modèle enregistré, qui fait foi.
  const model = await parseDocx(source);
  const blocks = new Map(model.blocks.map((block) => [block.id, block]));
  const skip = (edit: TextEdit, reason: TextEditSkipReason) =>
    skipped.push({ id: edit.id, reason });

  const repeated = edits.some((edit) => isHeaderFooter(blocks.get(edit.blockId)))
    ? await repeatedHeaderFooterTexts(source)
    : new Set<string>();

  const byBlock = new Map<string, PlannedEdit[]>();
  for (const edit of edits) {
    const block = blocks.get(edit.blockId);
    const reason =
      checkEdit(edit, block) ??
      (isHeaderFooter(block) && repeated.has(headerFooterKey(block!.part, block!.text))
        ? 'repeated_header_footer'
        : null);
    if (reason) skip(edit, reason);
    else byBlock.set(edit.blockId, [...(byBlock.get(edit.blockId) ?? []), { edit, block: block! }]);
  }

  // Par partie et par paragraphe, sans chevauchement.
  const byPart = new Map<string, Map<number, PlannedEdit[]>>();
  for (const planned of byBlock.values()) {
    const kept = withoutOverlaps(planned, (edit) => skip(edit, 'overlap'));
    if (kept.length === 0) continue;
    const { xmlPart, paragraphIndex } = kept[0]!.block.anchor;
    const paragraphs = byPart.get(xmlPart) ?? new Map<number, PlannedEdit[]>();
    paragraphs.set(paragraphIndex, kept);
    byPart.set(xmlPart, paragraphs);
  }

  const applied: string[] = [];
  const partEdits: PartEdit[] = [...byPart].map(([part, paragraphs]) =>
    paragraphEdits(part, paragraphs, applied, skip),
  );
  const result = await rewriteDocx(source, partEdits);
  return {
    buffer: result.buffer,
    changed: result.changedParts.length > 0,
    applied: result.changedParts.length > 0 ? applied : [],
    skipped,
  };
}

function isHeaderFooter(block: Block | undefined): boolean {
  return block?.part === 'header' || block?.part === 'footer';
}

/** Même clé que la lecture, qui ne garde qu'une fois chaque texte d'en-tête ou de pied. */
function headerFooterKey(part: string, text: string): string {
  return `${part}:${text.trim()}`;
}

/** Textes d'en-tête et de pied de page présents plus d'une fois, toutes parties confondues. */
async function repeatedHeaderFooterTexts(source: Buffer): Promise<Set<string>> {
  const pkg = await DocxPackage.open(source);
  try {
    const counts = new Map<string, number>();
    for (const part of pkg.partsMatching(HEADER_FOOTER_PART)) {
      const kind = part.includes('header') ? 'header' : 'footer';
      const tree = parseXml(await pkg.readPart(part, PART_LIMITS.headerFooter), part);
      for (const paragraph of walkPart(part, kind, tree).paragraphs) {
        if (paragraph.text.trim().length === 0) continue;
        const key = headerFooterKey(kind, paragraph.text);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
  } finally {
    pkg.close();
  }
}

/** Contrôles indépendants du XML : correspondance avec l'analyse, remplacement valide. */
function checkEdit(edit: TextEdit, block: Block | undefined): TextEditSkipReason | null {
  if (!block) return 'block_not_found';
  if (block.text !== edit.expectedBlockText) return 'block_changed';
  const { start, end } = edit;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return 'invalid_range';
  }
  if (end > block.text.length) return 'invalid_range';
  if (block.text.slice(start, end) !== edit.expectedOriginal) return 'original_mismatch';
  if (block.kind === 'toc_entry') return 'unsupported_block';
  if (block.anchor.paragraphIndex < 0 || !block.anchor.xmlPart) return 'anchor_mismatch';
  const { replacement } = edit;
  if (
    replacement.length > MAX_REPLACEMENT_LENGTH ||
    /[\t\n\r]/.test(replacement) ||
    hasInvalidXmlChar(replacement) ||
    replacement === edit.expectedOriginal
  ) {
    return 'invalid_replacement';
  }
  return null;
}

/** Garde, dans l'ordre du texte, les corrections qui ne se chevauchent pas (ni ne se touchent à vide). */
function withoutOverlaps(
  planned: PlannedEdit[],
  onOverlap: (edit: TextEdit) => void,
): PlannedEdit[] {
  const sorted = [...planned].sort(
    (a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || cmp(a.edit.id, b.edit.id),
  );
  const kept: PlannedEdit[] = [];
  for (const item of sorted) {
    const last = kept.at(-1)?.edit;
    const touchesEmpty =
      last &&
      item.edit.start === last.end &&
      (item.edit.start === item.edit.end || last.start === last.end);
    if (last && (item.edit.start < last.end || touchesEmpty)) onOverlap(item.edit);
    else kept.push(item);
  }
  return kept;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Modification d'une partie : application des corrections, puis vérification sur l'arbre relu. */
function paragraphEdits(
  part: string,
  planned: Map<number, PlannedEdit[]>,
  applied: string[],
  skip: (edit: TextEdit, reason: TextEditSkipReason) => void,
): PartEdit {
  // Empreintes avant modification, et texte attendu de chaque paragraphe modifié.
  const before = new Map<number, { text: string; full: string; skeleton: string }>();
  const expected = new Map<number, string>();

  return {
    part,
    apply: (_tree, { paragraphs }) => {
      for (const [index, paragraph] of paragraphs) {
        before.set(index, {
          text: paragraph.text,
          full: xmlFingerprint(paragraph.xml.paragraph),
          skeleton: planned.has(index) ? xmlFingerprint(paragraph.xml.paragraph, true) : '',
        });
      }
      let changed = false;
      for (const [index, items] of planned) {
        const paragraph = paragraphs.get(index);
        const block = items[0]!.block;
        if (!paragraph || paragraph.text !== block.text) {
          for (const { edit } of items) skip(edit, 'anchor_mismatch');
          continue;
        }
        let text = block.text;
        // De la fin vers le début : les positions des corrections précédentes restent justes.
        for (const { edit } of [...items].reverse()) {
          const reason = applyToSegments(paragraph, edit);
          if (reason) {
            skip(edit, reason);
            continue;
          }
          text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
          applied.push(edit.id);
          expected.set(index, text);
          changed = true;
        }
      }
      return changed;
    },
    verify: (reread, context) => verifyPart(reread, context, before, expected),
  };
}

/**
 * Vérification sur l'arbre relu : mêmes paragraphes ; texte attendu et structure
 * inchangée (hors texte des w:t) pour les paragraphes modifiés ; paragraphes non
 * ciblés strictement identiques. Toute différence annule la réécriture.
 */
function verifyPart(
  reread: XmlNode[],
  { part, kind }: PartEditContext,
  before: Map<number, { text: string; full: string; skeleton: string }>,
  expected: Map<number, string>,
): void {
  const fail = (detail: string): never => {
    throw new TextEditError('verification_failed', `${detail} (${part})`);
  };
  if (!kind) fail('partie sans texte');
  const after = walkPart(part, kind!, reread).paragraphs;
  if (after.length !== before.size) fail('nombre de paragraphes modifié');
  for (const paragraph of after) {
    const original = before.get(paragraph.paragraphIndex);
    if (!original) fail('paragraphe inattendu');
    const wanted = expected.get(paragraph.paragraphIndex);
    if (wanted === undefined) {
      if (paragraph.text !== original!.text) fail('paragraphe non ciblé modifié');
      if (xmlFingerprint(paragraph.xml.paragraph) !== original!.full) {
        fail('structure d’un paragraphe non ciblé modifiée');
      }
    } else {
      if (paragraph.text !== wanted) fail('texte corrigé inattendu');
      if (xmlFingerprint(paragraph.xml.paragraph, true) !== original!.skeleton) {
        fail('structure d’un paragraphe corrigé modifiée');
      }
    }
  }
}

/** Applique une correction aux éléments w:t du paragraphe, ou renvoie le motif du refus. */
function applyToSegments(paragraph: WalkedParagraph, edit: TextEdit): TextEditSkipReason | null {
  const covered = coveredSegments(paragraph.xml.segments, edit.start, edit.end);
  if (covered.length === 0) return 'anchor_mismatch';

  for (const segment of covered) {
    if (segment.kind !== 'text') return 'not_plain_text';
    const reason = contextReason(segment.context);
    if (reason) return reason;
  }
  for (let i = 1; i < covered.length; i++) {
    const reason = joinReason(covered[i - 1]!, covered[i]!);
    if (reason) return reason;
  }
  // Insertion entre deux morceaux : elle prend la mise en forme du texte qui précède.
  // Si celui qui suit n'a pas exactement la même, le style du texte inséré serait
  // ambigu : refus plutôt qu'un changement de style involontaire.
  if (edit.start === edit.end) {
    const segments = paragraph.xml.segments;
    const previous = segments.find((s) => s.end === edit.start && s.kind === 'text');
    const next = segments.find((s) => s.start === edit.start);
    if (previous && next) {
      const reason = joinReason(previous, next);
      if (reason) return reason;
    }
  }

  // Le remplacement va dans le premier morceau ; les suivants perdent la partie couverte.
  const first = covered[0]!;
  const last = covered.at(-1)!;
  const firstText = currentText(first.node);
  if (covered.length === 1) {
    setText(
      first.node,
      firstText.slice(0, edit.start - first.start) +
        edit.replacement +
        firstText.slice(edit.end - first.start),
    );
    return null;
  }
  setText(first.node, firstText.slice(0, edit.start - first.start) + edit.replacement);
  for (const middle of covered.slice(1, -1)) setText(middle.node, '');
  setText(last.node, currentText(last.node).slice(edit.end - last.start));
  return null;
}

/** Morceaux couverts par [start, end) ; pour une insertion, le morceau qui la reçoit. */
function coveredSegments(segments: TextSegment[], start: number, end: number): TextSegment[] {
  if (start < end) return segments.filter((s) => s.start < end && s.end > start);
  const inside = segments.find((s) => s.start < start && start < s.end);
  if (inside) return [inside];
  // Insertion en limite : le texte qui précède (sa mise en forme), sinon celui qui suit.
  const previous = segments.find((s) => s.end === start && s.kind === 'text');
  const next = segments.find((s) => s.start === start);
  const chosen = previous ?? next;
  return chosen ? [chosen] : [];
}

function contextReason(context: SegmentContext): TextEditSkipReason | null {
  if (context.field) return 'field';
  if (context.contentControl) return 'content_control';
  if (context.trackedInsertion || context.trackedFormatting) return 'tracked_change';
  return null;
}

/**
 * Deux morceaux consécutifs d'une même correction doivent être voisins : rien de
 * visible entre eux (seulement des marques neutres), et, s'ils sont dans deux runs,
 * des runs frères voisins de mise en forme strictement identique.
 */
function joinReason(left: TextSegment, right: TextSegment): TextEditSkipReason | null {
  if (left.run === right.run) {
    const children = childrenOf(left.run);
    return onlyNeutral(children, children.indexOf(left.node), children.indexOf(right.node))
      ? null
      : 'non_adjacent';
  }
  if (left.container !== right.container) return 'non_adjacent';
  const leftChildren = childrenOf(left.run);
  const rightChildren = childrenOf(right.run);
  const siblings = left.container;
  if (
    !onlyNeutral(leftChildren, leftChildren.indexOf(left.node), leftChildren.length) ||
    !onlyNeutral(rightChildren, -1, rightChildren.indexOf(right.node)) ||
    !onlyNeutral(siblings, siblings.indexOf(left.run), siblings.indexOf(right.run))
  ) {
    return 'non_adjacent';
  }
  const leftFormat = childByTag(left.run, 'w:rPr');
  const rightFormat = childByTag(right.run, 'w:rPr');
  const same =
    leftFormat && rightFormat
      ? sameXml([leftFormat], [rightFormat])
      : leftFormat === undefined && rightFormat === undefined;
  return same ? null : 'format_boundary';
}

/** Vrai si tous les éléments strictement entre from et to sont neutres (et l'ordre respecté). */
function onlyNeutral(nodes: XmlNode[], from: number, to: number): boolean {
  if (to <= from || to < 0) return false;
  for (let i = from + 1; i < to; i++) {
    if (!NEUTRAL.has(tagOf(nodes[i]!))) return false;
  }
  return true;
}

function currentText(node: XmlNode): string {
  return childrenOf(node).map(textOf).join('');
}

/** Remplace le texte d'un w:t ; garde les espaces de bord (xml:space="preserve"). */
function setText(node: XmlNode, text: string): void {
  node['w:t'] = text.length > 0 ? [{ '#text': text }] : [];
  if (text !== text.trim() || /\s{2}/.test(text)) {
    const attrs = (node[':@'] as Record<string, string> | undefined) ?? {};
    if (attrs['xml:space'] !== 'preserve') node[':@'] = { ...attrs, 'xml:space': 'preserve' };
  }
}
