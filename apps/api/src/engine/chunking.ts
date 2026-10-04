import type { Block, DocumentModel, SectionNode } from '@wordfix/shared';
import { flattenSections } from '../docx/parser/sections.js';

/** Taille cible d'un morceau pour l'analyse locale (en mots). */
export const LOCAL_CHUNK_WORDS = 1800;
/** Taille maximale d'un groupe de sections pour l'analyse contextuelle. */
export const CONTEXT_CHUNK_WORDS = 2500;
/** En dessous, une section est regroupée avec la suivante. */
const SMALL_SECTION_WORDS = 300;

/** Blocs soumis à l'analyse de langue (le sommaire et les en-têtes répétés sont exclus). */
export function isAnalyzable(block: Block): boolean {
  return block.kind !== 'toc_entry' && block.text.trim().length > 0;
}

export interface PlannedChunk {
  blockIds: string[];
  /** Bloc précédent, fourni comme contexte sans être analysé. */
  contextBlockId: string | null;
}

/**
 * Découpe pour l'analyse locale : morceaux d'environ 1 800 mots, sans jamais
 * couper un paragraphe. Le dernier paragraphe du morceau précédent est joint
 * comme contexte. Les notes, en-têtes et pieds de page forment un morceau à part.
 */
export function planLocalChunks(model: DocumentModel): PlannedChunk[] {
  const chunks: PlannedChunk[] = [];
  let current: string[] = [];
  let words = 0;
  let previous: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ blockIds: current, contextBlockId: previous });
    previous = current.at(-1) ?? null;
    current = [];
    words = 0;
  };

  const body = model.blocks.filter((block) => block.part === 'body' && isAnalyzable(block));
  for (const block of body) {
    if (words > 0 && words + block.wordCount > LOCAL_CHUNK_WORDS) flush();
    current.push(block.id);
    words += block.wordCount;
  }
  flush();

  previous = null;
  for (const block of model.blocks.filter((b) => b.part !== 'body' && isAnalyzable(b))) {
    if (words > 0 && words + block.wordCount > LOCAL_CHUNK_WORDS) flush();
    current.push(block.id);
    words += block.wordCount;
  }
  flush();

  return chunks;
}

export interface PlannedSectionGroup {
  sectionIds: string[];
  blockIds: string[];
}

/**
 * Découpe pour l'analyse contextuelle : une section (au niveau le plus fin qui
 * reste lisible) avec son contenu. Les petites sections voisines sont regroupées,
 * les très longues sont coupées entre deux paragraphes.
 */
export function planContextGroups(model: DocumentModel): PlannedSectionGroup[] {
  const leaves = leafSections(model.sections);
  const blocksBySection = new Map<string, Block[]>();
  for (const block of model.blocks) {
    if (block.part !== 'body' || !block.sectionId || !isAnalyzable(block)) continue;
    const list = blocksBySection.get(block.sectionId) ?? [];
    list.push(block);
    blocksBySection.set(block.sectionId, list);
  }

  const groups: PlannedSectionGroup[] = [];
  let pending: PlannedSectionGroup = { sectionIds: [], blockIds: [] };
  let pendingWords = 0;

  const flush = () => {
    if (pending.blockIds.length > 0) groups.push(pending);
    pending = { sectionIds: [], blockIds: [] };
    pendingWords = 0;
  };

  for (const section of leaves) {
    const blocks = blocksBySection.get(section.id) ?? [];
    const words = blocks.reduce((sum, block) => sum + block.wordCount, 0);
    if (blocks.length === 0) continue;

    if (pendingWords > 0 && pendingWords + words > CONTEXT_CHUNK_WORDS) flush();

    if (words > CONTEXT_CHUNK_WORDS) {
      flush();
      let part: string[] = [];
      let partWords = 0;
      for (const block of blocks) {
        if (partWords > 0 && partWords + block.wordCount > CONTEXT_CHUNK_WORDS) {
          groups.push({ sectionIds: [section.id], blockIds: part });
          part = [];
          partWords = 0;
        }
        part.push(block.id);
        partWords += block.wordCount;
      }
      if (part.length > 0) groups.push({ sectionIds: [section.id], blockIds: part });
      continue;
    }

    pending.sectionIds.push(section.id);
    pending.blockIds.push(...blocks.map((block) => block.id));
    pendingWords += words;
    if (pendingWords >= SMALL_SECTION_WORDS) flush();
  }
  flush();
  return groups;
}

/**
 * Sections « feuilles » : chaque bloc appartient à exactement une feuille, car
 * les blocs sont rattachés à la section la plus profonde qui les contient.
 */
function leafSections(sections: SectionNode[]): SectionNode[] {
  return flattenSections(sections);
}
