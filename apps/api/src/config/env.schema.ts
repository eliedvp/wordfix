import { z } from 'zod';

/**
 * Schéma des variables d'environnement de l'API.
 *
 * L'application refuse de démarrer si une variable obligatoire manque ou est
 * invalide : mieux vaut une erreur claire au démarrage qu'une panne au premier
 * upload. Les variables des étapes suivantes (stockage S3, OpenAI) sont
 * facultatives tant que les modules qui les utilisent n'existent pas.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Serveur HTTP. Par défaut l'API n'écoute qu'en local : le navigateur passe
    // toujours par le site Next.js (décision D4).
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    /**
     * Mandataires de confiance pour déterminer l'adresse IP réelle (en-tête
     * X-Forwarded-For) : « loopback » quand seul Next.js (local) relaie les requêtes.
     */
    TRUST_PROXY: z.string().min(1).default('loopback'),

    // Limites d'usage (décision D8).
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    QUOTA_ANALYSES_PER_HOUR: z.coerce.number().int().min(1).default(3),
    QUOTA_ANALYSES_PER_IP_PER_DAY: z.coerce.number().int().min(1).default(10),
    QUOTA_UPLOADS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(20),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

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

    // IA. Ne jamais committer de vraie clé.
    AI_PROVIDER: z.enum(['openai', 'gemini', 'fake']).default('openai'),
    OPENAI_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    AI_MODEL_FAST: z.string().min(1).default('gpt-5.4-mini'),
    AI_MODEL_SMART: z.string().min(1).default('gpt-5.4'),
    GEMINI_MODEL_FAST: z.string().min(1).default('gemini-3.8-flash'),
    GEMINI_MODEL_SMART: z.string().min(1).default('gemini-3.8-flash'),
    AI_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(120_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
    /** Appels IA simultanés au plus pour une même analyse. */
    AI_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    /** Plafond quotidien de jetons (entrée + sortie), tous utilisateurs confondus. */
    AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(5_000_000),

    // Worker d'analyse.
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

    // Vérification grammaticale (worker) : Grammalecte, exécuté localement par Python 3.
    GRAMMAR_ENGINE: z.enum(['grammalecte', 'off']).default('grammalecte'),
    GRAMMALECTE_PYTHON: z
      .string()
      .min(1)
      .default(process.platform === 'win32' ? 'python' : 'python3'),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'fake' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message: '« fake » est réservé aux tests automatisés (NODE_ENV=test)',
      });
    }
    // La politique de confidentialité (page /confidentialite) ne mentionne qu'OpenAI, et
    // l'offre gratuite de l'API Gemini autorise Google à réutiliser les contenus envoyés :
    // Gemini reste réservé au développement et aux tests tant qu'elle n'est pas adaptée.
    if (env.AI_PROVIDER === 'gemini' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message:
          '« gemini » est réservé au développement et aux tests tant que la politique de confidentialité ne le mentionne pas',
      });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of [
        'STORAGE_ENDPOINT',
        'STORAGE_ACCESS_KEY',
        'STORAGE_SECRET_KEY',
        'STORAGE_BUCKET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'obligatoire avec STORAGE_DRIVER=s3',
          });
        }
      }
    }
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
