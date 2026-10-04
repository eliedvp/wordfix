import { describe, expect, it } from 'vitest';
import { localReviewSchema } from '../../engine/schemas.js';
import { AiError } from '../ai-provider.js';
import { OpenAiProvider } from './openai.provider.js';

function fakeFetch(status: number, body: unknown, seen: { body?: Record<string, unknown> } = {}) {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    seen.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

const okResponse = (text: string, status = 'completed') => ({
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  status,
  model: 'gpt-test',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 100 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

const request = {
  model: 'gpt-test',
  instructions: 'consignes',
  input: '<document>texte</document>',
  schema: localReviewSchema,
  schemaName: 'local_review',
  maxOutputTokens: 1000,
};

function provider(fetchImpl: typeof fetch) {
  return new OpenAiProvider({
    apiKey: 'sk-test',
    timeoutMs: 5000,
    maxRetries: 0,
    reasoningEffort: 'low',
    fetch: fetchImpl,
  });
}

describe('OpenAiProvider', () => {
  it('envoie une requête stricte, sans stockage, et valide la réponse', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const result = await provider(
      fakeFetch(200, okResponse('{"issues":[]}'), seen),
    ).generateStructured(request);
    expect(result).toEqual({
      data: { issues: [] },
      usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 100 },
    });
    expect(seen.body).toMatchObject({
      model: 'gpt-test',
      store: false,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'local_review', strict: true } },
    });
  });

  it('rejette une réponse hors schéma', async () => {
    await expect(
      provider(fakeFetch(200, okResponse('{"issues":[{"oops":1}]}'))).generateStructured(request),
    ).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('rejette une réponse tronquée', async () => {
    await expect(
      provider(fakeFetch(200, okResponse('{"iss', 'incomplete'))).generateStructured(request),
    ).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('traduit une clé refusée en erreur de configuration (sans nouvel essai)', async () => {
    const error = await provider(fakeFetch(401, { error: { message: 'bad key' } }))
      .generateStructured(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe('config');
    expect((error as AiError).retryable).toBe(false);
  });

  it('traduit une panne du fournisseur en indisponibilité temporaire', async () => {
    await expect(
      provider(fakeFetch(503, { error: { message: 'overloaded' } })).generateStructured(request),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
