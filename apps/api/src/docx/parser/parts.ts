import type { BlockPart } from '@wordfix/shared';
import { BodyWalker, type RawParagraph, type WalkStats } from './body-walker.js';
import { attrOf, childrenOf, findDeep, tagOf, type XmlNode } from './xml.js';

/**
 * Parcours d'une partie Word, commun à la lecture (modèle du document) et à
 * l'écriture (retrouver les paragraphes et les runs à modifier).
 *
 * Les adresses enregistrées dans le modèle (paragraphIndex, runIndex) ne sont pas
 * « le n-ième w:p du fichier » mais « le n-ième paragraphe visité par ce parcours » :
 * les zones de texte ne sont pas parcourues, les notes de séparation sont exclues
 * avant le comptage, les runs supprimés en mode suivi ne sont pas comptés. Lecture
 * et écriture doivent donc utiliser exactement ce même parcours.
 */

export type WalkedPartKind = Extract<
  BlockPart,
  'body' | 'header' | 'footer' | 'footnotes' | 'endnotes'
>;

export const FOOTNOTES_PART = 'word/footnotes.xml';
export const ENDNOTES_PART = 'word/endnotes.xml';
export const HEADER_FOOTER_PART = /^word\/(header|footer)\d*\.xml$/;

/** Paragraphe parcouru ; pour une note, identifiant de la note qui le contient. */
export type WalkedParagraph = RawParagraph & { noteId?: string };

export interface PartWalk {
  paragraphs: WalkedParagraph[];
  stats: WalkStats;
}

/** Nature d'une partie du paquet, ou null si elle ne contient pas de texte lu. */
export function partKindOf(part: string, mainPart: string): WalkedPartKind | null {
  if (part === mainPart) return 'body';
  if (part === FOOTNOTES_PART) return 'footnotes';
  if (part === ENDNOTES_PART) return 'endnotes';
  const headerFooter = HEADER_FOOTER_PART.exec(part);
  if (headerFooter) return headerFooter[1] === 'header' ? 'header' : 'footer';
  return null;
}

const ROOT_TAG: Record<WalkedPartKind, string> = {
  body: 'w:body',
  header: 'w:hdr',
  footer: 'w:ftr',
  footnotes: 'w:footnotes',
  endnotes: 'w:endnotes',
};

/** Paragraphes d'une partie déjà analysée, dans l'ordre et avec la numérotation du modèle. */
export function walkPart(part: string, kind: WalkedPartKind, tree: XmlNode[]): PartWalk {
  const root = findDeep(tree, ROOT_TAG[kind]);
  const walker = new BodyWalker(part, kind);
  if (kind !== 'footnotes' && kind !== 'endnotes') {
    return { paragraphs: walker.walk(root ? childrenOf(root) : []), stats: walker.stats };
  }

  // Notes : un seul parcours pour toute la partie (numérotation continue), en
  // excluant les notes de séparation avant de compter leurs paragraphes.
  const noteTag = kind === 'footnotes' ? 'w:footnote' : 'w:endnote';
  const paragraphs: WalkedParagraph[] = [];
  for (const note of root ? childrenOf(root) : []) {
    if (tagOf(note) !== noteTag) continue;
    const type = attrOf(note, 'w:type');
    if (type && type !== 'normal') continue;
    const noteId = attrOf(note, 'w:id') ?? '';
    for (const raw of walker.walk(childrenOf(note))) paragraphs.push({ ...raw, noteId });
  }
  return { paragraphs, stats: walker.stats };
}
