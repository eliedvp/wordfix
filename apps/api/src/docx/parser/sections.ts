import type { Block, SectionNode } from '@wordfix/shared';

/**
 * Construit l'arbre des sections à partir des titres, et rattache chaque bloc du
 * corps à la section la plus profonde qui le contient.
 */
export function buildSections(blocks: Block[]): SectionNode[] {
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  let counter = 0;
  const newSection = (
    title: string,
    level: number,
    headingBlockId: string | null,
    order: number,
  ) => {
    const parentPath = stack.at(-1)?.path;
    const section: SectionNode = {
      id: `s_${String(counter++).padStart(4, '0')}`,
      title,
      level,
      path: parentPath ? `${parentPath} > ${title}` : title,
      headingBlockId,
      firstOrder: order,
      lastOrder: order,
      wordCount: 0,
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(section);
    else roots.push(section);
    stack.push(section);
    return section;
  };

  blocks.forEach((block, order) => {
    if (block.kind === 'heading' && block.heading) {
      const level = block.heading.level;
      // On ferme les sections de niveau égal ou inférieur, et la section
      // d'ouverture « Début du document » (sans titre) dès le premier vrai titre.
      while (stack.length > 0) {
        const top = stack.at(-1);
        if (!top || (top.level < level && top.headingBlockId !== null)) break;
        stack.pop();
      }
      newSection(block.text.trim().replace(/\s+/g, ' '), level, block.id, order);
    } else if (stack.length === 0 && block.kind !== 'toc_entry') {
      newSection('Début du document', 0, null, order);
    }
    const current = stack.at(-1);
    if (!current) return;
    block.sectionId = current.id;
    // Les bornes et le nombre de mots remontent à toutes les sections ouvertes.
    for (const open of stack) {
      open.lastOrder = order;
      if (block.kind !== 'heading') open.wordCount += block.wordCount;
    }
  });

  return roots;
}

/** Parcourt l'arbre des sections dans l'ordre du document. */
export function flattenSections(sections: SectionNode[]): SectionNode[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}
