import { describe, expect, it, vi } from 'vitest';
import { localReviewSchema } from './schemas.js';
import { AiError, type AiProvider } from '../ai/ai-provider.js';
import { AI_CIRCUIT_BREAKER_THRESHOLD, guardAi } from './ai-guard.js';

/** Fournisseur scripté : chaque appel consomme la réponse suivante (erreur ou succès). */
function scripted(outcomes: (AiError | Error | 'ok')[]) {
  const generateStructured = vi.fn(() => {
    const next = outcomes.shift() ?? 'ok';
    if (next === 'ok') {
      return Promise.resolve({
        data: { issues: [] },
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      });
    }
    return Promise.reject(next);
  });
  // `fn` : la même fonction simulée, pour compter les appels réellement transmis.
  return {
    name: 'scripted',
    generateStructured,
    fn: generateStructured,
  } as unknown as AiProvider & {
    fn: typeof generateStructured;
  };
}

const request = {
  model: 'm',
  instructions: 'i',
  input: 'x',
  schema: localReviewSchema,
  schemaName: 'local_review',
  maxOutputTokens: 10,
};
const logger = () => ({ warn: vi.fn(), error: vi.fn() });
const unavailable = () => new AiError('unavailable', 'limite de débit (429)');

async function callTimes(ai: AiProvider, times: number) {
  const results: (AiError | 'ok')[] = [];
  for (let i = 0; i < times; i++) {
    results.push(
      await ai.generateStructured(request).then(
        () => 'ok' as const,
        (e: unknown) => e as AiError,
      ),
    );
  }
  return results;
}

describe('guardAi : coupe-circuit IA au niveau de l’analyse', () => {
  it('laisse passer les réponses normales', async () => {
    const inner = scripted(['ok', 'ok']);
    const guarded = guardAi(inner, { analysisId: 'a', logger: logger() });
    expect(await callTimes(guarded, 2)).toEqual(['ok', 'ok']);
    expect(inner.fn).toHaveBeenCalledTimes(2);
  });

  it.each(['quota', 'config'] as const)(
    'erreur définitive (%s) : plus aucun appel ensuite',
    async (kind) => {
      const inner = scripted([new AiError(kind, 'définitive')]);
      const log = logger();
      const guarded = guardAi(inner, { analysisId: 'a', logger: log });
      const results = await callTimes(guarded, 5);
      expect(results.every((r) => r instanceof AiError && r.kind === kind)).toBe(true);
      expect(inner.fn).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledTimes(1);
    },
  );

  it(`échecs temporaires : coupure après ${AI_CIRCUIT_BREAKER_THRESHOLD} échecs consécutifs`, async () => {
    const inner = scripted(Array.from({ length: 10 }, unavailable));
    const log = logger();
    const guarded = guardAi(inner, { analysisId: 'a', logger: log });
    const results = await callTimes(guarded, 10);
    expect(inner.fn).toHaveBeenCalledTimes(AI_CIRCUIT_BREAKER_THRESHOLD);
    expect(results.every((r) => r instanceof AiError && r.kind === 'unavailable')).toBe(true);
    expect((results[9] as AiError).message).toContain('IA coupée pour cette analyse');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('un succès remet le compteur à zéro (pannes intermittentes tolérées)', async () => {
    const inner = scripted([
      unavailable(),
      unavailable(),
      'ok',
      unavailable(),
      unavailable(),
      'ok',
    ]);
    const guarded = guardAi(inner, { analysisId: 'a', logger: logger() });
    const results = await callTimes(guarded, 6);
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(inner.fn).toHaveBeenCalledTimes(6);
  });

  it('requête refusée (bad_request) : jamais de coupure, l’erreur reste visible', async () => {
    const inner = scripted(Array.from({ length: 5 }, () => new AiError('bad_request', '400')));
    const log = logger();
    const guarded = guardAi(inner, { analysisId: 'a', logger: log });
    const results = await callTimes(guarded, 5);
    expect(inner.fn).toHaveBeenCalledTimes(5);
    expect(results.every((r) => r instanceof AiError && r.kind === 'bad_request')).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(5);
  });

  it('réponse invalide : ne déclenche pas le coupe-circuit', async () => {
    const inner = scripted(Array.from({ length: 5 }, () => new AiError('invalid_output', 'x')));
    const guarded = guardAi(inner, { analysisId: 'a', logger: logger() });
    await callTimes(guarded, 5);
    expect(inner.fn).toHaveBeenCalledTimes(5);
  });

  it('les nouvelles tentatives du fournisseur restent les siennes : un appel = un essai du garde', async () => {
    // Le garde ne relance jamais lui-même un appel.
    const inner = scripted([unavailable()]);
    const guarded = guardAi(inner, { analysisId: 'a', logger: logger() });
    await callTimes(guarded, 1);
    expect(inner.fn).toHaveBeenCalledTimes(1);
  });
});
