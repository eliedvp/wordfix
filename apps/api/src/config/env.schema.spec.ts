import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('validateEnv', () => {
  it('applique les valeurs par défaut sûres', () => {
    const env = validateEnv(base);
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('refuse une configuration invalide en nommant les variables', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://x', REDIS_URL: '' })).toThrowError(
      /DATABASE_URL[\s\S]*REDIS_URL/,
    );
  });

  it('convertit le port en nombre', () => {
    expect(validateEnv({ ...base, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  describe('IA : aucun appel payant par défaut', () => {
    it('par défaut : sans IA, appels payants non autorisés, budget 0 (aucun appel)', () => {
      const env = validateEnv(base);
      expect(env.AI_PROVIDER).toBe('none');
      expect(env.AI_PAID_CALLS_ENABLED).toBe(false);
      expect(env.AI_DAILY_TOKEN_BUDGET).toBe(0);
    });

    it.each(['development', 'test', 'production'] as const)(
      'le mode sans IA démarre sans aucune clé (%s)',
      (NODE_ENV) => {
        const env = validateEnv({ ...base, NODE_ENV, AI_PROVIDER: 'none' });
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.GEMINI_API_KEY).toBeUndefined();
      },
    );

    it.each(['openai', 'gemini'] as const)(
      '%s sans autorisation explicite des appels payants : refusé',
      (AI_PROVIDER) => {
        expect(() =>
          validateEnv({ ...base, AI_PROVIDER, AI_DAILY_TOKEN_BUDGET: '1000' }),
        ).toThrowError(/AI_PAID_CALLS_ENABLED/);
      },
    );

    it.each(['openai', 'gemini'] as const)(
      '%s autorisé mais budget 0 : refusé (0 n’est jamais illimité)',
      (AI_PROVIDER) => {
        expect(() =>
          validateEnv({ ...base, AI_PROVIDER, AI_PAID_CALLS_ENABLED: 'true' }),
        ).toThrowError(/AI_DAILY_TOKEN_BUDGET/);
      },
    );

    it('autorisation acceptée seulement avec la valeur exacte « true »', () => {
      expect(() =>
        validateEnv({
          ...base,
          AI_PROVIDER: 'openai',
          AI_PAID_CALLS_ENABLED: 'yes',
          AI_DAILY_TOKEN_BUDGET: '1000',
        }),
      ).toThrowError(/AI_PAID_CALLS_ENABLED/);
    });
  });

  describe('fournisseur IA selon l’environnement', () => {
    const paid = { AI_PAID_CALLS_ENABLED: 'true', AI_DAILY_TOKEN_BUDGET: '1000' };

    it.each(['development', 'test'] as const)(
      'Gemini est accepté en %s (activation explicite)',
      (NODE_ENV) => {
        expect(validateEnv({ ...base, ...paid, NODE_ENV, AI_PROVIDER: 'gemini' }).AI_PROVIDER).toBe(
          'gemini',
        );
      },
    );

    it('Gemini est refusé en production (confidentialité)', () => {
      expect(() =>
        validateEnv({ ...base, ...paid, NODE_ENV: 'production', AI_PROVIDER: 'gemini' }),
      ).toThrowError(/AI_PROVIDER[\s\S]*confidentialité/);
    });

    it.each(['development', 'production'] as const)(
      'le faux fournisseur est refusé hors tests (%s) : ce n’est pas une vraie correction',
      (NODE_ENV) => {
        expect(() => validateEnv({ ...base, NODE_ENV, AI_PROVIDER: 'fake' })).toThrowError(
          /AI_PROVIDER[\s\S]*tests automatisés/,
        );
      },
    );

    it('le faux fournisseur est accepté en test', () => {
      expect(validateEnv({ ...base, NODE_ENV: 'test', AI_PROVIDER: 'fake' }).AI_PROVIDER).toBe(
        'fake',
      );
    });

    it('OpenAI reste accepté en production (activation explicite)', () => {
      expect(
        validateEnv({ ...base, ...paid, NODE_ENV: 'production', AI_PROVIDER: 'openai' })
          .AI_PROVIDER,
      ).toBe('openai');
    });

    it('les messages d’erreur ne recopient jamais une clé', () => {
      const secret = 'cle-secrete-de-test-123';
      let message = '';
      try {
        validateEnv({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: secret });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/AI_PAID_CALLS_ENABLED/);
      expect(message).not.toContain(secret);
    });
  });
});
