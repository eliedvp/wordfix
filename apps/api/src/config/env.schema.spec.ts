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
});
