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
  /**
   * Nombre maximal de signalements par règle et par document : au moins `caps`,
   * puis proportionnel à la longueur (`capsPerThousandWords` signalements pour
   * 1 000 mots), pour qu'un long mémoire ne perde pas ses dernières fautes.
   */
  caps: Readonly<Record<LanguageRuleId, number>>;
  capsPerThousandWords: Readonly<Record<LanguageRuleId, number>>;
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
  grammar: GrammarConfig;
  ambiguity: AmbiguityConfig;
}

/**
 * Cas ambigus (voir ambiguity/) : quels cas le moteur prépare pour l'IA, et le
 * budget IA strict d'une analyse. Seuls ces cas peuvent être envoyés à l'IA.
 */
export interface AmbiguityConfig {
  /** Corrections proposées au plus par cas. */
  maxOptions: number;
  /** Mot inconnu ambigu : coût maximal d'une option, fréquence minimale (Zipf). */
  maxOptionCost: number;
  minOptionZipf: number;
  /** Repli « À vérifier » d'un mot inconnu : seulement si une option est à une faute légère. */
  verifyMaxCost: number;
  /** Mot très déformé (aucun mot à une faute près) : options de même prononciation, mots courants. */
  distortedMaxOptionCost: number;
  distortedMinOptionZipf: number;
  distortedMinLength: number;
  distortedMaxLength: number;
  /** Mots déformés soumis au plus par document : minimum, puis pour 1 000 mots. */
  distortedLookups: number;
  distortedLookupsPerThousandWords: number;
  /** Confusion d'accents (taches / tâches) : écart de fréquence minimal, fréquence minimale. */
  confusionMinZipfGap: number;
  confusionMinZipf: number;
  confusionMinLength: number;
  /** Budget IA par analyse. */
  ai: {
    maxBatches: number;
    maxCasesPerBatch: number;
    /** Contexte envoyé par cas (caractères autour du mot, dans sa phrase). */
    maxContextChars: number;
    maxOutputTokens: number;
  };
}

/** Sous-types WordFix de la catégorie « grammar » (voir la taxonomie partagée). */
export type GrammarSubtype = 'agreement' | 'conjugation' | 'syntax' | 'gender_number';

/** Réglages de l'analyseur grammatical (GrammarAnalyzer, moteur Grammalecte). */
export interface GrammarConfig {
  /** Types de paragraphes envoyés à Grammalecte : texte rédigé uniquement. */
  blockKinds: readonly BlockKind[];
  /**
   * Options Grammalecte retenues, avec leur sous-type WordFix. Ce sont aussi les
   * seules options activées dans Grammalecte : orthographe (SPELL), typographie
   * (apostrophes, espaces insécables…) et style ne sont jamais remontés.
   */
  types: Readonly<Record<string, GrammarSubtype>>;
  /** Options dont une correction unique peut être sûre (accords, conjugaison). */
  highConfidenceTypes: readonly string[];
  /**
   * Homophones grammaticaux courants (son/sont, a/à, ces/ses…) : si l'erreur porte
   * sur l'un d'eux ou le suit directement, l'erreur peut venir de ce mot plutôt
   * que de celui que Grammalecte corrige. La correction reste alors une suggestion.
   */
  ambiguousWords: readonly string[];
  /** Paragraphes plus longs ignorés (données, code collé) : en caractères. */
  maxParagraphLength: number;
  /** Taille d'un lot envoyé à Grammalecte, en caractères (plusieurs paragraphes par lot). */
  batchLength: number;
}

/** Réglages de l'analyseur orthographique (SpellingAnalyzer). */
export interface SpellingConfig {
  /** Longueur minimale d'un mot vérifié (les mots très courts sont trop ambigus). */
  minWordLength: number;
  /** Longueur maximale d'un mot vérifié (au-delà : chaîne technique). */
  maxWordLength: number;
  /** Mots inconnus distincts pour lesquels on demande des suggestions, par document (minimum). */
  maxSuggestionLookups: number;
  /** Recherches supplémentaires pour 1 000 mots (plafond proportionnel à la longueur). */
  suggestionLookupsPerThousandWords: number;
  /** Nombre de suggestions de nspell examinées pour un mot. */
  maxCandidates: number;
  /**
   * Un mot inconnu présent au moins ce nombre de fois est considéré comme voulu
   * (nom, terme du domaine), sauf s'il est en minuscules et à une faute légère
   * (`repeatedMaxCost`) d'un mot courant (`repeatedMinZipf`) : c'est alors une
   * faute systématique, signalée comme Suggestion.
   */
  repeatedUnknownThreshold: number;
  repeatedMaxCost: number;
  repeatedMinZipf: number;
  /** Poids de la fréquence (échelle Zipf) dans le classement des corrections. */
  frequencyWeight: number;
  /**
   * Conditions d'une correction présentée comme certaine (Erreur) : une seule
   * modification élémentaire au plus (`highMaxCost`) vers un mot courant (`highMinZipf`).
   */
  highMaxCost: number;
  highMinZipf: number;
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
  /** Écart de score au-delà duquel un candidat ne compte plus comme concurrent plausible. */
  densityWindow: number;
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
  'grammar',
  'accent_confusion',
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
    grammar: 80,
    accent_confusion: 20,
  },
  capsPerThousandWords: {
    repeated_word: 1,
    long_sentence: 0.5,
    double_space: 0.5,
    space_before_punctuation: 0.5,
    doubled_punctuation: 0.5,
    missing_space_after_comma: 0.5,
    misspelling: 5,
    grammar: 5,
    accent_confusion: 0.5,
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
    suggestionLookupsPerThousandWords: 10,
    maxCandidates: 8,
    repeatedUnknownThreshold: 3,
    repeatedMaxCost: 0.5,
    repeatedMinZipf: 3.5,
    frequencyWeight: 0.15,
    highMaxCost: 1,
    highMinZipf: 3,
    maxCost: 1.3,
    maxCostShortWord: 0.8,
    shortWordLength: 5,
    highMargin: 0.5,
    mediumMargin: 0.15,
    densityCost: 1.3,
    densityWindow: 0.8,
    highMaxDensity: 2,
    mediumMaxDensity: 3,
    closeWindow: 0.35,
    sameFamilyPrefixRatio: 0.7,
  },
  grammar: {
    blockKinds: ['paragraph', 'list_item', 'footnote', 'endnote'],
    types: {
      gn: 'gender_number', // accords en genre et en nombre (« les serveur »)
      ppas: 'agreement', // participes passés, adjectifs (« ils ont installer »)
      conj: 'conjugation', // accord sujet-verbe (« ils a »)
      infi: 'conjugation', // infinitif ou participe (« il faut installé »)
      imp: 'conjugation', // impératif
      vmode: 'conjugation', // modes verbaux (subjonctif…)
      inte: 'syntax', // interrogation
      conf: 'syntax', // confusions et homophones (a/à, ce/se…)
      loc: 'syntax', // locutions figées
    },
    highConfidenceTypes: ['gn', 'ppas', 'conj', 'infi'],
    ambiguousWords: [
      'a',
      'à',
      'as',
      'ont',
      'on',
      'son',
      'sont',
      'ses',
      'ces',
      'c’est',
      's’est',
      'sait',
      'ce',
      'se',
      'et',
      'est',
      'es',
      'ou',
      'où',
      'leur',
      'leurs',
      'la',
      'là',
      'l’a',
      'ma',
      'm’a',
      'ta',
      't’a',
      'mes',
      'mais',
      'peu',
      'peut',
      'peux',
      'quel',
      'quelle',
      'quels',
      'quelles',
      'qu’elle',
      'qu’elles',
      'quand',
      'quant',
      'sans',
      's’en',
      'dans',
      'd’en',
      'ni',
      'n’y',
      'si',
      's’y',
      'ci',
      'tout',
      'tous',
    ],
    maxParagraphLength: 20_000,
    batchLength: 40_000,
  },
  ambiguity: {
    maxOptions: 5,
    maxOptionCost: 1.3,
    minOptionZipf: 1.5,
    verifyMaxCost: 0.7,
    distortedMaxOptionCost: 3,
    distortedMinOptionZipf: 2.5,
    distortedMinLength: 5,
    distortedMaxLength: 20,
    distortedLookups: 30,
    distortedLookupsPerThousandWords: 1,
    confusionMinZipfGap: 0,
    confusionMinZipf: 3.5,
    confusionMinLength: 4,
    ai: {
      maxBatches: 3,
      maxCasesPerBatch: 20,
      maxContextChars: 300,
      maxOutputTokens: 4_000,
    },
  },
};
