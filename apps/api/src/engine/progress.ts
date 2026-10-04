import type { AnalysisStatus } from '@wordfix/shared';

/**
 * Avancement réel d'une analyse, calculé uniquement à partir des morceaux
 * effectivement traités (jamais simulé). Poids des étapes en pourcentage.
 */
export const STAGE_WEIGHTS = { extract: 5, local: 50, context: 30, global: 7, finalize: 8 };

export interface StageCounts {
  local: { total: number; settled: number };
  context: { total: number; settled: number };
  global: { total: number; settled: number };
}

export function computeProgress(status: AnalysisStatus, counts: StageCounts): number {
  if (status === 'COMPLETED') return 100;
  if (status === 'QUEUED') return 0;
  const fraction = (c: { total: number; settled: number }) =>
    c.total === 0 ? 1 : Math.min(1, c.settled / c.total);

  let progress = 0;
  if (status !== 'EXTRACTING') progress += STAGE_WEIGHTS.extract;
  progress += STAGE_WEIGHTS.local * fraction(counts.local) * (status === 'EXTRACTING' ? 0 : 1);
  if (status === 'ANALYZING_CONTEXT' || status === 'ANALYZING_GLOBAL' || status === 'FINALIZING') {
    progress += STAGE_WEIGHTS.context * fraction(counts.context);
  }
  if (status === 'ANALYZING_GLOBAL' || status === 'FINALIZING') {
    progress += STAGE_WEIGHTS.global * fraction(counts.global);
  }
  return Math.min(99, Math.round(progress));
}
