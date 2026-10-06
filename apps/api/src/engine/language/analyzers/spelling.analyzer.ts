import type { Block } from '@wordfix/shared';
import { getSpellingDictionaries } from '../spelling/dictionaries.js';
import { NO_FREQUENCY, type WordFrequency } from '../spelling/frequency.js';
import { assessConfidence, rankCandidates } from '../spelling/ranking.js';
import { defaultLexicon, isKnownWord, type SpellingLexicon } from '../spelling/word-lists.js';
import { overlapsAny } from '../text.js';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';

/**
 * Orthographe française : mots inconnus du dictionnaire, avec une correction
 * proposée seulement quand elle est assez sûre.
 *
 * Un mot absent du dictionnaire n'est PAS une faute en soi (nom propre, marque,
 * terme technique, anglicisme…). L'analyseur écarte donc d'abord tout ce qui
 * ressemble à un nom ou à un terme technique, puis ne signale un mot que si
 * une correction se détache nettement (voir ranking.ts) :
 * confiance élevée → Erreur, moyenne → Suggestion, faible → aucun signalement.
 */

/** Un mot : lettres, avec apostrophes ou traits d'union internes. */
const TOKEN = /(?<![\p{L}\p{N}_])\p{L}+(?:['’-]\p{L}+)*(?![\p{L}\p{N}_])/gu;
/** Élision en tête de mot : « l’ », « d’ », « qu’ », « jusqu’ »… */
const ELISION = /^((?:jusqu|lorsqu|puisqu|quoiqu|presqu|qu|[cdjlmnst])['’])(.+)$/iu;

const LOOKUPS_COUNTER = 'spelling:lookups';
const lookupKey = (word: string) => `spelling:word:${word}`;

export class SpellingAnalyzer implements LanguageAnalyzer {
  readonly id = 'spelling';
  private lexicon: SpellingLexicon | null = null;

  /**
   * @param lexiconFactory listes de mots à utiliser (par défaut : dictionnaire
   *   français chargé + termes techniques). Résolu au premier usage, une fois
   *   le dictionnaire chargé.
   */
  constructor(
    private readonly lexiconFactory: () => SpellingLexicon = () =>
      defaultLexicon(getSpellingDictionaries()),
    private readonly frequency: WordFrequency = NO_FREQUENCY,
  ) {}

  blockKinds(config: AnalyzerContext['config']) {
    return config.languageBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    this.lexicon ??= this.lexiconFactory();
    const lexicon = this.lexicon;
    const config = context.config.spelling;
    const out: LanguageIssue[] = [];

    for (const match of block.text.matchAll(TOKEN)) {
      const token = match[0];
      const tokenStart = match.index;
      if (overlapsAny(context.protectedRanges, tokenStart, tokenStart + token.length)) continue;
      if (isKnownWord(lexicon, token)) continue;

      // « l’informatiue » : on corrige le mot, pas l'article élidé. Si le mot seul
      // est correct (« l’occasions »), c'est une question d'accord, pas d'orthographe.
      let word = token;
      let start = tokenStart;
      const elision = ELISION.exec(token);
      if (elision?.[1] && elision[2]) {
        if (isKnownWord(lexicon, elision[2])) continue;
        word = elision[2];
        start = tokenStart + elision[1].length;
      }

      if (!this.isCandidate(word, context)) continue;
      if (isKnownWord(lexicon, word)) continue;
      // Anglicisme (« team », « online », « install ») : pas une faute de français.
      if (lexicon.foreign.has(word)) continue;

      // Contrôle rapide : aucun mot du dictionnaire tout proche → pas de correction possible.
      const lower = word.toLowerCase();
      if (!lexicon.general.hasCloseWord(lower)) continue;
      if (!context.document.counters.has(lookupKey(lower))) {
        const used = context.document.counters.get(LOOKUPS_COUNTER) ?? 0;
        if (used >= config.maxSuggestionLookups) continue;
        context.document.counters.set(LOOKUPS_COUNTER, used + 1);
        context.document.counters.set(lookupKey(lower), 1);
      }

      // Suggestions sur la forme en minuscules ; seuls les mots courants sont retenus
      // (jamais un nom propre), puis la casse d'origine est rétablie.
      const capitalized = /^\p{Lu}/u.test(word);
      const candidates = lexicon.general
        .suggest(lower)
        .slice(0, config.maxCandidates)
        .filter((candidate) => acceptableCandidate(candidate, lower));
      const ranked = rankCandidates(lower, candidates, this.frequency);
      const verdict = assessConfidence(lower, ranked, candidates[0], config);
      if (verdict.confidence === 'low' || !verdict.best) continue;

      // Majuscule en milieu de phrase : peut-être un nom propre, jamais plus qu'une suggestion.
      const confidence =
        capitalized && !isSentenceStart(block, start) && verdict.confidence === 'high'
          ? 'medium'
          : verdict.confidence;
      const suggestion = matchCase(verdict.best, word);
      const alternatives = verdict.alternatives.slice(0, 2).map((alt) => matchCase(alt, word));

      out.push({
        rule: 'misspelling',
        category: 'spelling',
        subtype: 'misspelling',
        blockId: block.id,
        original: word,
        suggestion,
        explanation: explain(word, suggestion, alternatives, confidence),
        severity: confidence === 'high' ? 'major' : 'minor',
        confidence,
        source: 'rules',
        relatedBlockIds: [],
        range: { start, end: start + word.length },
      });
    }
    return out;
  }

  /** Écarte ce qui ressemble à un sigle, un nom de produit, un mot composé ou un terme voulu. */
  private isCandidate(word: string, context: AnalyzerContext): boolean {
    const config = context.config.spelling;
    const length = [...word].length;
    if (length < config.minWordLength || length > config.maxWordLength) return false;
    if (/[-'’]/.test(word)) return false; // mots composés : pas dans cette version
    if (/^\p{Lu}+$/u.test(word)) return false; // sigle : API, VPN, SATI
    if (/.\p{Lu}/u.test(word)) return false; // majuscule interne : GitHub, MongoDB, RESTful
    const occurrences = context.document.wordCounts.get(word.toLowerCase()) ?? 0;
    return occurrences < config.repeatedUnknownThreshold;
  }
}

/** Candidat recevable : un mot simple, en minuscules (jamais un nom propre), différent du mot. */
function acceptableCandidate(candidate: string, word: string): boolean {
  return !/[\s\p{Lu}]/u.test(candidate) && candidate !== word;
}

/** Reproduit la casse du mot d'origine : minuscules, Majuscule initiale. */
function matchCase(candidate: string, original: string): string {
  if (/^\p{Lu}/u.test(original)) {
    return candidate.charAt(0).toLocaleUpperCase('fr') + candidate.slice(1);
  }
  return candidate;
}

/** Le mot commence-t-il une phrase (aucune lettre avant lui dans la phrase) ? */
function isSentenceStart(block: Block, position: number): boolean {
  const sentence = block.sentences.find((s) => s.start <= position && position < s.end);
  const from = sentence?.start ?? 0;
  return !/[\p{L}\p{N}]/u.test(block.text.slice(from, position));
}

function explain(
  word: string,
  suggestion: string,
  alternatives: string[],
  confidence: 'high' | 'medium',
): string {
  if (confidence === 'high') {
    return `« ${word} » ne figure pas dans le dictionnaire : il s’agit probablement d’une faute de frappe pour « ${suggestion} ».`;
  }
  const others =
    alternatives.length > 0
      ? ` Autre possibilité : ${alternatives.map((alt) => `« ${alt} »`).join(' ou ')}.`
      : '';
  return `« ${word} » ne figure pas dans le dictionnaire. Vouliez-vous écrire « ${suggestion} » ?${others}`;
}
