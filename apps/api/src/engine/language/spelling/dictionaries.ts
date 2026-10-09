import type NSpell from 'nspell';
import { EnglishWordList, parseAffixes, parseDicStems } from './english-words.js';
import { loadFrequencies, type WordFrequency } from './frequency.js';

/**
 * Dictionnaires de l'analyseur orthographique :
 * - français : nspell (moteur Hunspell en JavaScript) avec le dictionnaire
 *   Grammalecte fourni par `dictionary-fr` ;
 * - anglais : simple liste de formes de base (`dictionary-en`), pour reconnaître
 *   les anglicismes (voir english-words.ts) ;
 * - fréquences : liste wordfreq des mots français (voir frequency.ts).
 *
 * Le chargement coûte quelques secondes et plusieurs centaines de Mo de mémoire
 * (voir docs/language-engine.md) : il a lieu UNE SEULE FOIS par processus, et
 * seulement dans le worker (préchargé au démarrage, et attendu par le moteur
 * avant chaque analyse). L'API ne l'importe jamais. Aucun appel réseau : les
 * fichiers sont installés avec l'application.
 */

/** Vérificateur orthographique utilisé par l'analyseur (interface remplaçable). */
export interface SpellChecker {
  isCorrect(word: string): boolean;
  /**
   * Existe-t-il un mot du dictionnaire à une seule faute de distance (ou à deux
   * fautes « légères » : accent, lettre doublée) ? Contrôle rapide (quelques ms)
   * qui évite d'appeler `suggest` pour un nom propre ou un terme inconnu :
   * nspell met alors jusqu'à plusieurs secondes à ne rien trouver.
   */
  hasCloseWord(word: string): boolean;
  suggest(word: string): readonly string[];
}

const ALPHABET = [...'abcdefghijklmnopqrstuvwxyzàâäéèêëîïôöùûüçœ'];
const ACCENTED: Record<string, string> = {
  a: 'àâä',
  e: 'éèêë',
  i: 'îï',
  o: 'ôö',
  u: 'ùûü',
  c: 'ç',
};
const BASE_LETTER = new Map<string, string>(
  Object.entries(ACCENTED).flatMap(([base, variants]) => [...variants].map((v) => [v, base])),
);

/** Toutes les variantes à une modification (suppression, inversion, remplacement, ajout). */
function* singleEdits(word: string): Generator<string> {
  const a = [...word];
  for (let i = 0; i <= a.length; i++) {
    const head = a.slice(0, i).join('');
    if (i < a.length) {
      const tail = a.slice(i + 1).join('');
      yield head + tail;
      if (i < a.length - 1) yield head + (a[i + 1] ?? '') + (a[i] ?? '') + a.slice(i + 2).join('');
      for (const letter of ALPHABET) if (letter !== a[i]) yield head + letter + tail;
    }
    const rest = a.slice(i).join('');
    for (const letter of ALPHABET) yield head + letter + rest;
  }
}

/** Variantes « légères » : accent changé, lettre doublée ou dédoublée. */
function lightEdits(word: string): Set<string> {
  const out = new Set<string>();
  const a = [...word];
  for (let i = 0; i < a.length; i++) {
    const letter = a[i] ?? '';
    const base = BASE_LETTER.get(letter) ?? letter;
    const head = a.slice(0, i).join('');
    const tail = a.slice(i + 1).join('');
    for (const variant of (ACCENTED[base] ?? '') + base) {
      if (variant !== letter) out.add(head + variant + tail);
    }
    out.add(head + letter + letter + tail);
    if (a[i + 1] === letter) out.add(head + tail);
  }
  return out;
}

export interface DictionaryLoadStats {
  /** Nombre de constructions du dictionnaire dans ce processus (doit rester ≤ 1). */
  loads: number;
  loadMs: number | null;
  /** Nombre de formes de base anglaises connues. */
  englishWords: number;
  /** Nombre de mots français dont la fréquence est connue. */
  frequencyWords: number;
  /** Mémoire du processus (RSS, en Mo) juste avant et juste après le chargement. */
  rssBeforeMb: number | null;
  rssAfterMb: number | null;
}

/** Au-delà, les caches de mots sont vidés (mémoire bornée). */
const CORRECT_CACHE_LIMIT = 100_000;
const SUGGEST_CACHE_LIMIT = 10_000;

class NspellChecker implements SpellChecker {
  private readonly correctCache = new Map<string, boolean>();
  private readonly suggestCache = new Map<string, readonly string[]>();
  private readonly closeCache = new Map<string, boolean>();

  constructor(private readonly spell: NSpell) {}

  isCorrect(word: string): boolean {
    const cached = this.correctCache.get(word);
    if (cached !== undefined) return cached;
    if (this.correctCache.size >= CORRECT_CACHE_LIMIT) this.correctCache.clear();
    const result = this.spell.correct(word);
    this.correctCache.set(word, result);
    return result;
  }

  hasCloseWord(word: string): boolean {
    const cached = this.closeCache.get(word);
    if (cached !== undefined) return cached;
    if (this.closeCache.size >= SUGGEST_CACHE_LIMIT) this.closeCache.clear();
    const result = this.searchCloseWord(word);
    this.closeCache.set(word, result);
    return result;
  }

  private searchCloseWord(word: string): boolean {
    for (const variant of singleEdits(word)) if (this.spell.correct(variant)) return true;
    for (const first of lightEdits(word)) {
      for (const second of lightEdits(first)) if (this.spell.correct(second)) return true;
    }
    return false;
  }

  suggest(word: string): readonly string[] {
    const cached = this.suggestCache.get(word);
    if (cached) return cached;
    if (this.suggestCache.size >= SUGGEST_CACHE_LIMIT) this.suggestCache.clear();
    const result = Object.freeze(this.spell.suggest(word));
    this.suggestCache.set(word, result);
    return result;
  }
}

export interface SpellingDictionaries {
  french: SpellChecker;
  english: EnglishWordList;
  /** Fréquence d'usage des mots français (classement des corrections). */
  frequency: WordFrequency;
}

const stats: DictionaryLoadStats = {
  loads: 0,
  loadMs: null,
  englishWords: 0,
  frequencyWords: 0,
  rssBeforeMb: null,
  rssAfterMb: null,
};
let loading: Promise<SpellingDictionaries> | null = null;
let loaded: SpellingDictionaries | null = null;

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * Charge les dictionnaires si nécessaire et renvoie l'instance unique du
 * processus. Les appels simultanés partagent le même chargement.
 */
export function loadSpellingDictionaries(): Promise<SpellingDictionaries> {
  loading ??= (async () => {
    const [{ default: nspell }, { default: french }, { default: english }] = await Promise.all([
      import('nspell'),
      import('dictionary-fr'),
      import('dictionary-en'),
    ]);
    const started = performance.now();
    stats.rssBeforeMb = megabytes(process.memoryUsage().rss);
    const spell = nspell({ aff: toBuffer(french.aff), dic: toBuffer(french.dic) });
    // Formes de base (anglicismes, comportement historique) et formes développées
    // (passages en anglais) : un texte français est relu exactement comme avant.
    const englishWords = new EnglishWordList(
      parseDicStems(english.dic),
      parseDicStems(english.dic, parseAffixes(english.aff)),
    );
    const frequency = loadFrequencies();
    stats.loads++;
    stats.frequencyWords = frequency.size;
    stats.loadMs = Math.round(performance.now() - started);
    stats.englishWords = englishWords.size;
    stats.rssAfterMb = megabytes(process.memoryUsage().rss);
    loaded = { french: new NspellChecker(spell), english: englishWords, frequency };
    return loaded;
  })();
  return loading;
}

/**
 * Dictionnaires déjà chargés. Le moteur étant synchrone, le chargement doit
 * avoir été attendu avant l'analyse (`loadSpellingDictionaries`) : sinon, erreur claire.
 */
export function getSpellingDictionaries(): SpellingDictionaries {
  if (!loaded) {
    throw new Error(
      'Dictionnaires non chargés : appelez loadSpellingDictionaries() avant l’analyse.',
    );
  }
  return loaded;
}

/** Dictionnaires s'ils sont déjà chargés, sinon null (jamais d'erreur ni de chargement). */
export function peekSpellingDictionaries(): SpellingDictionaries | null {
  return loaded;
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function dictionaryLoadStats(): Readonly<DictionaryLoadStats> {
  return { ...stats };
}
