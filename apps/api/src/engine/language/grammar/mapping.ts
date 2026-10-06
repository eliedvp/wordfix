import type { Block, Confidence } from '@wordfix/shared';
import type { GrammarConfig } from '../config.js';
import { TECHNICAL_TERMS } from '../spelling/technical-terms.js';
import { isSentenceStart, overlapsAny } from '../text.js';
import type { AnalyzerContext, LanguageIssue } from '../types.js';
import type { GrammalecteError } from './grammalecte-client.js';

/**
 * Transformation des erreurs brutes de Grammalecte en remarques WordFix.
 *
 * Politique (faux positifs à éviter en priorité) :
 * - seules les règles de grammaire sont retenues (accords, conjugaison,
 *   confusions, modes, locutions) : jamais l'orthographe (SPELL), la typographie
 *   (apostrophes droites, espaces insécables…) ni le style ;
 * - un nom propre, un sigle ou un terme technique n'est jamais signalé seul ;
 * - une « correction » qui ne change que la typographie est écartée ;
 * - la confiance décide de la nature (politique centrale, nature-policy.ts) :
 *   élevée + correction → Erreur ; moyenne → Suggestion ; sans correction → À vérifier ;
 * - un même problème n'est signalé qu'une fois (même zone, même sous-type ; ou
 *   corrections alternatives d'une même règle, regroupées en une remarque).
 */

const TECHNICAL = new Set(TECHNICAL_TERMS.map((term) => term.toLowerCase()));
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function mapGrammarErrors(
  block: Block,
  errors: readonly GrammalecteError[],
  context: AnalyzerContext,
): LanguageIssue[] {
  const config = context.config.grammar;
  const ambiguous = new Set(config.ambiguousWords.map(normalizeWord));
  const kept: { error: GrammalecteError; original: string; suggestions: string[] }[] = [];

  for (const error of errors) {
    if (!(error.type in config.types)) continue; // SPELL, typographie, style, sans type
    const { start, end } = error;
    if (!(Number.isInteger(start) && Number.isInteger(end))) continue;
    if (start < 0 || end > block.text.length || start >= end) continue;
    const original = block.text.slice(start, end);
    if (original.trim().length === 0) continue;
    if (overlapsAny(context.protectedRanges, start, end)) continue;

    const suggestions = usefulSuggestions(original, error.suggestions);
    // Toutes les corrections ne changent que la typographie : pas une faute de grammaire.
    if (error.suggestions.length > 0 && suggestions.length === 0) continue;
    if (protectsName(block, start, original, suggestions.length > 0)) continue;
    kept.push({ error, original, suggestions });
  }

  // Corrections alternatives d'une même règle (« Ils a » → « ont » ou « Il ») :
  // une seule remarque, sur la première, qui cite l'autre possibilité.
  const groups = new Map<string, typeof kept>();
  for (const entry of kept) {
    const key = `${ruleGroup(entry.error.ruleId)}#${sentenceIndex(block, entry.error.start)}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const out: LanguageIssue[] = [];
  const seen = new Set<string>();
  for (const group of groups.values()) {
    const [primary, ...alternatives] = [...group].sort(
      (a, b) => actionIndex(a.error.ruleId) - actionIndex(b.error.ruleId),
    );
    if (!primary) continue;
    const { error, original, suggestions } = primary;
    const subtype = config.types[error.type];
    if (!subtype) continue;
    const key = `${error.start}:${error.end}:${subtype}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const confidence = assessConfidence(block, primary, alternatives.length > 0, config, ambiguous);
    out.push({
      rule: 'grammar',
      category: 'grammar',
      subtype,
      blockId: block.id,
      original,
      suggestion: suggestions[0] ?? null,
      explanation: explain(error.message, suggestions, alternatives, confidence),
      severity: confidence === 'high' ? 'major' : 'minor',
      confidence,
      source: 'rules',
      relatedBlockIds: [],
      range: { start: error.start, end: error.end },
    });
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}

function assessConfidence(
  block: Block,
  entry: { error: GrammalecteError; original: string; suggestions: string[] },
  hasAlternatives: boolean,
  config: GrammarConfig,
  ambiguous: ReadonlySet<string>,
): Confidence {
  if (entry.suggestions.length === 0) return 'low';
  if (
    entry.suggestions.length === 1 &&
    !hasAlternatives &&
    config.highConfidenceTypes.includes(entry.error.type) &&
    !touchesAmbiguousWord(block, entry.error.start, entry.original, ambiguous) &&
    !followsNameLike(block, entry.error.start)
  ) {
    return 'high';
  }
  return 'medium';
}

/**
 * L'erreur porte-t-elle sur un homophone grammatical, ou le suit-elle directement ?
 * « son satisfaisants » : la faute est peut-être « son » (pour « sont »), pas l'adjectif.
 */
function touchesAmbiguousWord(
  block: Block,
  start: number,
  original: string,
  ambiguous: ReadonlySet<string>,
): boolean {
  const own = original.match(WORD) ?? [];
  if (own.some((word) => ambiguous.has(normalizeWord(word)))) return true;
  const sentence = block.sentences.find((s) => s.start <= start && start < s.end);
  const before = block.text.slice(sentence?.start ?? 0, start).match(WORD) ?? [];
  const previous = before.at(-1);
  return previous !== undefined && ambiguous.has(normalizeWord(previous));
}

/**
 * L'erreur suit-elle directement un nom propre, un sigle ou un nombre ? L'accord
 * se fait peut-être avec un nom plus éloigné (« une exposition réalisée par le
 * CNRS intitulée », « la version Crown 602 fabriquée ») : Grammalecte accorde
 * avec le mot le plus proche, ce n'est donc jamais une certitude.
 */
function followsNameLike(block: Block, start: number): boolean {
  const sentence = block.sentences.find((s) => s.start <= start && start < s.end);
  const before = [...block.text.slice(sentence?.start ?? 0, start).matchAll(WORD)];
  const previous = before.at(-1);
  if (!previous) return false;
  return isNameLike(block, (sentence?.start ?? 0) + previous.index, previous[0]);
}

/** Corrections qui changent réellement le texte (pas seulement apostrophes, espaces ou tirets). */
function usefulSuggestions(original: string, suggestions: readonly string[]): string[] {
  const reference = normalizeTypography(original);
  const out: string[] = [];
  for (const suggestion of suggestions) {
    if (suggestion.trim().length === 0) continue;
    if (normalizeTypography(suggestion) === reference) continue;
    if (!out.includes(suggestion)) out.push(suggestion);
  }
  return out;
}

function normalizeTypography(text: string): string {
  return text
    .replace(/[’‘ʼ`´]/g, "'")
    .replace(/[\u00a0\u202f\u2009\s]+/g, ' ')
    .replace(/ ?' ?/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .trim();
}

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase('fr').replace(/['ʼ`´]/g, '’');
}

/**
 * Nom propre, sigle ou terme technique à protéger :
 * - le passage signalé est un seul mot qui ressemble à un nom (Kouassi, GitHub,
 *   VLAN, React en milieu de phrase, mot avec chiffre, terme technique connu) ;
 * - ou Grammalecte ne propose aucune correction et le passage contient un tel mot.
 */
function protectsName(
  block: Block,
  start: number,
  original: string,
  hasSuggestion: boolean,
): boolean {
  const words = [...original.matchAll(WORD)];
  const nameLike = words.filter((match) => isNameLike(block, start + match.index, match[0]));
  if (words.length === 1 && nameLike.length === 1) return true;
  return !hasSuggestion && nameLike.length > 0;
}

function isNameLike(block: Block, position: number, word: string): boolean {
  if (/\p{N}/u.test(word)) return true; // H2O, IPv6, 4G
  if (/^\p{Lu}{2,}$/u.test(word)) return true; // sigle : REST, VLAN, DHCP
  if (/.\p{Lu}/u.test(word)) return true; // majuscule interne : GitHub, TypeScript, RESTful
  if (TECHNICAL.has(word.toLowerCase())) return true;
  // Majuscule en milieu de phrase : nom propre (Kouassi, Ouattara, React).
  return /^\p{Lu}/u.test(word) && !isSentenceStart(block, position);
}

function sentenceIndex(block: Block, position: number): number {
  return block.sentences.findIndex((s) => s.start <= position && position < s.end);
}

/** « g2__conj_ils__b1_a2_1 » → « g2__conj_ils__b1 » (une même règle, plusieurs actions). */
function ruleGroup(ruleId: string): string {
  return ruleId.replace(/_a\d+_\d+$/, '') || ruleId;
}

function actionIndex(ruleId: string): number {
  return Number(/_a(\d+)_\d+$/.exec(ruleId)?.[1] ?? 0);
}

function explain(
  message: string,
  suggestions: readonly string[],
  alternatives: readonly { original: string; suggestions: string[] }[],
  confidence: Confidence,
): string {
  const parts = [message.replace(/\s+/g, ' ').trim() || 'Construction grammaticale à vérifier.'];
  const others = suggestions.slice(1, 3);
  if (others.length > 0) {
    parts.push(`Autres possibilités : ${others.map((s) => `« ${s} »`).join(', ')}.`);
  }
  for (const alternative of alternatives.slice(0, 2)) {
    const fix = alternative.suggestions[0];
    if (fix) parts.push(`Autre correction possible : « ${alternative.original} » → « ${fix} ».`);
  }
  if (confidence === 'medium') parts.push('À confirmer selon le sens de la phrase.');
  if (confidence === 'low') parts.push('Vérifiez cette construction.');
  return parts.join(' ');
}
