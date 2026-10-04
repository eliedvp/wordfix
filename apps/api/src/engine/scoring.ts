import {
  ISSUE_CATEGORIES,
  type IssueCategory,
  type IssueNature,
  type IssueSeverity,
  type ScoreDetail,
} from '@wordfix/shared';

/**
 * Score de qualité, calculé par le backend (jamais demandé à l'IA).
 *
 * Pour chaque catégorie : densité de problèmes pour 1 000 mots, pondérée par la
 * nature et la gravité, plafonnée. Score = 100 − somme des pénalités.
 * Les points « à vérifier » ne pénalisent pas : ce ne sont que des hypothèses.
 * Les poids sont centralisés ici pour rester transparents et modifiables.
 */
export const SCORE_WEIGHTS = {
  nature: { error: 1, suggestion: 0.3, potential: 0.5, verify: 0 } satisfies Record<
    IssueNature,
    number
  >,
  severity: { minor: 1, major: 2, critical: 3 } satisfies Record<IssueSeverity, number>,
  /** Points retirés pour une densité de 1 problème pondéré pour 1 000 mots. */
  perUnitDensity: 2,
  caps: {
    spelling: 25,
    grammar: 25,
    punctuation: 10,
    style: 15,
    coherence: 15,
    structure: 10,
  } satisfies Record<IssueCategory, number>,
};

export function computeScore(
  issues: { category: IssueCategory; nature: IssueNature; severity: IssueSeverity }[],
  wordCount: number,
): ScoreDetail {
  const thousands = Math.max(wordCount, 250) / 1000;
  const raw = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, 0])) as Record<
    IssueCategory,
    number
  >;
  for (const issue of issues) {
    raw[issue.category] +=
      SCORE_WEIGHTS.nature[issue.nature] * SCORE_WEIGHTS.severity[issue.severity];
  }

  const penalties = Object.fromEntries(
    ISSUE_CATEGORIES.map((category) => [
      category,
      Math.round(
        Math.min(
          SCORE_WEIGHTS.caps[category],
          (raw[category] / thousands) * SCORE_WEIGHTS.perUnitDensity,
        ) * 10,
      ) / 10,
    ]),
  ) as Record<IssueCategory, number>;

  const total = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - total))),
    wordCount,
    penalties,
  };
}
