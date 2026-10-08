// Base PostgreSQL des tests E2E, partagée par prepare.mjs et playwright.config.ts.
// Même logique que les tests d'intégration de l'API (apps/api/test/test-env.ts) :
// 1. E2E_DATABASE_URL (environnement, puis fichier .env racine) ;
// 2. sinon wordfix_e2e sur le port POSTGRES_PORT (environnement, puis .env),
//    le même que docker-compose ;
// 3. sinon le port PostgreSQL par défaut du projet, 5432.
// Seules ces deux variables sont lues dans .env : le reste du fichier est ignoré.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

export function resolveE2eDatabaseUrl(env, dotenv) {
  const explicit = env.E2E_DATABASE_URL || dotenv.E2E_DATABASE_URL;
  if (explicit) return explicit;
  const port = env.POSTGRES_PORT || dotenv.POSTGRES_PORT || '5432';
  return `postgresql://wordfix:wordfix_dev_password@127.0.0.1:${port}/wordfix_e2e?schema=public`;
}

export function readRootEnv(file = ROOT_ENV_FILE) {
  if (!existsSync(file)) return {};
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  return { E2E_DATABASE_URL: parsed.E2E_DATABASE_URL, POSTGRES_PORT: parsed.POSTGRES_PORT };
}

export function e2eDatabaseUrl() {
  return resolveE2eDatabaseUrl(process.env, readRootEnv());
}
