import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from './test-env.js';

/** Base des tests d'intégration : configurable, jamais un port propre à une machine. */
describe('Base de données des tests d’intégration', () => {
  const at = (port: string) =>
    `postgresql://wordfix:wordfix_dev_password@127.0.0.1:${port}/wordfix_test?schema=public`;

  it('par défaut : port 5432, comme docker-compose', () => {
    expect(resolveTestDatabaseUrl({}, {})).toBe(at('5432'));
  });

  it('suit POSTGRES_PORT (environnement prioritaire sur .env)', () => {
    expect(resolveTestDatabaseUrl({}, { POSTGRES_PORT: '5433' })).toBe(at('5433'));
    expect(resolveTestDatabaseUrl({ POSTGRES_PORT: '5434' }, { POSTGRES_PORT: '5433' })).toBe(
      at('5434'),
    );
  });

  it('TEST_DATABASE_URL l’emporte (environnement, puis .env)', () => {
    const custom = 'postgresql://u:p@db:6543/autre_test';
    expect(resolveTestDatabaseUrl({}, { TEST_DATABASE_URL: custom, POSTGRES_PORT: '5433' })).toBe(
      custom,
    );
    expect(
      resolveTestDatabaseUrl(
        { TEST_DATABASE_URL: 'postgresql://env/x_test' },
        { TEST_DATABASE_URL: custom },
      ),
    ).toBe('postgresql://env/x_test');
  });
});
