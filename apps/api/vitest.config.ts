import { defineConfig } from 'vitest/config';

/**
 * Deux projets de tests :
 * - unit : tests rapides, sans base ni Redis (src/**\/*.spec.ts) ;
 * - integration : API complète contre PostgreSQL et Redis réels (test/**\/*.e2e-spec.ts).
 *   Base dédiée, recréée à chaque lancement (voir test/global-setup.ts).
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
