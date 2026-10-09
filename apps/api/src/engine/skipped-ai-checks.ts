import type { AiCheckKey, SkippedAiCheckDto } from '@wordfix/shared';
import { AI_FAILURE_CODES } from '../ai/ai-provider.js';

/**
 * Les lots de cas ambigus (étape C) sont des morceaux « verify » d'index ≥ 100 ; les
 * index inférieurs sont les vérifications de contradictions de l'analyse globale.
 */
export const AMBIGUITY_CHUNK_INDEX = 100;

export interface ChunkOutcome {
  stage: 'local' | 'context' | 'global' | 'verify';
  index: number;
  status: 'PENDING' | 'DONE' | 'FAILED';
  errorCode: string | null;
  /** Lot de cas ambigus : `{ cases: [...] }`. */
  blockIds: unknown;
  /** Lot de cas ambigus traité en repli : `{ failed: <code> }`. */
  result: unknown;
}

const ORDER: AiCheckKey[] = ['local', 'context', 'global', 'ambiguity'];

/**
 * Vérifications IA non effectuées, d'après les morceaux de l'analyse :
 * - un morceau en échec pour une cause IA (indisponibilité, limite de débit, quota,
 *   configuration, réponse invalide) n'a pas été vérifié par l'IA ;
 * - un lot de cas ambigus terminé en repli (`result.failed`) non plus : ses cas gardent
 *   le résultat des seules règles. Les cas ambigus sont comptés un par un.
 * Les échecs internes (requête refusée, bug) ne sont pas comptés ici : ils relèvent
 * de PARTIAL_ANALYSIS. Seules les vérifications avec au moins un élément sauté sont
 * renvoyées.
 */
export function skippedAiChecks(chunks: readonly ChunkOutcome[]): SkippedAiCheckDto[] {
  const counts = new Map<AiCheckKey, { skipped: number; total: number }>();
  const add = (check: AiCheckKey, total: number, skipped: boolean) => {
    const entry = counts.get(check) ?? { skipped: 0, total: 0 };
    entry.total += total;
    if (skipped) entry.skipped += total;
    counts.set(check, entry);
  };
  const aiFailed = (chunk: ChunkOutcome) =>
    chunk.status === 'FAILED' && AI_FAILURE_CODES.has(chunk.errorCode ?? '');

  for (const chunk of chunks) {
    if (chunk.stage === 'verify' && chunk.index >= AMBIGUITY_CHUNK_INDEX) {
      const cases = (chunk.blockIds as { cases?: unknown[] } | null)?.cases?.length ?? 1;
      const fallback = (chunk.result as { failed?: unknown } | null)?.failed;
      const skipped =
        aiFailed(chunk) ||
        (chunk.status === 'DONE' && typeof fallback === 'string' && AI_FAILURE_CODES.has(fallback));
      add('ambiguity', cases, skipped);
    } else {
      add(chunk.stage === 'verify' ? 'global' : chunk.stage, 1, aiFailed(chunk));
    }
  }
  return ORDER.flatMap((check) => {
    const entry = counts.get(check);
    return entry && entry.skipped > 0 ? [{ check, ...entry }] : [];
  });
}
