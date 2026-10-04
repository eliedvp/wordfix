import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

/**
 * Recrée le schéma de la base de test puis applique les migrations SQL dans
 * l'ordre, exactement comme `prisma migrate deploy` le ferait.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  if (!url.pathname.endsWith('_test')) {
    throw new Error(`Refus : la base de test doit se terminer par "_test" (${url.pathname}).`);
  }
  url.searchParams.delete('schema');

  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of migrations) {
      await client.query(readFileSync(`${MIGRATIONS_DIR}${name}/migration.sql`, 'utf8'));
    }
  } finally {
    await client.end();
  }

  // Base Redis dédiée aux tests (n° 15 par défaut), vidée à chaque lancement.
  const redis = new Redis(TEST_REDIS_URL);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
