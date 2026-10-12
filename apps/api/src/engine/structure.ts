import type { DocumentModel, DocumentStructureDto } from '@wordfix/shared';
import {
  createNumberingTracker,
  isComparableTocEntry,
  TYPED_HEADING_NUMBER,
} from './rules/structure-criteria.js';

/**
 * Présence des éléments de structure, à partir du contenu déjà extrait (même modèle
 * que les règles, mêmes critères). Ne dit rien de leur conformité : celle-ci vient des
 * points relevés par les règles (numérotation des titres, sommaire).
 */
export function summarizeStructure(model: DocumentModel): DocumentStructureDto {
  let headings = 0;
  let inferredHeadings = 0;
  let numberedHeadings = 0;
  let comparedNumberedHeadings = 0;
  let tocEntries = 0;
  let comparableTocEntries = 0;
  const track = createNumberingTracker();
  for (const block of model.blocks) {
    if (block.kind === 'heading') {
      headings++;
      if (block.heading?.source === 'inferred') inferredHeadings++;
      const number = TYPED_HEADING_NUMBER.exec(block.text)?.[1];
      if (number) {
        numberedHeadings++;
        if (track(number).expected !== null) comparedNumberedHeadings++;
      }
    } else if (block.kind === 'toc_entry') {
      tocEntries++;
      if (isComparableTocEntry(block.text)) comparableTocEntries++;
    }
  }
  return {
    headings,
    inferredHeadings,
    numberedHeadings,
    comparedNumberedHeadings,
    tocEntries,
    comparableTocEntries,
    pageMethod: model.meta.pageMethod,
  };
}
