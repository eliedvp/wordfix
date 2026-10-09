import type { Block } from '@wordfix/shared';
import { getSpellingDictionaries } from '../spelling/dictionaries.js';
import { accentedVariant } from '../spelling/accents.js';
import { EnglishWordList, englishCorrections } from '../spelling/english-words.js';
import { FEMININE_EURE, feminineVariant } from '../spelling/feminine.js';
import { NO_FREQUENCY, type WordFrequency, ZipfFrequency } from '../spelling/frequency.js';
import { soundsLike } from '../spelling/phonetic.js';
import { assessConfidence, rankCandidates, type RankedCandidate } from '../spelling/ranking.js';
import type { AmbiguityOption } from '../ambiguity/types.js';
import { isRectifiedSpelling } from '../spelling/rectifications.js';
import { defaultLexicon, isKnownWord, type SpellingLexicon } from '../spelling/word-lists.js';
import { followsTitleOrInitial, isSentenceStart, overlapsAny } from '../text.js';
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
 *
 * Une correction n'est présentée comme certaine (Erreur) que si elle est proche
 * (une modification élémentaire), vers un mot courant, d'accord avec nspell, et
 * qu'aucun doute ne vient du contexte : majuscule en milieu de phrase, mot qui
 * existe en anglais, mot répété dans le document, langue incertaine. Sinon :
 * Suggestion au mieux.
 *
 * Langue (detection.ts) : dans une phrase en anglais, le dictionnaire français ne
 * s'applique pas ; seule une faute anglaise évidente (une seule correction à une
 * lettre près) est proposée, en Suggestion. Dans une phrase de langue incertaine,
 * un mot anglais connu n'est jamais signalé.
 */

/** Un mot : lettres, avec apostrophes ou traits d'union internes. */
const TOKEN = /(?<![\p{L}\p{N}_])\p{L}+(?:['’-]\p{L}+)*(?![\p{L}\p{N}_])/gu;
/** Élision en tête de mot : « l’ », « d’ », « qu’ », « jusqu’ »… */
const ELISION = /^((?:jusqu|lorsqu|puisqu|quoiqu|presqu|qu|[cdjlmnst])['’])(.+)$/iu;

const LOOKUPS_COUNTER = 'spelling:lookups';
const ENGLISH_COUNTER = 'spelling:english';
const DISTORTED_COUNTER = 'spelling:distorted';
const lookupKey = (word: string) => `spelling:word:${word}`;

export class SpellingAnalyzer implements LanguageAnalyzer {
  readonly id = 'spelling';
  private lexicon: SpellingLexicon | null = null;

  /**
   * @param lexiconFactory listes de mots à utiliser (par défaut : dictionnaire
   *   français chargé + termes techniques + fréquences). Résolu au premier usage,
   *   une fois le dictionnaire chargé.
   * @param frequency fréquences à utiliser à la place de celles du lexique (tests).
   */
  constructor(
    private readonly lexiconFactory: () => SpellingLexicon = () =>
      defaultLexicon(getSpellingDictionaries()),
    private readonly frequency?: WordFrequency,
  ) {}

  blockKinds(config: AnalyzerContext['config']) {
    return config.languageBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    this.lexicon ??= this.lexiconFactory();
    const lexicon = this.lexicon;
    const config = context.config.spelling;
    const out: LanguageIssue[] = [];
    const frequency = this.frequency ?? lexicon.frequency;
    // Mot connu, ou graphie rectifiée de 1990 d'un mot connu (connaitre, évènement).
    const known = (word: string) =>
      isKnownWord(lexicon, word) || isRectifiedSpelling(word, lexicon.general);
    const lookupBudget = Math.max(
      config.maxSuggestionLookups,
      Math.ceil((config.suggestionLookupsPerThousandWords * context.document.wordCount) / 1000),
    );

    for (const match of block.text.matchAll(TOKEN)) {
      const token = match[0];
      const tokenStart = match.index;
      if (overlapsAny(context.protectedRanges, tokenStart, tokenStart + token.length)) continue;
      if (known(token)) continue;

      // « l’informatiue » : on corrige le mot, pas l'article élidé. Si le mot seul
      // est correct (« l’occasions »), c'est une question d'accord, pas d'orthographe.
      let word = token;
      let start = tokenStart;
      const elision = ELISION.exec(token);
      if (elision?.[1] && elision[2]) {
        if (known(elision[2])) continue;
        word = elision[2];
        start = tokenStart + elision[1].length;
      }

      if (!this.isCandidate(word, context)) continue;
      if (known(word)) continue;
      const capitalized = /^\p{Lu}/u.test(word);
      // Nom propre après un titre ou des initiales (« M. Kouassi », « J.-P. Bruneau »).
      if (capitalized && followsTitleOrInitial(block.text, start)) continue;
      // Mot inconnu répété dans le document : nom ou terme voulu, sauf faute
      // systématique en minuscules (vérifiée plus bas sur la correction trouvée).
      const repeated =
        (context.document.wordCounts.get(word.toLowerCase()) ?? 0) >=
        config.repeatedUnknownThreshold;
      if (repeated && capitalized) continue;
      const language = context.language.at(start);
      // Phrase en anglais : pas d'orthographe française.
      if (language === 'en') {
        const issue = this.englishIssue(block, word, start, context, lexicon, {
          capitalized,
          repeated,
          budget: lookupBudget,
        });
        if (issue) out.push(issue);
        continue;
      }
      // Majuscule en milieu de phrase : peut-être un nom propre (« Tourville »).
      const midCapital = capitalized && !isSentenceStart(block, start);
      // Anglicisme (« team », « online », « install ») : pas une faute de français,
      // sauf s'il s'agit d'un mot français dont on a oublié l'accent (« evolution »),
      // ce qui suppose une phrase sûrement française (« dissemination » est juste en
      // anglais). Un mot anglais en majuscule en milieu de phrase reste un nom.
      // Phrase sûrement française : liste historique (formes de base), pour relire un
      // texte français exactement comme avant ; phrase incertaine : toutes les formes.
      const english =
        lexicon.foreign.has(word) ||
        (language !== 'fr' &&
          lexicon.foreign instanceof EnglishWordList &&
          lexicon.foreign.hasExactOrBritish(word));
      if (english && (midCapital || language !== 'fr' || !accentedVariant(word, lexicon.general))) {
        continue;
      }
      // Féminin en « -eure » (chercheure) : jamais corrigé vers le masculin ; le
      // féminin régulier (chercheuse) est proposé s'il existe.
      const feminine = feminineVariant(word, known);
      if (feminine.kind === 'variant') {
        out.push(feminineIssue(block, word, start, matchCase(feminine.recommended, word)));
        continue;
      }

      // Cas que l'IA pourra départager : jamais un nom propre possible, un mot anglais
      // ou un mot répété (terme voulu). (Les phrases anglaises sont traitées plus haut.)
      const canAskAi = !capitalized && !english && !repeated;

      // Contrôle rapide : aucun mot du dictionnaire tout proche → pas de correction
      // sûre. Un mot très déformé (« comunikation ») peut seulement devenir un cas
      // ambigu, sans aucune remarque tant que l'IA n'a pas choisi.
      const lower = word.toLowerCase();
      if (!lexicon.general.hasCloseWord(lower)) {
        if (canAskAi) {
          const distorted = this.distortedCase(block, word, start, context, frequency);
          if (distorted) out.push(distorted);
        }
        continue;
      }
      if (!context.document.counters.has(lookupKey(lower))) {
        const used = context.document.counters.get(LOOKUPS_COUNTER) ?? 0;
        if (used >= lookupBudget) continue;
        context.document.counters.set(LOOKUPS_COUNTER, used + 1);
        context.document.counters.set(lookupKey(lower), 1);
      }

      // Suggestions sur la forme en minuscules ; seuls les mots courants sont retenus
      // (jamais un nom propre), puis la casse d'origine est rétablie.
      const candidates = lexicon.general
        .suggest(lower)
        .slice(0, config.maxCandidates)
        .filter((candidate) => acceptableCandidate(candidate, lower));
      // Mot en majuscule (peut-être un nom propre) : classement sans fréquence, et
      // nspell doit être d'accord. La fréquence ne sert qu'aux mots en minuscules.
      const ranked = capitalized
        ? rankCandidates(lower, candidates, NO_FREQUENCY)
        : rankCandidates(lower, candidates, frequency, config.frequencyWeight);
      const verdict = assessConfidence(lower, ranked, candidates[0], config, {
        useFrequency: !capitalized && frequency !== NO_FREQUENCY,
        requireAgreement: capitalized,
      });
      if (verdict.confidence === 'low' || !verdict.best) {
        // Plusieurs corrections plausibles, aucune ne se détache (« peris », « cadr ») :
        // remarque « À vérifier » sans correction, que l'IA pourra préciser.
        const options = optionsFrom(ranked, word, start, {
          maxCost: context.config.ambiguity.maxOptionCost,
          minZipf: context.config.ambiguity.minOptionZipf,
          max: context.config.ambiguity.maxOptions,
        });
        if (canAskAi && options.length > 0) {
          // Sans décision de l'IA, « À vérifier » seulement si une correction est à une
          // faute légère (accent, lettre doublée, touche voisine) : un mot plus éloigné
          // de tout mot connu est peut-être un terme du domaine (« cron »).
          const nearest = Math.min(...ranked.map((candidate) => candidate.cost));
          const fallback =
            nearest <= context.config.ambiguity.verifyMaxCost
              ? ('verify' as const)
              : ('drop' as const);
          out.push({
            rule: 'misspelling',
            category: 'spelling',
            subtype: 'misspelling',
            blockId: block.id,
            original: word,
            suggestion: null,
            explanation: explainAmbiguous(word, options),
            severity: 'minor',
            confidence: 'low',
            source: 'rules',
            relatedBlockIds: [],
            range: { start, end: start + word.length },
            ambiguity: { kind: 'spelling', options, fallback },
          });
        }
        continue;
      }
      // Majuscule en milieu de phrase : nom propre probable (« Gagnoa » → gagna,
      // « Assinie » → assainie), sauf faute légère (accent, lettre doublée :
      // « Superieur » → « Supérieur ») ou correction vers un mot très courant
      // (« Informatiue » → « Informatique »).
      if (
        midCapital &&
        (verdict.cost ?? Infinity) > config.repeatedMaxCost &&
        // (Mot en majuscule : classé sans fréquence ; on lit celle de la correction.)
        (frequency.of(verdict.best) ?? 0) < config.repeatedMinZipf
      ) {
        continue;
      }
      // Faute répétée : seulement une faute légère (accent, lettre doublée) d'un mot courant.
      if (
        repeated &&
        ((verdict.cost ?? Infinity) > config.repeatedMaxCost ||
          (verdict.zipf ?? 0) < config.repeatedMinZipf)
      ) {
        continue;
      }

      // Doute venu du contexte (nom propre possible, mot anglais, mot voulu) :
      // jamais plus qu'une suggestion.
      // Langue incertaine, ou forme féminine en « -eure » corrigée vers une autre
      // terminaison (« vainqueure » → vainqueur peut changer le genre voulu) : pas de
      // certitude non plus. « interieure » → intérieure reste une Erreur.
      const doubtful =
        midCapital ||
        english ||
        repeated ||
        language !== 'fr' ||
        (FEMININE_EURE.test(word) && !FEMININE_EURE.test(verdict.best));
      const confidence = doubtful && verdict.confidence === 'high' ? 'medium' : verdict.confidence;
      const suggestion = matchCase(verdict.best, word);
      const alternatives = verdict.alternatives.slice(0, 2).map((alt) => matchCase(alt, word));

      // Suggestion avec d'autres formes aussi proches (« heureus » → heureux ? heureuse ?) :
      // l'IA pourra choisir la bonne forme ; sans elle, la suggestion reste telle quelle.
      const ambiguity =
        canAskAi && confidence === 'medium' && alternatives.length > 0
          ? {
              kind: 'spelling' as const,
              options: [suggestion, ...alternatives].map((replacement) => ({
                start,
                end: start + word.length,
                replacement,
              })),
              fallback: 'keep' as const,
            }
          : undefined;

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
        ...(ambiguity ? { ambiguity } : {}),
      });
    }
    return out;
  }

  /**
   * Mot très déformé : les mots du dictionnaire qui se prononcent pareil (clé
   * phonétique, spelling/phonetic.ts), courants, proposés comme options. Sans
   * décision de l'IA, aucune remarque (repli « drop ») : rien ne permet de trancher.
   */
  private distortedCase(
    block: Block,
    word: string,
    start: number,
    context: AnalyzerContext,
    frequency: WordFrequency,
  ): LanguageIssue | null {
    const config = context.config.ambiguity;
    const length = [...word].length;
    if (length < config.distortedMinLength || length > config.distortedMaxLength) return null;
    if (!(frequency instanceof ZipfFrequency)) return null;
    const lower = word.toLowerCase();
    const key = `${DISTORTED_COUNTER}:${lower}`;
    if (!context.document.counters.has(key)) {
      const budget = Math.max(
        config.distortedLookups,
        Math.ceil((config.distortedLookupsPerThousandWords * context.document.wordCount) / 1000),
      );
      const used = context.document.counters.get(DISTORTED_COUNTER) ?? 0;
      if (used >= budget) return null;
      context.document.counters.set(DISTORTED_COUNTER, used + 1);
      context.document.counters.set(key, 1);
    }
    const candidates = soundsLike(lower, frequency)
      .filter((candidate) => candidate.zipf >= config.distortedMinOptionZipf)
      .map((candidate) => candidate.word);
    const ranked = rankCandidates(
      lower,
      candidates,
      frequency,
      context.config.spelling.frequencyWeight,
    );
    const options = optionsFrom(ranked, word, start, {
      maxCost: config.distortedMaxOptionCost,
      minZipf: config.distortedMinOptionZipf,
      max: config.maxOptions,
    });
    if (options.length === 0) return null;
    return {
      rule: 'misspelling',
      category: 'spelling',
      subtype: 'misspelling',
      blockId: block.id,
      original: word,
      suggestion: null,
      explanation: explainAmbiguous(word, options),
      severity: 'minor',
      confidence: 'low',
      source: 'rules',
      relatedBlockIds: [],
      range: { start, end: start + word.length },
      ambiguity: { kind: 'distorted', options, fallback: 'drop' },
    };
  }

  /**
   * Mot inconnu dans une phrase en anglais : faute anglaise évidente seulement
   * (une seule correction connue à une modification près), en Suggestion. Les noms
   * propres possibles, les mots connus en anglais et les termes répétés sont ignorés.
   */
  private englishIssue(
    block: Block,
    word: string,
    start: number,
    context: AnalyzerContext,
    lexicon: SpellingLexicon,
    facts: { capitalized: boolean; repeated: boolean; budget: number },
  ): LanguageIssue | null {
    if (facts.capitalized || facts.repeated) return null;
    const lower = word.toLowerCase();
    if (!/^[a-z]+$/.test(lower)) return null;
    // Corrections : formes exactes du dictionnaire anglais seulement. Le retrait
    // approximatif des terminaisons (`has`) accepterait « occured » ou « managment ».
    const english = lexicon.foreign;
    if (!(english instanceof EnglishWordList)) return null;
    if (english.hasExactOrBritish(lower)) return null;
    const key = `${ENGLISH_COUNTER}:${lower}`;
    if (!context.document.counters.has(key)) {
      const used = context.document.counters.get(ENGLISH_COUNTER) ?? 0;
      if (used >= facts.budget) return null;
      context.document.counters.set(ENGLISH_COUNTER, used + 1);
      context.document.counters.set(key, 1);
    }
    const corrections = englishCorrections(lower, english);
    if (corrections.length !== 1 || !corrections[0]) return null;
    const suggestion = corrections[0];
    return {
      rule: 'misspelling',
      category: 'spelling',
      subtype: 'misspelling',
      blockId: block.id,
      original: word,
      suggestion,
      explanation: `« ${word} » ne figure pas dans le dictionnaire anglais (phrase en anglais). Vouliez-vous écrire « ${suggestion} » ?`,
      severity: 'minor',
      confidence: 'medium',
      source: 'rules',
      relatedBlockIds: [],
      range: { start, end: start + word.length },
    };
  }

  /** Écarte ce qui ressemble à un sigle, un nom de produit ou un mot composé. */
  private isCandidate(word: string, context: AnalyzerContext): boolean {
    const config = context.config.spelling;
    const length = [...word].length;
    if (length < config.minWordLength || length > config.maxWordLength) return false;
    if (/[-'’]/.test(word)) return false; // mots composés : pas dans cette version
    if (/^\p{Lu}+$/u.test(word)) return false; // sigle : API, VPN, SATI
    if (/.\p{Lu}/u.test(word)) return false; // majuscule interne : GitHub, MongoDB, RESTful
    return true;
  }
}

/** Forme féminine en « -eure » employée, quand le féminin régulier est connu. */
function feminineIssue(
  block: Block,
  word: string,
  start: number,
  recommended: string,
): LanguageIssue {
  return {
    rule: 'misspelling',
    category: 'spelling',
    subtype: 'misspelling',
    blockId: block.id,
    original: word,
    suggestion: recommended,
    explanation: `« ${word} » est une forme féminine employée, absente du dictionnaire ; la forme recommandée est « ${recommended} ».`,
    severity: 'minor',
    confidence: 'medium',
    source: 'rules',
    relatedBlockIds: [],
    range: { start, end: start + word.length },
  };
}

/** Corrections proposées pour un cas ambigu : proches, assez courantes, au plus `max`. */
function optionsFrom(
  ranked: readonly RankedCandidate[],
  word: string,
  start: number,
  limits: { maxCost: number; minZipf: number; max: number },
): AmbiguityOption[] {
  return ranked
    .filter(
      (candidate) => candidate.cost <= limits.maxCost && (candidate.zipf ?? 0) >= limits.minZipf,
    )
    .slice(0, limits.max)
    .map((candidate) => ({
      start,
      end: start + word.length,
      replacement: matchCase(candidate.word, word),
    }));
}

function explainAmbiguous(word: string, options: readonly AmbiguityOption[]): string {
  const list = options.map((option) => `« ${option.replacement} »`).join(', ');
  return `« ${word} » ne figure pas dans le dictionnaire. Plusieurs corrections sont possibles (${list}) : vérifiez le mot voulu.`;
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
