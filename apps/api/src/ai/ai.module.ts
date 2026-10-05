import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { AI_PROVIDER, type AiProvider } from './ai-provider.js';
import { FakeAiProvider } from './providers/fake.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { AiUsageService } from './usage.service.js';

@Global()
@Module({
  providers: [
    AiUsageService,
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AiProvider => {
        if (config.get('AI_PROVIDER', { infer: true }) === 'fake') return new FakeAiProvider();
        const apiKey = config.get('OPENAI_API_KEY', { infer: true });
        if (!apiKey) {
          throw new Error(
            'OPENAI_API_KEY est vide : renseignez votre clé dans le fichier .env pour lancer le worker.',
          );
        }
        const effort = config.get('AI_REASONING_EFFORT', { infer: true });
        return new OpenAiProvider({
          apiKey,
          timeoutMs: config.get('AI_TIMEOUT_MS', { infer: true }),
          maxRetries: config.get('AI_MAX_RETRIES', { infer: true }),
          reasoningEffort: effort === 'none' ? null : effort,
        });
      },
    },
  ],
  exports: [AI_PROVIDER, AiUsageService],
})
export class AiModule {}

/** Module minimal pour l'API HTTP : suivi du budget, sans client IA. */
@Global()
@Module({ providers: [AiUsageService], exports: [AiUsageService] })
export class AiUsageModule {}
