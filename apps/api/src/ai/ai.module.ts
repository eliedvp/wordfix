import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { AiModeController } from './ai-mode.controller.js';
import { AI_PROVIDER, type AiProvider } from './ai-provider.js';
import { DisabledAiProvider } from './providers/disabled.provider.js';
import { AiUsageService } from './usage.service.js';

/**
 * Crée le fournisseur IA du worker.
 * - « none » : aucun SDK chargé, aucune instance de fournisseur payant, aucun appel réseau.
 * - « openai » / « gemini » : seulement si les appels payants sont explicitement autorisés
 *   et le budget quotidien strictement positif (vérifié par la configuration, et de nouveau
 *   ici). Les SDK ne sont chargés que dans ce cas.
 * - « fake » : tests automatisés (la configuration le refuse hors NODE_ENV=test).
 */
export async function createAiProvider(
  config: ConfigService<Env, true>,
  logger: Pick<Logger, 'log'> = new Logger('AiModule'),
): Promise<AiProvider> {
  const provider = config.get('AI_PROVIDER', { infer: true });
  if (provider === 'none') {
    logger.log('Mode IA : aucun (analyse locale uniquement, aucun appel IA)');
    return new DisabledAiProvider();
  }
  if (provider === 'fake') {
    const { FakeAiProvider } = await import('./providers/fake.provider.js');
    logger.log('Mode IA : fake (tests automatisés uniquement)');
    return new FakeAiProvider();
  }

  const budget = config.get('AI_DAILY_TOKEN_BUDGET', { infer: true });
  if (!config.get('AI_PAID_CALLS_ENABLED', { infer: true }) || budget <= 0) {
    throw new Error(
      `AI_PROVIDER=${provider} exige AI_PAID_CALLS_ENABLED=true et AI_DAILY_TOKEN_BUDGET > 0 ; sinon, utilisez AI_PROVIDER=none.`,
    );
  }

  if (provider === 'gemini') {
    const geminiKey = config.get('GEMINI_API_KEY', { infer: true });
    if (!geminiKey) {
      throw new Error(
        'GEMINI_API_KEY est vide : renseignez votre clé dans le fichier .env pour utiliser AI_PROVIDER=gemini.',
      );
    }
    const [{ GeminiAiProvider, geminiThinkingLevel }, { RequestRateLimiter }] = await Promise.all([
      import('./providers/gemini.provider.js'),
      import('./rate-limiter.js'),
    ]);
    logger.log(`Mode IA : gemini (appels payants autorisés, budget quotidien ${budget} jetons)`);
    return new GeminiAiProvider({
      apiKey: geminiKey,
      timeoutMs: config.get('AI_TIMEOUT_MS', { infer: true }),
      maxRetries: config.get('AI_MAX_RETRIES', { infer: true }),
      thinkingLevel: geminiThinkingLevel(config.get('AI_REASONING_EFFORT', { infer: true })),
      // Un seul limiteur par processus : le fournisseur est un singleton du worker.
      rateLimiter: new RequestRateLimiter({
        requestsPerMinute: config.get('GEMINI_REQUESTS_PER_MINUTE', { infer: true }),
      }),
      logger: new Logger(GeminiAiProvider.name),
    });
  }

  const apiKey = config.get('OPENAI_API_KEY', { infer: true });
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY est vide : renseignez votre clé dans le fichier .env pour utiliser AI_PROVIDER=openai.',
    );
  }
  const { OpenAiProvider } = await import('./providers/openai.provider.js');
  const effort = config.get('AI_REASONING_EFFORT', { infer: true });
  logger.log(`Mode IA : openai (appels payants autorisés, budget quotidien ${budget} jetons)`);
  return new OpenAiProvider({
    apiKey,
    timeoutMs: config.get('AI_TIMEOUT_MS', { infer: true }),
    maxRetries: config.get('AI_MAX_RETRIES', { infer: true }),
    reasoningEffort: effort === 'none' ? null : effort,
  });
}

@Global()
@Module({
  providers: [
    AiUsageService,
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => createAiProvider(config),
    },
  ],
  exports: [AI_PROVIDER, AiUsageService],
})
export class AiModule {}

/** Module minimal pour l'API HTTP : suivi du budget et mode IA public, sans client IA. */
@Global()
@Module({
  controllers: [AiModeController],
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
