import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envSchema, type Env } from '../config/env.schema.js';
import { AiError } from './ai-provider.js';
import { createAiProvider } from './ai.module.js';

/**
 * Fabrique du fournisseur IA du worker. Les modules des fournisseurs payants sont
 * remplacés par des doubles qui notent leur chargement et leurs instances : on vérifie
 * ainsi qu'en mode sans IA, aucun SDK n'est chargé et aucun fournisseur payant n'est créé.
 */
const loaded = vi.hoisted(() => ({
  openaiModule: 0,
  geminiModule: 0,
  openaiInstances: 0,
  geminiInstances: 0,
}));

vi.mock('./providers/openai.provider.js', () => {
  loaded.openaiModule++;
  return {
    OpenAiProvider: class {
      readonly name = 'openai';
      constructor() {
        loaded.openaiInstances++;
      }
    },
  };
});
vi.mock('./providers/gemini.provider.js', () => {
  loaded.geminiModule++;
  return {
    GeminiAiProvider: class {
      readonly name = 'gemini';
      constructor() {
        loaded.geminiInstances++;
      }
    },
    geminiThinkingLevel: () => 'LOW',
  };
});

function configOf(vars: Record<string, string>): ConfigService<Env, true> {
  const env = envSchema.parse({
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://test',
    ...vars,
  });
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

/** Configuration volontairement incohérente (contourne le schéma) pour tester la 2e barrière. */
function rawConfig(values: Partial<Record<keyof Env, unknown>>): ConfigService<Env, true> {
  return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>;
}

const silent = { log: () => {} };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Fournisseur IA du worker', () => {
  it('mode sans IA (par défaut) : aucun SDK chargé, aucun fournisseur payant, aucun appel réseau', async () => {
    const logs: string[] = [];
    const provider = await createAiProvider(configOf({}), { log: (m: string) => logs.push(m) });

    expect(provider.name).toBe('none');
    expect(loaded).toEqual({
      openaiModule: 0,
      geminiModule: 0,
      openaiInstances: 0,
      geminiInstances: 0,
    });
    // S'il était appelé malgré tout, il refuse sans rien envoyer.
    await expect(provider.generateStructured({} as never)).rejects.toMatchObject({
      kind: 'config',
    });
    await expect(provider.generateStructured({} as never)).rejects.toBeInstanceOf(AiError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs).toEqual(['Mode IA : aucun (analyse locale uniquement, aucun appel IA)']);
  });

  it('openai avec activation explicite et budget positif : seul OpenAI est créé', async () => {
    const provider = await createAiProvider(
      configOf({
        AI_PROVIDER: 'openai',
        AI_PAID_CALLS_ENABLED: 'true',
        AI_DAILY_TOKEN_BUDGET: '1000',
        OPENAI_API_KEY: 'cle-de-test',
      }),
      silent,
    );
    expect(provider.name).toBe('openai');
    expect(loaded.openaiInstances).toBe(1);
    expect(loaded.geminiModule).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('seconde barrière : appels payants non autorisés ou budget 0 → aucun fournisseur créé', async () => {
    const before = { ...loaded };
    for (const values of [
      { AI_PROVIDER: 'openai', AI_PAID_CALLS_ENABLED: false, AI_DAILY_TOKEN_BUDGET: 1000 },
      { AI_PROVIDER: 'gemini', AI_PAID_CALLS_ENABLED: true, AI_DAILY_TOKEN_BUDGET: 0 },
    ] as const) {
      await expect(createAiProvider(rawConfig(values), silent)).rejects.toThrow(
        /AI_PAID_CALLS_ENABLED=true et AI_DAILY_TOKEN_BUDGET > 0/,
      );
    }
    expect(loaded.openaiInstances).toBe(before.openaiInstances);
    expect(loaded.geminiInstances).toBe(before.geminiInstances);
  });

  it('mode payant autorisé mais clé absente : refusé, sans recopier de secret', async () => {
    await expect(
      createAiProvider(
        configOf({
          AI_PROVIDER: 'gemini',
          AI_PAID_CALLS_ENABLED: 'true',
          AI_DAILY_TOKEN_BUDGET: '1000',
        }),
        silent,
      ),
    ).rejects.toThrow(/GEMINI_API_KEY est vide/);
  });
});
