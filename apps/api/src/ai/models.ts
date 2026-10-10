import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

/** Vrai si une IA est configurée (fournisseur payant autorisé, ou faux fournisseur de test). */
export function aiEnabled(config: ConfigService<Env, true>): boolean {
  return config.get('AI_PROVIDER', { infer: true }) !== 'none';
}

/**
 * Modèles à utiliser selon le fournisseur choisi : les noms de modèles OpenAI
 * (AI_MODEL_*) n'ont pas de sens pour Gemini, qui a ses propres variables.
 * null en mode sans IA (AI_PROVIDER=none) : aucun modèle n'est utilisé.
 */
export function aiModels(config: ConfigService<Env, true>): { fast: string; smart: string } | null {
  const provider = config.get('AI_PROVIDER', { infer: true });
  if (provider === 'none') return null;
  if (provider === 'gemini') {
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
