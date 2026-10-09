import { ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { ambiguityResolutionSchema, localReviewSchema } from '../../engine/schemas.js';
import { AiError } from '../ai-provider.js';
import { RequestRateLimiter } from '../rate-limiter.js';
import {
  GeminiAiProvider,
  geminiThinkingLevel,
  toGeminiJsonSchema,
  type GeminiAiProviderOptions,
} from './gemini.provider.js';

/**
 * Le vrai SDK @google/genai est utilisé, mais son `fetch` est remplacé : aucun appel
 * réseau, aucune clé réelle. On vérifie à la fois la requête envoyée et la lecture
 * de la réponse.
 */
const TEST_KEY = 'cle-de-test-gemini';

interface Seen {
  url?: string;
  headers?: Headers;
  body?: Record<string, unknown>;
  calls: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(responses: (() => Response)[], seen: Seen = { calls: 0 }) {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const next = responses[Math.min(seen.calls, responses.length - 1)]!;
    seen.calls++;
    seen.url = url instanceof Request ? url.url : url.toString();
    seen.headers = new Headers(init?.headers);
    seen.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Promise.resolve(next());
  }) as typeof fetch;
}

const okResponse = (text: string, finishReason = 'STOP', extra: Record<string, unknown> = {}) =>
  json(200, {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 12,
      cachedContentTokenCount: 100,
      totalTokenCount: 162,
    },
    ...extra,
  });

const googleError = (code: number, status: string, message: string, details: unknown[] = []) =>
  json(code, { error: { code, message, status, details } });

const request = {
  model: 'gemini-test',
  instructions: 'consignes',
  input: '<document>texte</document>',
  schema: localReviewSchema,
  schemaName: 'local_review',
  maxOutputTokens: 1000,
};

/**
 * Limiteur sur une horloge simulée : chaque attente avance l'horloge et est notée.
 * Suffisant pour des appels successifs (la concurrence est testée avec les
 * minuteurs simulés de Vitest, dans gemini-rate-limit.spec.ts).
 */
function virtualLimiter(requestsPerMinute: number | null = null) {
  const clock = { now: 0, waits: [] as number[] };
  const limiter = new RequestRateLimiter({
    requestsPerMinute,
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      clock.waits.push(ms);
      return Promise.resolve();
    },
  });
  return { limiter, clock };
}

function provider(fetchImpl: typeof fetch, options: Partial<GeminiAiProviderOptions> = {}) {
  return new GeminiAiProvider({
    apiKey: TEST_KEY,
    timeoutMs: 5000,
    maxRetries: 0,
    thinkingLevel: ThinkingLevel.LOW,
    fetch: fetchImpl,
    rateLimiter: virtualLimiter().limiter,
    ...options,
  });
}

const errorOf = (promise: Promise<unknown>) => promise.catch((e: unknown) => e as AiError);

describe('GeminiAiProvider', () => {
  it('envoie une requête JSON contrainte par le schéma et valide la réponse', async () => {
    const seen: Seen = { calls: 0 };
    const result = await provider(
      fakeFetch([() => okResponse('{"issues":[]}')], seen),
    ).generateStructured(request);
    expect(result).toEqual({
      data: { issues: [] },
      // Sortie = texte + réflexion (facturée comme de la sortie).
      usage: { inputTokens: 120, outputTokens: 42, cachedTokens: 100 },
    });
    expect(seen.url).toContain('/models/gemini-test:generateContent');
    expect(seen.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: '<document>texte</document>' }] }],
      systemInstruction: { parts: [{ text: 'consignes' }] },
      generationConfig: {
        maxOutputTokens: 1000,
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiJsonSchema(localReviewSchema),
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    });
  });

  it('la clé ne passe que dans l’en-tête d’authentification (ni URL, ni corps)', async () => {
    const seen: Seen = { calls: 0 };
    await provider(fakeFetch([() => okResponse('{"issues":[]}')], seen)).generateStructured(
      request,
    );
    expect(seen.url).not.toContain(TEST_KEY);
    expect(JSON.stringify(seen.body)).not.toContain(TEST_KEY);
    expect(seen.headers?.get('x-goog-api-key')).toBe(TEST_KEY);
  });

  it('schéma de l’étape C : valeur facultative écrite avec un tableau de types', () => {
    const schema = toGeminiJsonSchema(ambiguityResolutionSchema) as {
      properties: {
        decisions: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    const item = schema.properties.decisions.items;
    expect(item.properties.correction).toEqual({ type: ['string', 'null'] });
    expect(item.properties.decision).toEqual({
      type: 'string',
      enum: ['correct', 'keep', 'verify'],
    });
    expect(item.required).toEqual([
      'caseId',
      'decision',
      'correction',
      'justification',
      'confidence',
    ]);
    expect(JSON.stringify(schema)).not.toContain('anyOf');
  });

  describe('réponses invalides → invalid_output', () => {
    it('hors schéma', async () => {
      const error = await errorOf(
        provider(fakeFetch([() => okResponse('{"issues":[{"oops":1}]}')])).generateStructured(
          request,
        ),
      );
      expect(error).toMatchObject({ kind: 'invalid_output' });
    });

    it('JSON illisible', async () => {
      const error = await errorOf(
        provider(fakeFetch([() => okResponse('pas du json')])).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'invalid_output', message: 'réponse JSON illisible' });
    });

    it('tronquée (limite de jetons)', async () => {
      const error = await errorOf(
        provider(fakeFetch([() => okResponse('{"iss', 'MAX_TOKENS')])).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'invalid_output' });
      expect((error as AiError).message).toContain('tronquée');
    });

    it('interrompue par un filtre du fournisseur', async () => {
      const error = await errorOf(
        provider(fakeFetch([() => okResponse('', 'SAFETY')])).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'invalid_output' });
    });

    it('requête bloquée (promptFeedback)', async () => {
      const blocked = () =>
        json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: {} });
      const error = await errorOf(provider(fakeFetch([blocked])).generateStructured(request));
      expect(error).toMatchObject({ kind: 'invalid_output' });
    });

    it('réponse vide', async () => {
      const empty = () =>
        json(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
      const error = await errorOf(provider(fakeFetch([empty])).generateStructured(request));
      expect(error).toMatchObject({ kind: 'invalid_output', message: 'réponse vide' });
    });
  });

  describe('erreurs du fournisseur', () => {
    it('clé refusée → config, sans nouvel essai, sans recopier la clé', async () => {
      const seen: Seen = { calls: 0 };
      const badKey = () =>
        googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ]);
      const error = await errorOf(
        provider(fakeFetch([badKey], seen), { maxRetries: 3 }).generateStructured(request),
      );
      expect(error).toBeInstanceOf(AiError);
      expect(error).toMatchObject({
        kind: 'config',
        message: 'clé refusée par le fournisseur (400)',
      });
      expect((error as AiError).retryable).toBe(false);
      expect((error as AiError).message).not.toContain(TEST_KEY);
      expect(seen.calls).toBe(1);
    });

    it.each([
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
    ])('%i → config (définitif, sans nouvel essai)', async (code, status) => {
      const seen: Seen = { calls: 0 };
      const error = await errorOf(
        provider(fakeFetch([() => googleError(code, status, 'refusé')], seen), {
          maxRetries: 3,
        }).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'config' });
      expect((error as AiError).retryable).toBe(false);
      expect(seen.calls).toBe(1);
    });

    it('400 compte ou région non autorisés (FAILED_PRECONDITION) → config', async () => {
      const error = await errorOf(
        provider(
          fakeFetch([
            () => googleError(400, 'FAILED_PRECONDITION', 'User location is not supported.'),
          ]),
        ).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'config' });
    });

    it('autre 400 (schéma ou paramètre refusé) → bad_request, distinct de config', async () => {
      const seen: Seen = { calls: 0 };
      const schemaRefused = () =>
        googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.', [
          { '@type': 'type.googleapis.com/google.rpc.BadRequest' },
        ]);
      const error = await errorOf(
        provider(fakeFetch([schemaRefused], seen), { maxRetries: 3 }).generateStructured(request),
      );
      expect(error).toBeInstanceOf(AiError);
      expect(error).toMatchObject({
        kind: 'bad_request',
        message: 'requête refusée par le fournisseur (400)',
      });
      expect((error as AiError).retryable).toBe(false);
      expect(seen.calls).toBe(1);
    });

    it('entrée trop volumineuse (413) → bad_request', async () => {
      const error = await errorOf(
        provider(
          fakeFetch([
            () => googleError(413, 'INVALID_ARGUMENT', 'Request payload size exceeds the limit'),
          ]),
        ).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'bad_request' });
    });

    it('quota quotidien épuisé (429) → quota, sans nouvel essai', async () => {
      const seen: Seen = { calls: 0 };
      const daily = () =>
        googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
        ]);
      const error = await errorOf(
        provider(fakeFetch([daily], seen), { maxRetries: 3 }).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'quota' });
      expect((error as AiError).retryable).toBe(false);
      expect(seen.calls).toBe(1);
    });

    const perMinute = () =>
      googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' },
      ]);

    const perMinuteAfter = (retryDelay?: string) => () =>
      googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
        },
        ...(retryDelay
          ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]
          : []),
      ]);

    it('limite de débit (429 par minute) → attend le délai indiqué puis réessaie', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter();
      const result = await provider(
        fakeFetch([perMinute, () => okResponse('{"issues":[]}')], seen),
        { maxRetries: 2, rateLimiter: limiter },
      ).generateStructured(request);
      expect(result.data).toEqual({ issues: [] });
      expect(seen.calls).toBe(2);
      expect(clock.waits).toEqual([3000]);
    });

    it('délai de l’offre gratuite (42 s, au-delà de l’ancien plafond de 30 s) → respecté puis nouvel essai', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter();
      const warn = vi.fn();
      const result = await provider(
        fakeFetch([perMinuteAfter('42.5s'), () => okResponse('{"issues":[]}')], seen),
        { maxRetries: 3, rateLimiter: limiter, logger: { warn } },
      ).generateStructured(request);
      expect(result.data).toEqual({ issues: [] });
      expect(seen.calls).toBe(2);
      expect(clock.waits).toEqual([42_500]);
      expect(warn).toHaveBeenCalledWith(
        { model: 'gemini-test', attempt: 1, waitMs: 42_500, retry: true },
        expect.stringContaining('429'),
      );
      // Le journal ne contient jamais la clé.
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_KEY);
    });

    it('sans délai indiqué → attente croissante (2 s, 4 s) puis succès', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter();
      const result = await provider(
        fakeFetch([perMinuteAfter(), perMinuteAfter(), () => okResponse('{"issues":[]}')], seen),
        { maxRetries: 3, rateLimiter: limiter },
      ).generateStructured(request);
      expect(result.data).toEqual({ issues: [] });
      expect(seen.calls).toBe(3);
      expect(clock.waits).toEqual([2_000, 4_000]);
    });

    it('délai trop long (> 90 s) → unavailable sans nouvel essai, mais pause commune posée', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter();
      const ai = provider(
        fakeFetch([perMinuteAfter('300s'), () => okResponse('{"issues":[]}')], seen),
        {
          maxRetries: 3,
          rateLimiter: limiter,
        },
      );
      const error = await errorOf(ai.generateStructured(request));
      expect(error).toMatchObject({ kind: 'unavailable' });
      expect(seen.calls).toBe(1);
      // L'appel suivant (autre morceau) attend la fin de la pause plafonnée à 90 s.
      await ai.generateStructured(request);
      expect(clock.waits).toEqual([90_000]);
      expect(seen.calls).toBe(2);
    });

    it('quota quotidien épuisé → aucune pause imposée aux autres appels', async () => {
      const { limiter, clock } = virtualLimiter();
      const daily = () =>
        googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
        ]);
      const error = await errorOf(
        provider(fakeFetch([daily]), { maxRetries: 3, rateLimiter: limiter }).generateStructured(
          request,
        ),
      );
      expect(error).toMatchObject({ kind: 'quota' });
      expect(clock.waits).toEqual([]);
    });

    it('chaque requête, nouvel essai compris, attend sa place dans le limiteur', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter(5);
      const ai = provider(fakeFetch([() => okResponse('{"issues":[]}')], seen), {
        rateLimiter: limiter,
      });
      await ai.generateStructured(request);
      await ai.generateStructured(request);
      await ai.generateStructured(request);
      expect(seen.calls).toBe(3);
      expect(clock.waits).toEqual([12_000, 12_000]);
    });

    it('limite de débit persistante → unavailable après maxRetries', async () => {
      const seen: Seen = { calls: 0 };
      const { limiter, clock } = virtualLimiter();
      const error = await errorOf(
        provider(fakeFetch([perMinute], seen), {
          maxRetries: 2,
          rateLimiter: limiter,
        }).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'unavailable' });
      expect((error as AiError).retryable).toBe(true);
      expect(seen.calls).toBe(3);
      expect(clock.waits).toEqual([3000, 3000]);
    });

    it('panne du fournisseur (503) → unavailable', async () => {
      const error = await errorOf(
        provider(
          fakeFetch([() => googleError(503, 'UNAVAILABLE', 'overloaded')]),
        ).generateStructured(request),
      );
      expect(error).toMatchObject({ kind: 'unavailable' });
      expect((error as AiError).retryable).toBe(true);
    });

    it('délai dépassé → unavailable', async () => {
      const hanging = ((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        })) as typeof fetch;
      const error = await errorOf(provider(hanging, { timeoutMs: 20 }).generateStructured(request));
      expect(error).toMatchObject({ kind: 'unavailable', message: 'délai de réponse dépassé' });
    });

    it('réseau coupé → unavailable', async () => {
      const offline = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
      const error = await errorOf(provider(offline).generateStructured(request));
      expect(error).toMatchObject({ kind: 'unavailable' });
    });
  });

  it('niveau de réflexion : AI_REASONING_EFFORT → thinkingLevel accepté par Gemini 3.x', () => {
    expect(geminiThinkingLevel('none')).toBe(ThinkingLevel.LOW);
    expect(geminiThinkingLevel('minimal')).toBe(ThinkingLevel.LOW);
    expect(geminiThinkingLevel('low')).toBe(ThinkingLevel.LOW);
    expect(geminiThinkingLevel('medium')).toBe(ThinkingLevel.MEDIUM);
    expect(geminiThinkingLevel('high')).toBe(ThinkingLevel.HIGH);
  });
});
