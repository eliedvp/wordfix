/**
 * Configuration de la CLI Prisma (Prisma 7).
 *
 * L'URL de la base est lue dans le fichier .env unique à la racine du monorepo.
 * Elle n'est nécessaire que pour les commandes qui contactent la base
 * (migrate, db execute) ; `prisma generate` et `prisma validate` fonctionnent sans.
 */
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
