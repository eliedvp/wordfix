// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import config, { WORKER_READY } from '../playwright.config';

/**
 * Serveurs des tests E2E : API et worker démarrés par Playwright, sans shell POSIX,
 * pour que `pnpm test:e2e` fonctionne aussi bien sous Windows que sous Linux/CI.
 */
type WebServers = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;
const servers = config.webServer as WebServers;
const byName = (name: string) => servers.find((server) => server.name === name);

describe('Configuration Playwright (serveurs E2E multiplateformes)', () => {
  it('aucune commande ne dépend de sh ni d’une syntaxe propre à un shell', () => {
    for (const { command } of servers) {
      // Ni `sh -c`/`bash -c`, ni `&`, `;`, `|` (absents ou différents sous cmd/PowerShell).
      expect(command).not.toMatch(/(^|\s)(sh|bash)\s|&|;|\|/);
    }
  });

  it('API et worker sont deux serveurs distincts, avec la même configuration', () => {
    const api = byName('API');
    const worker = byName('Worker');
    expect(api).toMatchObject({ command: 'node dist/main.js', cwd: '../api' });
    expect(api?.url).toMatch(/\/api\/health$/);
    expect(worker).toMatchObject({ command: 'node dist/worker.js', cwd: '../api' });
    // Même environnement, à part le niveau de logs du worker.
    expect({ ...worker?.env, LOG_LEVEL: '-' }).toEqual({ ...api?.env, LOG_LEVEL: '-' });
    expect(worker?.env).toMatchObject({ NODE_ENV: 'test', AI_PROVIDER: 'fake' });
    // Le worker doit journaliser son démarrage pour que Playwright le détecte.
    expect(worker?.env?.LOG_LEVEL).toBe('info');
  });

  it('le worker est attendu sur le message réellement écrit par apps/api/src/worker.ts', () => {
    const worker = byName('Worker');
    expect(worker?.wait?.stdout).toBe(WORKER_READY);
    const source = readFileSync(new URL('../../api/src/worker.ts', import.meta.url), 'utf8');
    expect(source).toMatch(WORKER_READY);
  });
});
