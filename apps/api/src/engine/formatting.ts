import type { Block, DocumentModel, SectionNode } from '@wordfix/shared';
import { flattenSections } from '../docx/parser/sections.js';

const KIND_LABELS: Record<Block['kind'], string> = {
  heading: 'titre',
  paragraph: 'paragraphe',
  list_item: 'élément de liste',
  table_cell: 'cellule de tableau',
  caption: 'légende',
  toc_entry: 'sommaire',
  footnote: 'note de bas de page',
  endnote: 'note de fin',
  header: 'en-tête de page',
  footer: 'pied de page',
};

/** Enlève les balises qui pourraient fermer artificiellement la zone de données. */
function neutralize(text: string): string {
  return text.replace(/<\/?\s*document\s*>/gi, '[balise retirée]');
}

export function formatBlock(block: Block, sectionPath: string | null, context = false): string {
  const label = context ? 'CONTEXTE — ne pas analyser' : KIND_LABELS[block.kind];
  const where = sectionPath ? ` · ${sectionPath}` : '';
  return `[${block.id}] (${label}${where})\n${neutralize(block.text)}`;
}

/** Index de recherche des sections par identifiant. */
export function sectionIndex(model: DocumentModel): Map<string, SectionNode> {
  return new Map(flattenSections(model.sections).map((section) => [section.id, section]));
}

/** Plan du document : un titre par ligne, indenté selon son niveau, avec son volume. */
export function formatOutline(model: DocumentModel): string {
  const lines: string[] = [];
  for (const section of flattenSections(model.sections)) {
    const indent = '  '.repeat(Math.max(section.level - 1, 0));
    const ref = section.headingBlockId ? ` [${section.headingBlockId}]` : '';
    lines.push(`${indent}- ${neutralize(section.title)}${ref} (${section.wordCount} mots)`);
  }
  return lines.join('\n');
}

export function wrapDocument(content: string): string {
  return `<document>\n${content}\n</document>`;
}
