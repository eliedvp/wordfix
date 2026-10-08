import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Variables d'environnement des tests d'intégration.
 * La base de test est distincte de la base de développement et entièrement
 * recréée à chaque lancement : ne jamais pointer TEST_DATABASE_URL vers une
 * base contenant des données utiles.
 *
 * Ordre de priorité pour la base de test :
 * 1. TEST_DATABASE_URL (environnement, puis fichier .env racine) ;
 * 2. sinon wordfix_test sur le port POSTGRES_PORT (environnement, puis .env),
 *    le même que docker-compose ;
 * 3. sinon le port PostgreSQL par défaut du projet, 5432.
 * Seules ces deux variables sont lues dans .env : le reste du fichier est ignoré.
 */
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

type Vars = Partial<Record<'TEST_DATABASE_URL' | 'POSTGRES_PORT', string>>;

export function resolveTestDatabaseUrl(env: Vars, dotenv: Vars): string {
  const explicit = env.TEST_DATABASE_URL || dotenv.TEST_DATABASE_URL;
  if (explicit) return explicit;
  const port = env.POSTGRES_PORT || dotenv.POSTGRES_PORT || '5432';
  return `postgresql://wordfix:wordfix_dev_password@127.0.0.1:${port}/wordfix_test?schema=public`;
}

function readRootEnv(): Vars {
  if (!existsSync(ROOT_ENV_FILE)) return {};
  const parsed = parseEnv(readFileSync(ROOT_ENV_FILE, 'utf8'));
  return { TEST_DATABASE_URL: parsed.TEST_DATABASE_URL, POSTGRES_PORT: parsed.POSTGRES_PORT };
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl(process.env, readRootEnv());

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
