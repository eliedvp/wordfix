import {
  type AnalysisDto,
  type AnalysisStatus,
  type AnalysisStepDto,
  type AnalysisStepKey,
  type AnalysisSummaryDto,
  type AnalysisWarning,
  type CategoryCounts,
  type ErrorCode,
  ISSUE_CATEGORIES,
  ISSUE_NATURES,
  type IssueSource,
  isErrorCode,
  type NatureCounts,
  type ScoreDetail,
} from '@wordfix/shared';
import type { Analysis, Document, PrismaClient } from '../generated/prisma/client.js';
import { skippedAiChecks } from '../engine/skipped-ai-checks.js';

const STATUS_STEP: Partial<Record<AnalysisStatus, AnalysisStepKey>> = {
  EXTRACTING: 'extract',
  ANALYZING_LOCAL: 'local',
  ANALYZING_CONTEXT: 'context',
  ANALYZING_GLOBAL: 'global',
  FINALIZING: 'finalize',
};
const STEP_ORDER: AnalysisStepKey[] = ['extract', 'local', 'context', 'global', 'finalize'];
const STEP_SOURCES: Record<AnalysisStepKey, IssueSource[]> = {
  extract: ['rules'],
  local: ['local'],
  context: ['context'],
  global: ['global', 'verify'],
  finalize: [],
};

function errorCodeOf(value: string | null): ErrorCode | null {
  return isErrorCode(value) ? value : value ? 'ANALYSIS_FAILED' : null;
}

/** Résumé d'analyse pour l'historique. */
export async function summarize(
  prisma: PrismaClient,
  analysis: Analysis,
): Promise<AnalysisSummaryDto> {
  const [issueCount, reviewedCount] = await Promise.all([
    prisma.issue.count({ where: { analysisId: analysis.id } }),
    prisma.issue.count({ where: { analysisId: analysis.id, status: { not: 'open' } } }),
  ]);
  return {
    id: analysis.id,
    status: analysis.status,
    progress: analysis.progress,
    score: analysis.score,
    createdAt: analysis.createdAt.toISOString(),
    completedAt: analysis.completedAt?.toISOString() ?? null,
    errorCode: errorCodeOf(analysis.errorCode),
    issueCount,
    reviewedCount,
  };
}

/** Vue complète d'une analyse (écran d'analyse et tableau de bord). */
export async function toAnalysisDto(
  prisma: PrismaClient,
  analysis: Analysis & { document: Document },
): Promise<AnalysisDto> {
  const [byNature, byCategory, bySource, reviewedCount, chunkGroups, aiOutcomes] =
    await Promise.all([
      prisma.issue.groupBy({
        by: ['nature'],
        where: { analysisId: analysis.id },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ['category'],
        where: { analysisId: analysis.id },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ['source'],
        where: { analysisId: analysis.id },
        _count: { _all: true },
      }),
      prisma.issue.count({ where: { analysisId: analysis.id, status: { not: 'open' } } }),
      prisma.analysisChunk.groupBy({
        by: ['stage', 'status'],
        where: { analysisId: analysis.id },
        _count: { _all: true },
      }),
      // Détail des vérifications IA non effectuées : seulement si l'analyse le signale.
      (analysis.warnings as AnalysisWarning[] | null)?.includes('AI_CHECKS_SKIPPED')
        ? prisma.analysisChunk.findMany({
            where: { analysisId: analysis.id },
            select: {
              stage: true,
              index: true,
              status: true,
              errorCode: true,
              blockIds: true,
              result: true,
            },
          })
        : Promise.resolve([]),
    ]);

  const natureCounts = Object.fromEntries(ISSUE_NATURES.map((n) => [n, 0])) as NatureCounts;
  for (const row of byNature) natureCounts[row.nature] = row._count._all;
  const categoryCounts = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, 0])) as CategoryCounts;
  for (const row of byCategory) categoryCounts[row.category] = row._count._all;
  const sourceCounts = new Map(bySource.map((row) => [row.source, row._count._all]));

  const steps = buildSteps(analysis, chunkGroups, sourceCounts);
  const issueCount = Object.values(natureCounts).reduce((sum, n) => sum + n, 0);

  return {
    id: analysis.id,
    documentId: analysis.documentId,
    documentName: analysis.document.originalName,
    status: analysis.status,
    progress: analysis.progress,
    chunksTotal: analysis.chunksTotal,
    chunksDone: analysis.chunksDone,
    steps,
    score: analysis.score,
    scoreDetail: (analysis.scoreDetail as ScoreDetail | null) ?? null,
    warnings: (analysis.warnings as AnalysisWarning[] | null) ?? [],
    skippedAiChecks: skippedAiChecks(aiOutcomes),
    errorCode: errorCodeOf(analysis.errorCode),
    wordCount: analysis.document.wordCount,
    estimatedPages: analysis.document.estimatedPages,
    natureCounts,
    categoryCounts,
    issueCount,
    reviewedCount,
    createdAt: analysis.createdAt.toISOString(),
    startedAt: analysis.startedAt?.toISOString() ?? null,
    completedAt: analysis.completedAt?.toISOString() ?? null,
    etaSeconds: estimateRemaining(analysis),
  };
}

function buildSteps(
  analysis: Analysis,
  chunkGroups: { stage: string; status: string; _count: { _all: number } }[],
  sourceCounts: Map<string, number>,
): AnalysisStepDto[] {
  const issueCount = (key: AnalysisStepKey) =>
    STEP_SOURCES[key].reduce((sum, source) => sum + (sourceCounts.get(source) ?? 0), 0);

  if (analysis.status === 'COMPLETED') {
    return STEP_ORDER.map((key) => ({ key, state: 'done', issueCount: issueCount(key) }));
  }

  const runningKey = STATUS_STEP[analysis.status];
  if (runningKey) {
    const runningIndex = STEP_ORDER.indexOf(runningKey);
    return STEP_ORDER.map((key, index) => ({
      key,
      state: index < runningIndex ? 'done' : index === runningIndex ? 'running' : 'pending',
      issueCount: issueCount(key),
    }));
  }

  if (analysis.status === 'QUEUED') {
    return STEP_ORDER.map((key) => ({ key, state: 'pending', issueCount: 0 }));
  }

  // Échec ou annulation : étapes terminées d'après les morceaux réellement traités.
  const settled = (stage: string) => {
    const rows = chunkGroups.filter((g) => g.stage === stage);
    return rows.length > 0 && rows.every((g) => g.status !== 'PENDING');
  };
  const doneMap: Record<AnalysisStepKey, boolean> = {
    extract: analysis.chunksTotal > 0,
    local: settled('local'),
    context: settled('context'),
    global: settled('global'),
    finalize: false,
  };
  let interrupted = false;
  return STEP_ORDER.map((key) => {
    if (!interrupted && doneMap[key]) return { key, state: 'done', issueCount: issueCount(key) };
    if (!interrupted) {
      interrupted = true;
      return {
        key,
        state: analysis.status === 'FAILED' ? 'failed' : 'skipped',
        issueCount: issueCount(key),
      };
    }
    return { key, state: 'skipped', issueCount: 0 };
  });
}

/** Temps restant estimé, seulement quand assez de morceaux ont été traités pour être fiable. */
function estimateRemaining(analysis: Analysis): number | null {
  if (!analysis.startedAt || analysis.chunksDone < 3) return null;
  if (!['ANALYZING_LOCAL', 'ANALYZING_CONTEXT', 'ANALYZING_GLOBAL'].includes(analysis.status))
    return null;
  const remaining = analysis.chunksTotal - analysis.chunksDone;
  if (remaining <= 0) return null;
  const elapsed = (Date.now() - analysis.startedAt.getTime()) / 1000;
  return Math.round((elapsed / analysis.chunksDone) * remaining);
}
