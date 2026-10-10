import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { envSchema, type Env } from '../config/env.schema.js';
import { aiEnabled, aiModels } from './models.js';

/** Configuration validée par le vrai schéma, sans secret réel. */
function configOf(vars: Record<string, string>): ConfigService<Env, true> {
  const env = envSchema.parse({
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://test',
    ...vars,
  });
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

const PAID = { AI_PAID_CALLS_ENABLED: 'true', AI_DAILY_TOKEN_BUDGET: '1000' };

describe('Choix du fournisseur et des modèles', () => {
  it('sans IA par défaut : aucun modèle', () => {
    const config = configOf({});
    expect(aiEnabled(config)).toBe(false);
    expect(aiModels(config)).toBeNull();
  });

  it('AI_PROVIDER=openai (activation explicite) : modèles AI_MODEL_*', () => {
    const config = configOf({ AI_PROVIDER: 'openai', ...PAID });
    expect(aiEnabled(config)).toBe(true);
    expect(aiModels(config)).toEqual({ fast: 'gpt-5.4-mini', smart: 'gpt-5.4' });
  });

  it('AI_PROVIDER=gemini : modèles GEMINI_MODEL_* (gemini-3.8-flash par défaut)', () => {
    expect(aiModels(configOf({ AI_PROVIDER: 'gemini', ...PAID }))).toEqual({
      fast: 'gemini-3.8-flash',
      smart: 'gemini-3.8-flash',
    });
    expect(
      aiModels(
        configOf({ AI_PROVIDER: 'gemini', ...PAID, GEMINI_MODEL_FAST: 'gemini-3.5-flash-lite' }),
      )?.fast,
    ).toBe('gemini-3.5-flash-lite');
  });

  it('le faux fournisseur reste disponible en test ; une valeur inconnue est refusée', () => {
    expect(
      configOf({ AI_PROVIDER: 'fake', NODE_ENV: 'test' }).get('AI_PROVIDER', { infer: true }),
    ).toBe('fake');
    expect(() => configOf({ AI_PROVIDER: 'mistral' })).toThrow();
  });
});
