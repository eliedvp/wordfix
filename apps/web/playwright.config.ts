import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrl } from './e2e/database-url.mjs';

/**
 * Tests de bout en bout dans un vrai navigateur, sur le build de production :
 * site Next.js + API + worker (fournisseur IA de test) + PostgreSQL + Redis.
 * Ports et bases dédiés : ils ne touchent pas à l'environnement de développement.
 * Prérequis : `pnpm build`, PostgreSQL et Redis démarrés (`pnpm infra:up`).
 */
const WEB_PORT = 3100;
// Les réécritures /api/* de Next.js sont figées au moment du build (API_INTERNAL_URL,
// par défaut http://127.0.0.1:4000) : l'API de test écoute donc sur ce port.
const API_PORT = 4000;
// E2E_DATABASE_URL, sinon POSTGRES_PORT, sinon 5432 (voir e2e/database-url.mjs).
const DATABASE_URL = e2eDatabaseUrl();
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
/** Message du worker une fois prêt à consommer la file (apps/api/src/worker.ts). */
export const WORKER_READY = /Worker WordFix démarré/;

const backendEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL,
  REDIS_URL,
  API_PORT: String(API_PORT),
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  AI_PROVIDER: 'fake',
  // Budget explicite : 0 interdirait tout appel IA (même au faux fournisseur de test).
  AI_DAILY_TOKEN_BUDGET: '5000000',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: `${process.env.TMPDIR ?? '/tmp'}/wordfix-e2e-storage`,
  RATE_LIMIT_PER_MINUTE: '100000',
  QUOTA_ANALYSES_PER_HOUR: '1000',
  QUOTA_ANALYSES_PER_IP_PER_DAY: '1000',
  QUOTA_UPLOADS_PER_IP_PER_HOUR: '1000',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'fr-FR',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 900 },
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  // API et worker : deux processus distincts, lancés et arrêtés par Playwright lui-même
  // (arbre de processus tué en fin de run, y compris sous Windows). Aucune dépendance
  // à `sh` : chaque commande est un simple `node …`, valable dans PowerShell, cmd et sh.
  webServer: [
    {
      name: 'API',
      command: 'node dist/main.js',
      cwd: '../api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: backendEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: 'Worker',
      command: 'node dist/worker.js',
      cwd: '../api',
      // Le worker n'écoute sur aucun port : il est prêt quand il l'annonce dans ses logs.
      env: { ...backendEnv, LOG_LEVEL: 'info' },
      wait: { stdout: WORKER_READY },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
