import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { envSchema, type Env } from '../config/env.schema.js';
import { aiModels } from './models.js';

/** Configuration validée par le vrai schéma, sans secret réel. */
function configOf(vars: Record<string, string>): ConfigService<Env, true> {
  const env = envSchema.parse({
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://test',
    ...vars,
  });
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

describe('Choix du fournisseur et des modèles', () => {
  it('OpenAI par défaut : modèles AI_MODEL_*', () => {
    expect(aiModels(configOf({}))).toEqual({ fast: 'gpt-5.4-mini', smart: 'gpt-5.4' });
  });

  it('AI_PROVIDER=gemini : modèles GEMINI_MODEL_* (gemini-3.8-flash par défaut)', () => {
    expect(aiModels(configOf({ AI_PROVIDER: 'gemini' }))).toEqual({
      fast: 'gemini-3.8-flash',
      smart: 'gemini-3.8-flash',
    });
    expect(
      aiModels(configOf({ AI_PROVIDER: 'gemini', GEMINI_MODEL_FAST: 'gemini-3.5-flash-lite' }))
        .fast,
    ).toBe('gemini-3.5-flash-lite');
  });

  it('le faux fournisseur reste disponible ; une valeur inconnue est refusée', () => {
    expect(configOf({ AI_PROVIDER: 'fake' }).get('AI_PROVIDER', { infer: true })).toBe('fake');
    expect(() => configOf({ AI_PROVIDER: 'mistral' })).toThrow();
  });
});
