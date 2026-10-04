/**
 * Représentation interne structurée d'un document Word (dossier de conception,
 * section 3). Chaque bloc garde son adresse dans le fichier d'origine : c'est ce
 * qui permet de localiser un problème et, plus tard, de corriger le .docx sans
 * le reconstruire.
 */

export const PARSER_VERSION = 'docx-parser.v1';

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table_cell'
  | 'caption'
  | 'toc_entry'
  | 'footnote'
  | 'endnote'
  | 'header'
  | 'footer';

export type BlockPart = 'body' | 'header' | 'footer' | 'footnotes' | 'endnotes';

export type PageMethod = 'rendered_break' | 'word_count';

export interface TextRange {
  start: number;
  end: number;
}

export interface RunAnchor {
  /** Index du run (w:r) dans le paragraphe, dans l'ordre du XML. */
  runIndex: number;
  /** Position du texte de ce run dans `Block.text`. */
  start: number;
  end: number;
}

export interface BlockAnchor {
  /** Fichier XML d'origine dans le paquet .docx (ex. word/document.xml). */
  xmlPart: string;
  /** Index du paragraphe (w:p) dans l'ordre du parcours de ce fichier. */
  paragraphIndex: number;
  runs: RunAnchor[];
}

export interface Block {
  /** Identifiant stable dans le document (ex. b_000412). */
  id: string;
  kind: BlockKind;
  part: BlockPart;
  /** Ordre de lecture dans le document. */
  order: number;
  sectionId: string | null;
  text: string;
  wordCount: number;
  sentences: TextRange[];
  heading?: { level: number; source: 'style' | 'outline' | 'inferred' };
  list?: { numId: string; level: number };
  table?: { index: number; row: number; col: number };
  style: { id: string | null; name: string | null };
  page: number | null;
  anchor: BlockAnchor;
  /** Pour une note : identifiant du bloc qui l'appelle. */
  noteOf?: string;
}

export interface SectionNode {
  id: string;
  title: string;
  level: number;
  /** Chemin lisible, ex. « 2. Présentation > 2.3 Infrastructure ». */
  path: string;
  headingBlockId: string | null;
  /** Ordre du premier et du dernier bloc du corps couverts par la section. */
  firstOrder: number;
  lastOrder: number;
  wordCount: number;
  children: SectionNode[];
}

export interface DocumentModel {
  parserVersion: string;
  meta: {
    wordCount: number;
    declaredPages: number | null;
    estimatedPages: number;
    pageMethod: PageMethod;
    producer: string | null;
    /** Vrai quand aucun titre n'est stylé et que les titres ont été déduits. */
    headingsInferred: boolean;
    tableCount: number;
    /** Éléments présents mais non analysés (images, équations, zones de texte). */
    skipped: { images: number; equations: number; textBoxes: number };
  };
  sections: SectionNode[];
  blocks: Block[];
}
