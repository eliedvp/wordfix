/**
 * Taxonomie des problèmes détectés (dossier de conception, section 2).
 *
 * Deux axes distincts :
 * - la catégorie : de quoi il s'agit (orthographe, style, cohérence…) ;
 * - la nature : le degré de certitude (erreur, suggestion, à examiner, à vérifier).
 * La nature est toujours décidée par le backend, jamais par le modèle d'IA.
 */

export const ISSUE_CATEGORIES = [
  'spelling',
  'grammar',
  'punctuation',
  'style',
  'coherence',
  'structure',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const ISSUE_SUBTYPES = {
  spelling: ['misspelling', 'typo', 'accent', 'capitalization'],
  grammar: ['agreement', 'conjugation', 'syntax', 'gender_number', 'missing_word'],
  punctuation: ['punctuation', 'spacing'],
  style: ['awkward', 'too_long', 'unclear', 'wordy', 'informal_register', 'local_repetition'],
  coherence: [
    'terminology_variant',
    'acronym',
    'tense_shift',
    'contradiction',
    'naming_inconsistency',
    'global_repetition',
  ],
  structure: [
    'heading_wording',
    'heading_numbering',
    'weak_transition',
    'incomplete_paragraph',
    'possibly_missing_section',
    'unbalanced_section',
    'toc_mismatch',
  ],
} as const satisfies Record<IssueCategory, readonly string[]>;

export type IssueSubtype = (typeof ISSUE_SUBTYPES)[IssueCategory][number];

export const ISSUE_NATURES = ['error', 'suggestion', 'potential', 'verify'] as const;
export type IssueNature = (typeof ISSUE_NATURES)[number];

export const ISSUE_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const ISSUE_STATUSES = ['open', 'accepted', 'ignored', 'verified', 'edited'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SOURCES = ['rules', 'local', 'context', 'global', 'verify'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

/** Statut d'une analyse, dans l'ordre normal de progression. */
export const ANALYSIS_STATUSES = [
  'QUEUED',
  'EXTRACTING',
  'ANALYZING_LOCAL',
  'ANALYZING_CONTEXT',
  'ANALYZING_GLOBAL',
  'FINALIZING',
  'COMPLETED',
  'FAILED',
  'CANCELED',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const TERMINAL_ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELED',
];

export function isTerminalStatus(status: AnalysisStatus): boolean {
  return TERMINAL_ANALYSIS_STATUSES.includes(status);
}

/** Libellés français affichés dans l'interface. */
export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  spelling: 'Orthographe',
  grammar: 'Grammaire',
  punctuation: 'Ponctuation',
  style: 'Style',
  coherence: 'Cohérence',
  structure: 'Structure',
};

export const SUBTYPE_LABELS: Record<IssueSubtype, string> = {
  misspelling: 'Mot mal orthographié',
  typo: 'Faute de frappe',
  accent: 'Accent',
  capitalization: 'Majuscule',
  agreement: 'Accord',
  conjugation: 'Conjugaison',
  syntax: 'Syntaxe',
  gender_number: 'Genre et nombre',
  missing_word: 'Mot manquant',
  punctuation: 'Ponctuation',
  spacing: 'Espacement',
  awkward: 'Formulation maladroite',
  too_long: 'Phrase trop longue',
  unclear: 'Phrase peu claire',
  wordy: 'Formulation lourde',
  informal_register: 'Registre familier',
  local_repetition: 'Répétition',
  terminology_variant: 'Terme écrit de plusieurs façons',
  acronym: 'Sigle',
  tense_shift: 'Changement de temps',
  contradiction: 'Contradiction possible',
  naming_inconsistency: 'Appellation différente',
  global_repetition: 'Répétition dans le document',
  heading_wording: 'Formulation du titre',
  heading_numbering: 'Numérotation des titres',
  weak_transition: 'Transition',
  incomplete_paragraph: 'Paragraphe peut-être incomplet',
  possibly_missing_section: 'Partie peut-être manquante',
  unbalanced_section: 'Section déséquilibrée',
  toc_mismatch: 'Sommaire',
};

export const NATURE_LABELS: Record<IssueNature, string> = {
  error: 'Erreur',
  suggestion: 'Suggestion',
  potential: 'À examiner',
  verify: 'À vérifier',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: 'Confiance élevée',
  medium: 'Confiance moyenne',
  low: 'Confiance faible',
};
