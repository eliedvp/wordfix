import { type Block, type BlockKind, type DocumentModel, PARSER_VERSION } from '@wordfix/shared';
import mammoth from 'mammoth';
import { buildSections } from './sections.js';
import { countWords, splitSentences } from './text.js';
import { childrenOf, parseXml, tagOf, textOf, type XmlNode } from './xml.js';

const WORDS_PER_PAGE = 400;
const BLOCK_TAGS: Record<string, BlockKind> = {
  p: 'paragraph',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  li: 'list_item',
};

/**
 * Extraction de secours avec Mammoth (décision D1).
 *
 * Utilisée uniquement si le lecteur principal échoue sur un document inhabituel :
 * l'analyse reste possible, avec une localisation dégradée (section et
 * paragraphe, pages estimées au nombre de mots, pas d'ancre vers le XML).
 */
export async function parseWithMammoth(buffer: Buffer): Promise<DocumentModel> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
  );

  const blocks: Block[] = [];
  let tableIndex = -1;

  const visit = (nodes: XmlNode[], table: Block['table'] | null): void => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'table') {
        tableIndex++;
        let row = 0;
        for (const tr of descendants(node, 'tr')) {
          let col = 0;
          for (const cell of childrenOf(tr)) {
            if (tagOf(cell) !== 'td' && tagOf(cell) !== 'th') continue;
            visit(childrenOf(cell), { index: tableIndex, row, col });
            col++;
          }
          row++;
        }
        continue;
      }
      const kind = BLOCK_TAGS[tag];
      if (kind) {
        const text = inlineText(childrenOf(node)).replace(/\s+\n/g, '\n');
        if (text.trim().length > 0) {
          blocks.push(makeBlock(blocks.length, table ? 'table_cell' : kind, text, tag, table));
        }
        // Une liste peut contenir une sous-liste.
        visit(
          childrenOf(node).filter((child) => ['ul', 'ol'].includes(tagOf(child))),
          table,
        );
        continue;
      }
      visit(childrenOf(node), table);
    }
  };

  visit(parseXml(`<root>${html}</root>`, 'mammoth.html'), null);

  let cumulative = 0;
  for (const block of blocks) {
    block.page = Math.floor(cumulative / WORDS_PER_PAGE) + 1;
    cumulative += block.wordCount;
  }

  return {
    parserVersion: `${PARSER_VERSION}+mammoth`,
    meta: {
      wordCount: cumulative,
      declaredPages: null,
      estimatedPages: Math.max(1, Math.ceil(cumulative / WORDS_PER_PAGE)),
      pageMethod: 'word_count',
      producer: null,
      headingsInferred: false,
      tableCount: tableIndex + 1,
      skipped: { images: 0, equations: 0, textBoxes: 0 },
    },
    sections: buildSections(blocks),
    blocks,
  };
}

function makeBlock(
  index: number,
  kind: BlockKind,
  text: string,
  tag: string,
  table: Block['table'] | null,
): Block {
  const block: Block = {
    id: `b_${String(index).padStart(6, '0')}`,
    kind,
    part: 'body',
    order: index,
    sectionId: null,
    text,
    wordCount: countWords(text),
    sentences: splitSentences(text),
    style: { id: null, name: null },
    page: null,
    // Pas d'ancre fiable vers le XML d'origine en mode secours.
    anchor: { xmlPart: '', paragraphIndex: -1, runs: [] },
  };
  if (kind === 'heading') block.heading = { level: Number(tag.slice(1)), source: 'style' };
  if (table) block.table = table;
  return block;
}

function inlineText(nodes: XmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === '#text') out += textOf(node);
    else if (tag === 'br') out += '\n';
    else if (tag === 'ul' || tag === 'ol' || tag === 'sup') continue;
    else out += inlineText(childrenOf(node));
  }
  return out;
}

function descendants(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of childrenOf(node)) {
    if (tagOf(child) === tag) out.push(child);
    else if (tagOf(child) !== 'table') out.push(...descendants(child, tag));
  }
  return out;
}
