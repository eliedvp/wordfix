import type { SpellChecker, SpellingDictionaries } from './dictionaries.js';
import { NO_FREQUENCY, type WordFrequency } from './frequency.js';
import { TECHNICAL_TERMS } from './technical-terms.js';

/**
 * Listes de mots connus, consultées avant de déclarer un mot inconnu :
 * - dictionnaire général français (nspell + Grammalecte) ;
 * - termes techniques (liste de départ, voir technical-terms.ts) ;
 * - mots anglais (anglicismes : jamais signalés, voir english-words.ts) ;
 * - dictionnaire utilisateur et noms propres : prévus, vides pour l'instant
 *   (un futur dictionnaire par utilisateur ou par document s'y branchera).
 */
export interface WordList {
  has(word: string): boolean;
}

/** Liste insensible à la casse, construite à partir de mots en minuscules. */
export class LowercaseWordList implements WordList {
  private readonly words: ReadonlySet<string>;

  constructor(words: Iterable<string>) {
    this.words = new Set([...words].map((word) => word.toLowerCase()));
  }

  has(word: string): boolean {
    return this.words.has(word.toLowerCase());
  }
}

export const EMPTY_WORD_LIST: WordList = { has: () => false };

export interface SpellingLexicon {
  general: SpellChecker;
  technical: WordList;
  /** Mots d'une autre langue : un mot inconnu en français mais connu ici n'est pas une faute. */
  foreign: WordList;
  user: WordList;
  properNames: WordList;
  /** Fréquence d'usage des mots français (classement des corrections). */
  frequency: WordFrequency;
}

export function defaultLexicon(dictionaries: SpellingDictionaries): SpellingLexicon {
  return {
    general: dictionaries.french,
    technical: new LowercaseWordList(TECHNICAL_TERMS),
    foreign: dictionaries.english,
    user: EMPTY_WORD_LIST,
    properNames: EMPTY_WORD_LIST,
    frequency: dictionaries.frequency ?? NO_FREQUENCY,
  };
}

/** Le mot est-il connu d'une des listes ? */
export function isKnownWord(lexicon: SpellingLexicon, word: string): boolean {
  return (
    lexicon.technical.has(word) ||
    lexicon.user.has(word) ||
    lexicon.properNames.has(word) ||
    lexicon.general.isCorrect(word)
  );
}
