import type { AiMode, AnalysisStepKey, AnalysisWarning, SkippedAiCheckDto } from '@wordfix/shared';

/**
 * Textes de confidentialité validés (décision P1). Ce sont les SEULS affichés :
 * chacun correspond à un mécanisme réellement en place (voir docs/decisions.md).
 * Le dernier engagement (envoi à un service d'IA) dépend du mode IA réellement
 * configuré : voir aiPrivacyStatement.
 */
export const PRIVACY_STATEMENTS = [
  'Connexion chiffrée (HTTPS).',
  'Votre fichier est supprimé au plus tard 24 h après l’import.',
  'Le texte extrait et les résultats sont supprimés après 7 jours. Vous pouvez tout supprimer immédiatement.',
  'Vos analyses ne sont accessibles que depuis ce navigateur. Aucun lien public n’est créé.',
] as const;

/**
 * Engagement sur l'envoi du texte à un service d'IA, selon le mode réellement configuré
 * (GET /api/ai-mode). Mode inconnu (API injoignable) : formulation prudente, qui ne
 * prétend jamais que le texte reste sur nos serveurs.
 */
export function aiPrivacyStatement(mode: AiMode | null): string {
  switch (mode) {
    case 'openai':
      return 'Pour l’analyse, le texte de votre document est envoyé à OpenAI.';
    case 'gemini':
      return 'Pour l’analyse, le texte de votre document est envoyé à Google (Gemini).';
    case 'none':
    case 'fake':
      return 'Votre document n’est envoyé à aucun service d’intelligence artificielle.';
    default:
      return 'Selon la configuration du service, le texte de votre document peut être envoyé à OpenAI pour l’analyse.';
  }
}

/** Détail de cet engagement (page Confidentialité). */
export function aiPrivacyDetail(mode: AiMode | null): string {
  switch (mode) {
    case 'openai':
      return 'L’analyse s’appuie sur le service d’intelligence artificielle d’OpenAI : le texte du document lui est envoyé par morceaux. Le fichier Word lui-même ne lui est pas transmis.';
    case 'gemini':
      return 'L’analyse s’appuie sur le service d’intelligence artificielle Gemini de Google : le texte du document lui est envoyé par morceaux. Le fichier Word lui-même ne lui est pas transmis.';
    case 'none':
    case 'fake':
      return 'L’analyse est faite uniquement par le moteur de WordFix (orthographe, grammaire et règles automatiques), sur nos serveurs. Aucun service d’intelligence artificielle extérieur ne reçoit le texte de votre document.';
    default:
      return 'Le mode d’analyse n’a pas pu être vérifié au moment de l’affichage de cette page. Lorsque l’analyse s’appuie sur l’intelligence artificielle d’OpenAI, le texte du document lui est envoyé par morceaux ; le fichier Word lui-même ne lui est pas transmis.';
  }
}

/** Les cinq engagements affichés, le dernier selon le mode IA. */
export function privacyStatements(mode: AiMode | null): string[] {
  return [...PRIVACY_STATEMENTS, aiPrivacyStatement(mode)];
}

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
  AI_DISABLED:
    'Analyse effectuée sans IA : seuls l’orthographe, la grammaire (Grammalecte) et les règles automatiques de WordFix ont été vérifiés. Les relectures par IA (style, cohérence des sections et du document) n’ont pas été faites.',
  AI_CHECKS_SKIPPED:
    'Certaines vérifications avancées par IA n’ont pas pu être effectuées. Les résultats affichés proviennent des vérifications automatiques de WordFix.',
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

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Détail d'une vérification IA non effectuée (affiché sous AI_CHECKS_SKIPPED). */
export function skippedAiCheckText({ check, skipped, total }: SkippedAiCheckDto): string {
  switch (check) {
    case 'local':
      return skipped === total
        ? 'Relecture par IA paragraphe par paragraphe : non effectuée.'
        : `Relecture par IA paragraphe par paragraphe : ${skipped} ${plural(skipped, 'passage', 'passages')} sur ${total} non ${plural(skipped, 'relu', 'relus')}.`;
    case 'context':
      return skipped === total
        ? 'Cohérence de chaque section : non vérifiée.'
        : `Cohérence de chaque section : ${skipped} ${plural(skipped, 'groupe', 'groupes')} de sections sur ${total} non ${plural(skipped, 'vérifié', 'vérifiés')}.`;
    case 'global':
      return skipped === total
        ? 'Cohérence du document entier (contradictions entre les parties) : non vérifiée.'
        : `Cohérence du document entier : ${skipped} ${plural(skipped, 'vérification', 'vérifications')} sur ${total} non ${plural(skipped, 'effectuée', 'effectuées')}.`;
    case 'ambiguity':
      return `Mots ambigus : ${skipped === total ? `${total} cas` : `${skipped} cas sur ${total}`} non ${plural(skipped, 'départagé', 'départagés')} par l’IA. Ils gardent le résultat des vérifications automatiques (« À vérifier » ou aucune remarque).`;
  }
}

/** Ce que couvre le score, selon que l'IA a été utilisée ou non. */
export function scoreScope(aiDisabled: boolean): string {
  return aiDisabled
    ? 'Analyse sans IA : ce score ne tient compte que des vérifications automatiques (orthographe, grammaire, règles). La cohérence du document n’a pas été vérifiée.'
    : 'Ce score reflète la forme et la cohérence du texte. Il ne juge pas le fond de votre travail.';
}

export function scoreSentence(score: number): string {
  if (score >= 90) return 'Très peu de points à revoir.';
  if (score >= 75) return 'Bon document, quelques points à corriger.';
  if (score >= 50) return 'Plusieurs points méritent votre attention.';
  return 'Beaucoup de points à revoir : prenez-les dans l’ordre.';
}
