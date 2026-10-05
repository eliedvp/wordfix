import { defineConfig, devices } from '@playwright/test';

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
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://wordfix:wordfix_dev_password@127.0.0.1:5432/wordfix_e2e?schema=public';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14';

const backendEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL,
  REDIS_URL,
  API_PORT: String(API_PORT),
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  AI_PROVIDER: 'fake',
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
  webServer: [
    {
      // API et worker démarrent ensemble ; ils sont arrêtés ensemble à la fin.
      command: 'sh -c "node dist/worker.js & exec node dist/main.js"',
      cwd: '../api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: backendEnv,
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
