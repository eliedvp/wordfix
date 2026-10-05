import type {
  Confidence,
  IssueCategory,
  IssueNature,
  IssueSeverity,
  IssueSource,
  ScoreDetail,
} from '@wordfix/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { computeScore } from '../scoring.js';
import { confidenceRank } from './nature-policy.js';

/** Au-delà, les remarques les moins importantes sont écartées (avertissement affiché). */
export const MAX_ISSUES_PER_ANALYSIS = 500;

const NATURE_RANK: Record<IssueNature, number> = {
  error: 4,
  suggestion: 3,
  potential: 2,
  verify: 1,
};
const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 3, major: 2, minor: 1 };
const SOURCE_RANK: Record<IssueSource, number> = {
  rules: 5,
  verify: 4,
  local: 3,
  context: 2,
  global: 1,
};

interface Row {
  id: string;
  blockId: string;
  charStart: number;
  charEnd: number;
  category: IssueCategory;
  nature: IssueNature;
  severity: IssueSeverity;
  confidence: Confidence;
  source: IssueSource;
  subtype: string;
}

/** Les fautes de langue forment une même famille : un seul signalement par endroit. */
function family(category: IssueCategory): string {
  return category === 'spelling' || category === 'grammar' || category === 'punctuation'
    ? 'language'
    : category;
}

function priority(row: Row): number {
  return (
    NATURE_RANK[row.nature] * 1000 +
    confidenceRank(row.confidence) * 100 +
    SEVERITY_RANK[row.severity] * 10 +
    SOURCE_RANK[row.source]
  );
}

/**
 * Dernière passe : suppression des doublons entre étapes (même endroit, même
 * famille de problème : on garde le plus sûr), plafond global, puis score.
 */
export async function finalizeIssues(
  prisma: PrismaService,
  analysisId: string,
  wordCount: number,
): Promise<{ capped: boolean; scoreDetail: ScoreDetail }> {
  const rows: Row[] = await prisma.issue.findMany({
    where: { analysisId },
    select: {
      id: true,
      blockId: true,
      charStart: true,
      charEnd: true,
      category: true,
      nature: true,
      severity: true,
      confidence: true,
      source: true,
      subtype: true,
    },
  });

  const sorted = [...rows].sort((a, b) => priority(b) - priority(a));
  const kept: Row[] = [];
  const removed: string[] = [];
  for (const row of sorted) {
    const overlaps = kept.some(
      (other) =>
        other.blockId === row.blockId &&
        family(other.category) === family(row.category) &&
        // Hors fautes de langue, deux remarques différentes au même endroit restent utiles.
        (family(row.category) === 'language' || other.subtype === row.subtype) &&
        other.charStart < row.charEnd &&
        row.charStart < other.charEnd,
    );
    if (overlaps) removed.push(row.id);
    else kept.push(row);
  }

  const capped = kept.length > MAX_ISSUES_PER_ANALYSIS;
  if (capped) removed.push(...kept.splice(MAX_ISSUES_PER_ANALYSIS).map((row) => row.id));

  if (removed.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: removed } } });
  }
  return { capped, scoreDetail: computeScore(kept, wordCount) };
}
