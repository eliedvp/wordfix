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
}

export const LANGUAGE_RULE_IDS = [
  'repeated_word',
  'long_sentence',
  'double_space',
  'space_before_punctuation',
  'doubled_punctuation',
  'missing_space_after_comma',
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
};
