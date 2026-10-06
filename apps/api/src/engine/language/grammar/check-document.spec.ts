import type { Block } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';
import type { LanguageInput } from '../types.js';
import { checkDocumentGrammar, type GrammarChecker } from './check-document.js';

function input(blocks: Pick<Block, 'id' | 'kind' | 'text'>[]): LanguageInput {
  return {
    blocks: blocks as Block[],
    meta: {
      wordCount: 0,
      declaredPages: null,
      estimatedPages: 1,
      pageMethod: 'word_count',
      producer: null,
      headingsInferred: false,
      tableCount: 0,
      skipped: { images: 0, equations: 0, textBoxes: 0 },
    },
  };
}

/** Double du client : enregistre les lots et renvoie une erreur par paragraphe contenant « faute ». */
function recorder() {
  const batches: string[][] = [];
  const checker: GrammarChecker = {
    check: (paragraphs) => {
      batches.push([...paragraphs]);
      return Promise.resolve(
        paragraphs.map((text) =>
          text.includes('faute')
            ? [{ start: 0, end: 1, ruleId: 'r', type: 'gn', message: '', suggestions: [] }]
            : [],
        ),
      );
    },
  };
  return { checker, batches };
}

describe('Vérification grammaticale d’un document', () => {
  it('n’envoie que les paragraphes rédigés, non vides, et rattache les erreurs à leur bloc', async () => {
    const { checker, batches } = recorder();
    const findings = await checkDocumentGrammar(
      checker,
      input([
        { id: 'h', kind: 'heading', text: 'Titre avec faute' },
        { id: 'p1', kind: 'paragraph', text: 'Une faute ici.' },
        { id: 'p2', kind: 'paragraph', text: '   ' },
        { id: 'c', kind: 'table_cell', text: 'Cellule avec faute' },
        { id: 'l', kind: 'list_item', text: 'Puce correcte.' },
      ]),
    );
    expect(batches).toEqual([['Une faute ici.', 'Puce correcte.']]);
    expect([...findings.keys()]).toEqual(['p1']);
  });

  it('regroupe les paragraphes en lots (jamais un appel par phrase)', async () => {
    const { checker, batches } = recorder();
    const paragraph = 'Phrase correcte. '.repeat(50); // 850 caractères
    const blocks = Array.from({ length: 1000 }, (_, i) => ({
      id: `p${i}`,
      kind: 'paragraph' as const,
      text: paragraph,
    }));
    await checkDocumentGrammar(checker, input(blocks));
    const limit = LANGUAGE_ENGINE_CONFIG.grammar.batchLength;
    expect(batches.length).toBe(Math.ceil((1000 * paragraph.length) / limit));
    expect(batches.flat()).toHaveLength(1000);
    for (const batch of batches) expect(batch.join('').length).toBeLessThanOrEqual(limit);
  });

  it('ignore les paragraphes démesurés (données, code collé)', async () => {
    const { checker, batches } = recorder();
    const huge = 'x'.repeat(LANGUAGE_ENGINE_CONFIG.grammar.maxParagraphLength + 1);
    await checkDocumentGrammar(checker, input([{ id: 'p', kind: 'paragraph', text: huge }]));
    expect(batches).toEqual([]);
  });
});
