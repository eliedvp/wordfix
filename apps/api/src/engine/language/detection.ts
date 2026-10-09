import type { Block } from '@wordfix/shared';

/**
 * Langue de chaque passage d'un document (français, anglais ou incertain), pour
 * que les règles propres au français (orthographe, grammaire, confusions
 * d'accents) ne s'appliquent pas à un résumé, une citation ou un paragraphe en
 * anglais.
 *
 * Détection locale, déterministe et linéaire, sans modèle ni réseau :
 * 1. indices forts : mots-outils propres à chaque langue (« les », « dans » /
 *    « the », « which »), élisions françaises (« l’ », « qu’ »), contractions
 *    anglaises (« it’s », « don’t »), lettres accentuées ;
 * 2. à défaut (passage court, liste de mots-clés) : mots connus d'un seul des deux
 *    dictionnaires, si ceux-ci sont chargés.
 * Les noms propres (mots en majuscule hors début de phrase : « Ethiopian Airlines »,
 * « The Pogues ») et les sigles (« ET », « CNRS ») ne renseignent pas sur la langue
 * de la phrase : ils ne comptent pas.
 * La décision se prend par phrase ; une phrase trop courte pour trancher prend la
 * langue de son paragraphe, puis celle du document (le français par défaut).
 */

export type SegmentLanguage = 'fr' | 'en' | 'uncertain';

export interface LanguageDetectionConfig {
  /** Indices nécessaires pour trancher (sinon : langue du paragraphe ou du document). */
  minEvidence: number;
  /** Une langue l'emporte si ses indices valent au moins ce multiple de ceux de l'autre. */
  dominanceRatio: number;
  /** Poids d'un mot contenant une lettre accentuée (indice plus faible qu'un mot-outil). */
  accentWeight: number;
}

/** Dictionnaires, s'ils sont chargés : indice secondaire pour les passages sans mots-outils. */
export interface LanguageLexicon {
  isFrench(word: string): boolean;
  isEnglish(word: string): boolean;
}

/** Langue de chaque position d'un paragraphe. */
export interface LanguageMap {
  /** Langue du paragraphe entier. */
  readonly block: SegmentLanguage;
  /** Langue de la phrase qui contient `position`. */
  at(position: number): SegmentLanguage;
}

/** Paragraphe entièrement en français (tests, contextes sans détection). */
export const FRENCH_TEXT: LanguageMap = { block: 'fr', at: () => 'fr' };

/** Mots-outils français absents de l'anglais courant (ni « a », ni « on », ni « plus »…). */
const FRENCH_WORDS = new Set(
  (
    'le la les de des du et est un une pour que qui dans au aux sur par avec ce cette ces cet ' +
    'il elle ils elles nous vous sont pas ont été ou mais sa ses leur leurs se ne comme être ' +
    'avoir entre très aussi donc dont où sous sans chez après avant tout tous toute toutes cela ' +
    'ainsi lors selon depuis également notre nos votre vos je tu lui était étaient sera peut ' +
    'faire fait été dès vers afin puis quand alors car même déjà encore plusieurs chaque'
  ).split(' '),
);

/** Mots-outils anglais absents du français courant (ni « as », ni « or », ni « an »…). */
const ENGLISH_WORDS = new Set(
  (
    'the of and to in is that for with are this by be from it which was were have has had not ' +
    'their its can will these those been also more at we our they them such between into than ' +
    'there would should could may who what when where how why he she his her you your about ' +
    'after before through during while because however both each other only over under any ' +
    'all some most many being does did do if so then just very my us upon within without ' +
    'across among against since until whether whose'
  ).split(' '),
);

const WORD = /\p{L}+(?:['’]\p{L}+)*/gu;
const FRENCH_ELISION = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu)['’]\p{L}/iu;
const ENGLISH_CONTRACTION = /\p{L}['’](?:s|t|re|ve|ll|d|m)$/iu;
const ACCENTED = /[àâäéèêëîïôöùûüÿçœæ]/iu;
/** Texte qui précède un début de phrase : rien, ou une fin de phrase (guillemets compris). */
const SENTENCE_START = /(?:^|[.!?…:]\s*)[\s«“"'(]*$/u;

interface Evidence {
  fr: number;
  en: number;
  /** Mots inconnus des mots-outils, gardés pour l'indice secondaire (dictionnaires). */
  content: string[];
}

function evidenceOf(text: string, config: LanguageDetectionConfig): Evidence {
  const evidence: Evidence = { fr: 0, en: 0, content: [] };
  for (const match of text.matchAll(WORD)) {
    const token = match[0];
    // Sigle ou mot en capitales (« ET », « AITA ») : aucun indice.
    if (token.length >= 2 && /^\p{Lu}+$/u.test(token)) continue;
    // Majuscule ailleurs qu'en tête de phrase : élément d'un nom propre (« The
    // Cranberries », « Le Monde »), pas un indice de langue.
    if (/^\p{Lu}/u.test(token) && !SENTENCE_START.test(text.slice(0, match.index))) continue;
    const lower = token.toLowerCase();
    if (FRENCH_ELISION.test(lower)) {
      evidence.fr++;
      continue;
    }
    if (ENGLISH_CONTRACTION.test(lower)) {
      evidence.en++;
      continue;
    }
    if (FRENCH_WORDS.has(lower)) evidence.fr++;
    else if (ENGLISH_WORDS.has(lower)) evidence.en++;
    else {
      if (ACCENTED.test(lower)) evidence.fr += config.accentWeight;
      if (lower.length >= 3) evidence.content.push(lower);
    }
  }
  return evidence;
}

function decide(
  evidence: Evidence,
  config: LanguageDetectionConfig,
  lexicon: LanguageLexicon | null,
): SegmentLanguage | null {
  let { fr, en } = evidence;
  // Peu de mots-outils (titre, mots-clés) : mots connus d'un seul dictionnaire.
  if (fr + en < config.minEvidence && lexicon) {
    for (const word of evidence.content) {
      const french = lexicon.isFrench(word);
      const english = lexicon.isEnglish(word);
      if (french && !english) fr++;
      else if (english && !french) en++;
    }
  }
  if (fr + en < config.minEvidence) return null;
  if (en >= config.minEvidence && en >= fr * config.dominanceRatio) return 'en';
  if (fr >= config.minEvidence && fr >= en * config.dominanceRatio) return 'fr';
  return 'uncertain';
}

/** Langue dominante du document : anglais seulement s'il domine nettement, sinon français. */
export function detectDocumentLanguage(
  blocks: readonly Pick<Block, 'text'>[],
  config: LanguageDetectionConfig,
): 'fr' | 'en' {
  let fr = 0;
  let en = 0;
  for (const block of blocks) {
    const evidence = evidenceOf(block.text, config);
    fr += evidence.fr;
    en += evidence.en;
  }
  return en >= config.minEvidence && en >= fr * config.dominanceRatio ? 'en' : 'fr';
}

/** Langue de chaque phrase d'un paragraphe (repli : paragraphe, puis document). */
export function detectBlockLanguage(
  block: Pick<Block, 'text' | 'sentences'>,
  documentLanguage: 'fr' | 'en',
  config: LanguageDetectionConfig,
  lexicon: LanguageLexicon | null = null,
): LanguageMap {
  const blockLanguage = decide(evidenceOf(block.text, config), config, lexicon) ?? documentLanguage;
  const sentences = block.sentences.length > 1 ? block.sentences : [];
  const perSentence = sentences.map((sentence) => ({
    start: sentence.start,
    end: sentence.end,
    language:
      decide(evidenceOf(block.text.slice(sentence.start, sentence.end), config), config, lexicon) ??
      blockLanguage,
  }));
  return {
    block: blockLanguage,
    at(position: number) {
      return (
        perSentence.find((s) => s.start <= position && position < s.end)?.language ?? blockLanguage
      );
    },
  };
}
