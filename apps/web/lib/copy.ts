import type { AnalysisStepKey, AnalysisWarning } from '@wordfix/shared';

/**
 * Textes de confidentialité validés (décision P1). Ce sont les SEULS affichés :
 * chacun correspond à un mécanisme réellement en place (voir docs/decisions.md).
 */
export const PRIVACY_STATEMENTS = [
  'Connexion chiffrée (HTTPS).',
  'Votre fichier est supprimé au plus tard 24 h après l’import.',
  'Le texte extrait et les résultats sont supprimés après 7 jours. Vous pouvez tout supprimer immédiatement.',
  'Vos analyses ne sont accessibles que depuis ce navigateur. Aucun lien public n’est créé.',
  'Pour l’analyse, le texte de votre document est envoyé à OpenAI.',
] as const;

export const STEP_LABELS: Record<AnalysisStepKey, { title: string; detail: string }> = {
  extract: { title: 'Lecture du document', detail: 'Titres, sections, tableaux et notes' },
  local: {
    title: 'Orthographe, grammaire et style',
    detail: 'Relecture paragraphe par paragraphe',
  },
  context: { title: 'Cohérence de chaque section', detail: 'Transitions, temps, répétitions' },
  global: {
    title: 'Cohérence du document entier',
    detail: 'Contradictions et termes entre les parties',
  },
  finalize: { title: 'Préparation des résultats', detail: 'Tri, doublons et score' },
};

export const WARNING_TEXTS: Record<AnalysisWarning, string> = {
  PARTIAL_ANALYSIS:
    'Certaines parties n’ont pas pu être analysées. Les résultats affichés restent valables pour le reste du document.',
  HEADINGS_INFERRED:
    'Vos titres ne sont pas mis en forme avec les styles « Titre » de Word : ils ont été déduits de leur apparence. Les sections indiquées peuvent être approximatives.',
  NON_FRENCH_DOCUMENT:
    'Ce document ne semble pas rédigé en français. WordFix est conçu pour le français : les résultats peuvent être moins fiables.',
  PARSER_FALLBACK:
    'Ce document a été lu en mode simplifié : la localisation des problèmes peut être moins précise.',
  ELEMENTS_SKIPPED: 'Les images, équations et zones de texte ne sont pas relues.',
  ISSUES_CAPPED:
    'Beaucoup de points ont été relevés : seuls les 500 plus importants sont affichés.',
};

export function scoreSentence(score: number): string {
  if (score >= 90) return 'Très peu de points à revoir.';
  if (score >= 75) return 'Bon document, quelques points à corriger.';
  if (score >= 50) return 'Plusieurs points méritent votre attention.';
  return 'Beaucoup de points à revoir : prenez-les dans l’ordre.';
}
