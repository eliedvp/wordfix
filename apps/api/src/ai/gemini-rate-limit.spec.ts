import { ThinkingLevel } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forEachConcurrent } from '../common/concurrency.js';
import { guardAi } from '../engine/ai-guard.js';
import { localReviewSchema } from '../engine/schemas.js';
import { AiError } from './ai-provider.js';
import { GeminiAiProvider } from './providers/gemini.provider.js';
import { RequestRateLimiter } from './rate-limiter.js';

/**
 * Plusieurs morceaux d'un même document analysés en parallèle (AI_CONCURRENCY = 4)
 * face à une API Gemini simulée qui applique un vrai quota glissant de N requêtes par
 * minute, comme l'offre gratuite (429 + retryDelay). Vrai SDK, vrai fournisseur, vrai
 * coupe-circuit ; seuls `fetch` et l'horloge sont simulés (aucun appel réseau).
 */
beforeEach(() => {
  // L'horloge simulée de Vitest fait avancer Date.now et setTimeout ensemble.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

const CONCURRENCY = 4;
const CHUNKS = 12;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** API Gemini simulée : quota glissant de `quota` requêtes acceptées par 60 s. */
function simulatedGemini(quota: number) {
  const accepted: number[] = [];
  const log: { at: number; status: number; retryDelayMs?: number }[] = [];
  const fetchImpl = (() => {
    const now = Date.now();
    const recent = accepted.filter((t) => t > now - 60_000);
    if (recent.length >= quota) {
      const retryDelayMs = recent[0]! + 60_000 - now;
      log.push({ at: now, status: 429, retryDelayMs });
      return Promise.resolve(
        json(429, {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'You exceeded your current quota.',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
              },
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: `${Math.ceil(retryDelayMs / 1000)}s`,
              },
            ],
          },
        }),
      );
    }
    accepted.push(now);
    log.push({ at: now, status: 200 });
    return Promise.resolve(
      json(200, {
        candidates: [
          { content: { role: 'model', parts: [{ text: '{"issues":[]}' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, log };
}

const request = {
  model: 'gemini-3.8-flash',
  instructions: 'consignes',
  input: '<document>texte</document>',
  schema: localReviewSchema,
  schemaName: 'local_review',
  maxOutputTokens: 1000,
};

/** Analyse simulée : CHUNKS morceaux, CONCURRENCY à la fois, derrière le coupe-circuit. */
async function analyzeChunks(options: { quota: number; requestsPerMinute: number | null }) {
  const google = simulatedGemini(options.quota);
  const warnings: Record<string, unknown>[] = [];
  const provider = new GeminiAiProvider({
    apiKey: 'cle-de-test',
    timeoutMs: 600_000,
    maxRetries: 3,
    thinkingLevel: ThinkingLevel.LOW,
    fetch: google.fetchImpl,
    rateLimiter: new RequestRateLimiter({ requestsPerMinute: options.requestsPerMinute }),
  });
  const ai = guardAi(provider, {
    analysisId: 'ana_test',
    logger: {
      warn: (data: unknown) => warnings.push(data as Record<string, unknown>),
      error: () => {},
    },
  });
  const outcomes: string[] = [];
  const run = forEachConcurrent(
    Array.from({ length: CHUNKS }, (_, i) => i),
    CONCURRENCY,
    async (index) => {
      try {
        await ai.generateStructured(request);
        outcomes[index] = 'ok';
      } catch (error) {
        outcomes[index] = error instanceof AiError ? error.kind : 'unexpected';
      }
    },
  );
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await run;
  return { outcomes, log: google.log, breakerTripped: warnings.length > 0 };
}

describe('Gemini : quota de 5 requêtes/minute, morceaux en parallèle', () => {
  it('limiteur à 5/min : aucun 429, tous les morceaux aboutissent, coupe-circuit intact', async () => {
    const result = await analyzeChunks({ quota: 5, requestsPerMinute: 5 });
    expect(result.outcomes).toEqual(Array(CHUNKS).fill('ok'));
    expect(result.log.filter((r) => r.status === 429)).toEqual([]);
    expect(result.log).toHaveLength(CHUNKS); // une requête par morceau, aucun nouvel essai
    expect(result.breakerTripped).toBe(false);
    // 12 requêtes espacées de 12 s : environ 2 min 12 s pour l'étape.
    expect(result.log.at(-1)!.at).toBe((CHUNKS - 1) * 12_000);
    // Jamais plus de 5 requêtes dans une fenêtre de 60 s, malgré 4 appels simultanés.
    for (const { at } of result.log) {
      expect(result.log.filter((r) => r.at >= at && r.at < at + 60_000).length).toBeLessThanOrEqual(
        5,
      );
    }
  });

  it('quota réel plus bas que prévu (3/min) : 429 absorbés par la pause commune, sans coupe-circuit', async () => {
    const result = await analyzeChunks({ quota: 3, requestsPerMinute: 5 });
    expect(result.outcomes).toEqual(Array(CHUNKS).fill('ok'));
    const refused = result.log.filter((r) => r.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    expect(result.breakerTripped).toBe(false);
    // Après chaque 429, plus aucune requête ne part avant la fin du délai indiqué.
    for (const refusal of refused) {
      const during = result.log.filter(
        (r) => r.at > refusal.at && r.at < refusal.at + refusal.retryDelayMs!,
      );
      expect(during).toEqual([]);
    }
  });

  it('sans espacement (comportement antérieur) : rafale de 429 dès le départ', async () => {
    // Même avec la pause commune, partir à 4 en même temps et réessayer à plusieurs
    // fait refuser des requêtes : l'espacement est ce qui évite les 429.
    const result = await analyzeChunks({ quota: 5, requestsPerMinute: null });
    expect(result.log.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });

  it('quota épuisé en continu : coupe-circuit après 3 échecs, puis plus aucune requête (repli sans IA)', async () => {
    const result = await analyzeChunks({ quota: 0, requestsPerMinute: 5 });
    expect(result.outcomes.every((o) => o === 'unavailable')).toBe(true);
    expect(result.breakerTripped).toBe(true);
    // Au plus : 3 morceaux en échec (+ ceux déjà partis en parallèle), 4 essais chacun.
    expect(result.log.length).toBeLessThanOrEqual((3 + CONCURRENCY - 1) * 4);
    expect(result.log.length).toBeLessThan(CHUNKS * 4);
  });
});
