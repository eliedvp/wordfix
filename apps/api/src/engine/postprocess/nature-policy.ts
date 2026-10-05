import type { Confidence, IssueNature, IssueSeverity } from '@wordfix/shared';
import type { CandidateIssue } from '../types.js';

/**
 * Nature d'un problème, décidée par le backend à partir de la catégorie, du
 * sous-type, de la confiance et de la présence d'une correction. Le modèle ne
 * peut jamais faire d'une hypothèse une « erreur » : une partie qui semble
 * manquer reste toujours « à vérifier ».
 */
export function decideNature(issue: CandidateIssue): IssueNature {
  const { category, subtype, confidence } = issue;

  switch (category) {
    case 'spelling':
    case 'grammar':
    case 'punctuation':
      if (confidence === 'low') return 'verify';
      if (confidence === 'high' && issue.suggestion) return 'error';
      return 'suggestion';

    case 'style':
      return confidence === 'low' ? 'verify' : 'suggestion';

    case 'coherence':
      if (subtype === 'contradiction') {
        return issue.verdict === 'contradictory' ? 'potential' : 'verify';
      }
      return confidence === 'low' ? 'verify' : 'potential';

    case 'structure':
      if (subtype === 'heading_numbering' || subtype === 'toc_mismatch') {
        return confidence === 'high' ? 'potential' : 'verify';
      }
      if (subtype === 'weak_transition' || subtype === 'heading_wording') {
        return confidence === 'high' && issue.suggestion ? 'suggestion' : 'verify';
      }
      return 'verify';
  }
}

/** Une remarque « à vérifier » ne peut pas être présentée comme critique. */
export function adjustSeverity(nature: IssueNature, severity: IssueSeverity): IssueSeverity {
  if (nature === 'verify' && severity === 'critical') return 'major';
  return severity;
}

/** Formulations affirmatives interdites pour une hypothèse. */
const ASSERTIVE =
  /\b(manque(nt)?|est faux|sont faux|est fausse|est erron[ée]e?s?|il faut absolument|obligatoirement)\b/i;

/** Explications de remplacement, au conditionnel, si le modèle affirme à tort. */
const HEDGED_FALLBACKS: Record<string, string> = {
  possibly_missing_section:
    'Une partie attendue pour ce type de document semble absente. Vérifiez si elle est nécessaire.',
  incomplete_paragraph:
    'Ce paragraphe semble incomplet. Vérifiez qu’aucune information importante ne manque.',
  unbalanced_section:
    'Cette section paraît très différente des autres par sa longueur. Vérifiez si c’est voulu.',
  contradiction:
    'Ces passages semblent donner des informations différentes. Vérifiez lequel est exact.',
  weak_transition:
    'Le passage d’une idée à l’autre paraît abrupt. Une transition pourrait aider le lecteur.',
};

export function ensureHedged(nature: IssueNature, subtype: string, explanation: string): string {
  if (nature !== 'potential' && nature !== 'verify') return explanation;
  if (!ASSERTIVE.test(explanation)) return explanation;
  return (
    HEDGED_FALLBACKS[subtype] ??
    'Ce point mérite une vérification : relisez ce passage pour décider s’il faut le modifier.'
  );
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence];
}
