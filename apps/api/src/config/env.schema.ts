import { z } from 'zod';

/**
 * Schéma des variables d'environnement de l'API.
 *
 * L'application refuse de démarrer si une variable obligatoire manque ou est
 * invalide : mieux vaut une erreur claire au démarrage qu'une panne au premier
 * upload. Les variables des étapes suivantes (stockage S3, OpenAI) sont
 * facultatives tant que les modules qui les utilisent n'existent pas.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Serveur HTTP. Par défaut l'API n'écoute qu'en local : le navigateur passe
  // toujours par le site Next.js (décision D4).
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Infrastructure (obligatoire dès maintenant).
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'doit commencer par postgresql://'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'doit commencer par redis://'),

  // Stockage des fichiers (utilisé à partir de l'étape 6).
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default('./storage'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),

  // IA (utilisée à partir de l'étape 10). Ne jamais committer de vraie clé.
  OPENAI_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Valide les variables d'environnement ; lève une erreur lisible sinon. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new Error(
      `Configuration invalide : corrigez votre fichier .env (voir .env.example).\n${details}`,
    );
  }
  return parsed.data;
}
