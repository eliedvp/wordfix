import type { Logger } from '@nestjs/common';
import { AiError, type AiProvider } from '../ai/ai-provider.js';

/** Échecs temporaires consécutifs (429 par minute, 5xx, délai, réseau) avant coupure. */
export const AI_CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Fournisseur IA protégé, propre à une analyse. Le fournisseur garde ses propres
 * nouvelles tentatives (SDK, limite de débit) ; ce garde décide, au niveau de
 * l'analyse, quand il est inutile de continuer à appeler l'IA :
 * - erreur définitive (quota épuisé, clé ou modèle refusé) : coupure immédiate ;
 * - coupe-circuit : après AI_CIRCUIT_BREAKER_THRESHOLD échecs temporaires consécutifs
 *   (un succès remet le compteur à zéro).
 * Une fois coupé, chaque appel échoue aussitôt, sans requête réseau : les étapes IA
 * retombent sur leur repli et l'analyse se termine avec le moteur déterministe.
 * Une requête refusée (`bad_request`, probable bug de WordFix) ne coupe rien : elle
 * reste visible comme un échec du morceau concerné.
 */
export function guardAi(
  ai: AiProvider,
  context: { analysisId: string; logger: Pick<Logger, 'warn' | 'error'> },
  threshold = AI_CIRCUIT_BREAKER_THRESHOLD,
): AiProvider {
  let halted: AiError | null = null;
  let consecutiveFailures = 0;
  const { analysisId, logger } = context;

  return {
    name: ai.name,
    async generateStructured(request) {
      if (halted) throw halted;
      try {
        const result = await ai.generateStructured(request);
        consecutiveFailures = 0;
        return result;
      } catch (error) {
        if (!(error instanceof AiError) || halted) throw error;
        if (error.kind === 'quota' || error.kind === 'config') {
          halted = error;
          logger.error(
            { analysisId, kind: error.kind },
            'Fournisseur IA inutilisable : suite de l’analyse sans IA',
          );
        } else if (error.kind === 'unavailable') {
          consecutiveFailures++;
          if (consecutiveFailures >= threshold) {
            halted = new AiError(
              'unavailable',
              `IA coupée pour cette analyse après ${consecutiveFailures} échecs temporaires consécutifs`,
              { cause: error },
            );
            logger.warn(
              { analysisId, failures: consecutiveFailures },
              'Coupe-circuit IA : suite de l’analyse sans IA',
            );
          }
        } else if (error.kind === 'bad_request') {
          logger.error(
            { analysisId, schema: request.schemaName },
            'Requête IA refusée par le fournisseur (probable bug WordFix)',
          );
        }
        throw error;
      }
    },
  };
}
