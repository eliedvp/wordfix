import type { Block, DocumentModel, IssueLocationDto, SectionNode } from '@wordfix/shared';
import { sectionIndex } from '../formatting.js';

/**
 * Localisation lisible d'un bloc : section, numéro de paragraphe dans la
 * section, page estimée et, si utile, une précision (« Tableau 2, ligne 3 »).
 */
export class LocationResolver {
  private readonly blocks: Map<string, Block>;
  private readonly sections: Map<string, SectionNode>;
  private readonly paragraphNumbers = new Map<string, number>();

  constructor(model: DocumentModel) {
    this.blocks = new Map(model.blocks.map((block) => [block.id, block]));
    this.sections = sectionIndex(model);
    const counters = new Map<string, number>();
    for (const block of model.blocks) {
      if (block.part !== 'body' || !block.sectionId || block.kind === 'heading') continue;
      const next = (counters.get(block.sectionId) ?? 0) + 1;
      counters.set(block.sectionId, next);
      this.paragraphNumbers.set(block.id, next);
    }
  }

  block(id: string): Block | undefined {
    return this.blocks.get(id);
  }

  sectionPath(block: Block): string {
    if (block.part === 'header') return 'En-tête de page';
    if (block.part === 'footer') return 'Pied de page';
    const section = block.sectionId ? this.sections.get(block.sectionId) : undefined;
    return section?.path ?? 'Document';
  }

  resolve(blockId: string, start: number, end: number): IssueLocationDto | null {
    const block = this.blocks.get(blockId);
    if (!block) return null;
    return {
      blockId,
      sectionPath: this.sectionPath(block),
      paragraphInSection: this.paragraphNumbers.get(blockId) ?? null,
      estimatedPage: block.page,
      charStart: start,
      charEnd: end,
      label: labelFor(block),
    };
  }
}

function labelFor(block: Block): string | null {
  switch (block.kind) {
    case 'table_cell':
      return block.table
        ? `Tableau ${block.table.index + 1}, ligne ${block.table.row + 1}, colonne ${block.table.col + 1}`
        : 'Tableau';
    case 'footnote':
      return 'Note de bas de page';
    case 'endnote':
      return 'Note de fin';
    case 'heading':
      return 'Titre';
    case 'caption':
      return 'Légende';
    case 'list_item':
      return 'Liste';
    default:
      return null;
  }
}
