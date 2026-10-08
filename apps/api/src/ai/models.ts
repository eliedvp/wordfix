import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

/**
 * Modèles à utiliser selon le fournisseur choisi : les noms de modèles OpenAI
 * (AI_MODEL_*) n'ont pas de sens pour Gemini, qui a ses propres variables.
 */
export function aiModels(config: ConfigService<Env, true>): { fast: string; smart: string } {
  if (config.get('AI_PROVIDER', { infer: true }) === 'gemini') {
    return {
      fast: config.get('GEMINI_MODEL_FAST', { infer: true }),
      smart: config.get('GEMINI_MODEL_SMART', { infer: true }),
    };
  }
  return {
    fast: config.get('AI_MODEL_FAST', { infer: true }),
    smart: config.get('AI_MODEL_SMART', { infer: true }),
  };
}
