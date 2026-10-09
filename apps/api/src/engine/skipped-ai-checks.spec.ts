import { describe, expect, it } from 'vitest';
import { type ChunkOutcome, skippedAiChecks } from './skipped-ai-checks.js';

const chunk = (overrides: Partial<ChunkOutcome>): ChunkOutcome => ({
  stage: 'local',
  index: 0,
  status: 'DONE',
  errorCode: null,
  blockIds: { blocks: [] },
  result: null,
  ...overrides,
});

describe('Vérifications IA non effectuées (détail affiché à l’utilisateur)', () => {
  it('toutes les vérifications IA abouties : rien à signaler', () => {
    expect(
      skippedAiChecks([
        chunk({ stage: 'local' }),
        chunk({ stage: 'context' }),
        chunk({ stage: 'global' }),
      ]),
    ).toEqual([]);
  });

  it('limite de débit sur une partie des morceaux : nombre de morceaux sautés par étape', () => {
    expect(
      skippedAiChecks([
        chunk({ stage: 'local', index: 0 }),
        chunk({ stage: 'local', index: 1, status: 'FAILED', errorCode: 'unavailable' }),
        chunk({ stage: 'local', index: 2, status: 'FAILED', errorCode: 'quota' }),
        chunk({ stage: 'context', index: 0, status: 'FAILED', errorCode: 'unavailable' }),
        chunk({ stage: 'context', index: 1 }),
        chunk({ stage: 'global', status: 'FAILED', errorCode: 'unavailable' }),
      ]),
    ).toEqual([
      { check: 'local', skipped: 2, total: 3 },
      { check: 'context', skipped: 1, total: 2 },
      { check: 'global', skipped: 1, total: 1 },
    ]);
  });

  it('cas ambigus en repli : comptés un par un ; contradictions comptées avec l’analyse globale', () => {
    expect(
      skippedAiChecks([
        chunk({ stage: 'global' }),
        chunk({ stage: 'verify', index: 0, status: 'FAILED', errorCode: 'unavailable' }),
        chunk({ stage: 'verify', index: 1 }),
        chunk({
          stage: 'verify',
          index: 100,
          blockIds: { kind: 'ambiguity', cases: [{}, {}, {}] },
          result: { failed: 'unavailable' },
        }),
        chunk({ stage: 'verify', index: 101, blockIds: { kind: 'ambiguity', cases: [{}, {}] } }),
      ]),
    ).toEqual([
      { check: 'global', skipped: 1, total: 3 },
      { check: 'ambiguity', skipped: 3, total: 5 },
    ]);
  });

  it('échec interne (requête refusée, bug) : relève de PARTIAL_ANALYSIS, pas des vérifications IA', () => {
    expect(
      skippedAiChecks([
        chunk({ stage: 'local', status: 'FAILED', errorCode: 'bad_request' }),
        chunk({ stage: 'local', status: 'FAILED', errorCode: 'unexpected' }),
        chunk({
          stage: 'verify',
          index: 100,
          blockIds: { kind: 'ambiguity', cases: [{}] },
          result: { failed: 'bad_request' },
        }),
      ]),
    ).toEqual([]);
  });
});
