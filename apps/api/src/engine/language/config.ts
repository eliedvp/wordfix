import type { BlockKind } from '@wordfix/shared';

/**
 * Réglages du WordFix Language Engine, centralisés ici.
 *
 * Principe : mieux vaut peu de signalements justes que beaucoup de signalements
 * douteux. Chaque règle est plafonnée par document pour ne jamais noyer l'auteur.
 */
export interface LanguageEngineConfig {
  /** Types de paragraphes relus par les analyseurs de langue (mots, ponctuation). */
  languageBlockKinds: readonly BlockKind[];
  /** Types de paragraphes rédigés en phrases (longueur, espaces). */
  proseBlockKinds: readonly BlockKind[];
  /** Nombre maximal de signalements par règle et par document. */
  caps: Readonly<Record<LanguageRuleId, number>>;
  repetition: {
    /** Mots qui se répètent légitimement (« nous nous sommes », « vous vous êtes »). */
    allowedRepeats: readonly string[];
    /** Longueur maximale d'un mot comparé (au-delà : chaîne technique, pas un mot). */
    maxWordLength: number;
  };
  sentence: {
    /** Une phrase est signalée au-delà de ce nombre de mots. */
    longSentenceWords: number;
    /** À partir de ce nombre de points-virgules, la phrase est une énumération : ignorée. */
    enumerationSemicolons: number;
    /** Part maximale de nombres parmi les mots (au-delà : données, références). */
    maxNumericShare: number;
  };
  spelling: SpellingConfig;
}

/** Réglages de l'analyseur orthographique (SpellingAnalyzer). */
export interface SpellingConfig {
  /** Longueur minimale d'un mot vérifié (les mots très courts sont trop ambigus). */
  minWordLength: number;
  /** Longueur maximale d'un mot vérifié (au-delà : chaîne technique). */
  maxWordLength: number;
  /** Mots inconnus distincts pour lesquels on demande des suggestions, par document. */
  maxSuggestionLookups: number;
  /** Nombre de suggestions de nspell examinées pour un mot. */
  maxCandidates: number;
  /** Un mot inconnu présent au moins ce nombre de fois est considéré comme voulu. */
  repeatedUnknownThreshold: number;
  /** Coût maximal (distance pondérée) d'une correction acceptée. */
  maxCost: number;
  /** Coût maximal pour les mots courts (au plus `shortWordLength` lettres). */
  maxCostShortWord: number;
  shortWordLength: number;
  /** Écart minimal avec le deuxième candidat : confiance élevée / moyenne. */
  highMargin: number;
  mediumMargin: number;
  /** Candidats « plausibles » : coût au plus `densityCost`. Au-delà de ces nombres, trop d'ambiguïté. */
  densityCost: number;
  highMaxDensity: number;
  mediumMaxDensity: number;
  /** Fenêtre de coût des candidats jugés aussi proches que le meilleur. */
  closeWindow: number;
  /** Préfixe commun (part de la longueur) qui fait de deux candidats des formes d'un même mot. */
  sameFamilyPrefixRatio: number;
}

export const LANGUAGE_RULE_IDS = [
  'repeated_word',
  'long_sentence',
  'double_space',
  'space_before_punctuation',
  'doubled_punctuation',
  'missing_space_after_comma',
  'misspelling',
] as const;
export type LanguageRuleId = (typeof LANGUAGE_RULE_IDS)[number];

export const LANGUAGE_ENGINE_CONFIG: LanguageEngineConfig = {
  languageBlockKinds: ['paragraph', 'list_item', 'table_cell', 'caption', 'footnote', 'endnote'],
  proseBlockKinds: ['paragraph', 'list_item', 'footnote', 'endnote'],
  caps: {
    repeated_word: 30,
    long_sentence: 15,
    double_space: 10,
    space_before_punctuation: 10,
    doubled_punctuation: 10,
    missing_space_after_comma: 10,
    misspelling: 60,
  },
  repetition: {
    allowedRepeats: ['nous', 'vous'],
    maxWordLength: 30,
  },
  sentence: {
    longSentenceWords: 45,
    enumerationSemicolons: 2,
    maxNumericShare: 0.3,
  },
  spelling: {
    minWordLength: 4,
    maxWordLength: 30,
    maxSuggestionLookups: 200,
    maxCandidates: 8,
    repeatedUnknownThreshold: 3,
    maxCost: 1.3,
    maxCostShortWord: 0.8,
    shortWordLength: 5,
    highMargin: 0.5,
    mediumMargin: 0.15,
    densityCost: 1.3,
    highMaxDensity: 2,
    mediumMaxDensity: 3,
    closeWindow: 0.35,
    sameFamilyPrefixRatio: 0.7,
  },
};
