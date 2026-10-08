// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRootEnv, resolveE2eDatabaseUrl } from '../e2e/database-url.mjs';

/** Base des tests E2E : même résolution que les tests d'intégration de l'API. */
describe('Base de données des tests E2E', () => {
  const at = (port: string) =>
    `postgresql://wordfix:wordfix_dev_password@127.0.0.1:${port}/wordfix_e2e?schema=public`;

  it('par défaut : port 5432, comme docker-compose', () => {
    expect(resolveE2eDatabaseUrl({}, {})).toBe(at('5432'));
  });

  it('suit POSTGRES_PORT (environnement prioritaire sur .env)', () => {
    expect(resolveE2eDatabaseUrl({}, { POSTGRES_PORT: '5433' })).toBe(at('5433'));
    expect(resolveE2eDatabaseUrl({ POSTGRES_PORT: '5434' }, { POSTGRES_PORT: '5433' })).toBe(
      at('5434'),
    );
  });

  it('E2E_DATABASE_URL l’emporte (environnement, puis .env) — cas de la CI', () => {
    const ci = 'postgresql://wordfix:ci_password@127.0.0.1:5432/wordfix_e2e?schema=public';
    expect(resolveE2eDatabaseUrl({ E2E_DATABASE_URL: ci, POSTGRES_PORT: '5433' }, {})).toBe(ci);
    expect(resolveE2eDatabaseUrl({}, { E2E_DATABASE_URL: ci, POSTGRES_PORT: '5433' })).toBe(ci);
  });

  it('ne lit que E2E_DATABASE_URL et POSTGRES_PORT dans .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordfix-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'POSTGRES_PORT=5433\nOPENAI_API_KEY=ne-doit-pas-sortir\n# commentaire\n');
    expect(readRootEnv(file)).toEqual({ E2E_DATABASE_URL: undefined, POSTGRES_PORT: '5433' });
    expect(readRootEnv(join(dir, 'absent.env'))).toEqual({});
  });
});
