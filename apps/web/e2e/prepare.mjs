// Prépare la base et le Redis dédiés aux tests E2E, AVANT le démarrage des
// serveurs (l'API vérifie la base dès son démarrage).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';

const MIGRATIONS = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
const url = new URL(
  process.env.E2E_DATABASE_URL ??
    'postgresql://wordfix:wordfix_dev_password@127.0.0.1:5432/wordfix_e2e?schema=public',
);
const database = url.pathname.slice(1);
if (!database.endsWith('_e2e')) throw new Error('La base E2E doit se terminer par « _e2e ».');
url.searchParams.delete('schema');

const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
await admin.end();

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const name of migrations) {
  await client.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, 'utf8'));
}
await client.end();

const redis = new Redis(process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14');
await redis.flushdb();
redis.disconnect();
console.log(`Base ${database} et Redis E2E prêts.`);
