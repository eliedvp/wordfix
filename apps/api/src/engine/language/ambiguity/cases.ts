import type { Block, DocumentModel } from '@wordfix/shared';
import type { CandidateIssue } from '../../types.js';
import type { AmbiguityConfig } from '../config.js';
import type { AmbiguityFallback, AmbiguityKind } from './types.js';

/**
 * Préparation des cas ambigus pour l'IA : extraction depuis les remarques du
 * moteur, contexte minimal (la phrase du mot, tronquée), déduplication, budget.
 * Aucun appel réseau ici.
 */

export interface CaseOption {
  /** Identifiant court transmis à l'IA (« a », « b »…). */
  id: string;
  start: number;
  end: number;
  /** Texte remplacé (le mot, ou un autre mot pour une correction alternative). */
  original: string;
  replacement: string;
}

/** Autre occurrence identique (même mot, même phrase) : même décision, jamais renvoyée. */
export interface CaseOccurrence {
  blockId: string;
  shift: number;
  issue: CandidateIssue;
}

export interface AmbiguityCase {
  id: string;
  kind: AmbiguityKind;
  blockId: string;
  original: string;
  options: CaseOption[];
  /** Phrase (ou fenêtre de la phrase) qui contient le mot. */
  context: string;
  /** Information linguistique utile, en une phrase. */
  info: string;
  fallback: AmbiguityFallback;
  /** Remarque déterministe (forme « sans IA » du cas). */
  issue: CandidateIssue;
  duplicates: CaseOccurrence[];
}

const PRIORITY: Record<AmbiguityKind, number> = {
  spelling: 0,
  distorted: 1,
  grammar: 2,
  confusion: 3,
};

const INFO: Record<AmbiguityKind, string> = {
  spelling: 'Mot absent du dictionnaire ; plusieurs corrections proches.',
  distorted: 'Mot absent du dictionnaire, très déformé ; corrections plus éloignées.',
  confusion:
    'Mot qui existe, mais une variante qui ne diffère que par les accents est beaucoup plus courante.',
  grammar: 'Faute de grammaire probable ; plusieurs corrections possibles.',
};

/** Sépare les remarques ordinaires des cas ambigus (dédupliqués). */
export function collectAmbiguities(
  candidates: readonly CandidateIssue[],
  model: Pick<DocumentModel, 'blocks'>,
  config: AmbiguityConfig,
): { direct: CandidateIssue[]; cases: AmbiguityCase[] } {
  const blocks = new Map(model.blocks.map((block) => [block.id, block]));
  const direct: CandidateIssue[] = [];
  const cases: AmbiguityCase[] = [];
  const byKey = new Map<string, AmbiguityCase>();

  for (const candidate of candidates) {
    const ambiguity = candidate.ambiguity;
    const block = blocks.get(candidate.blockId);
    const range = candidate.range;
    if (!ambiguity || !block || !range || ambiguity.options.length === 0) {
      if (ambiguity) {
        const fallback = withoutAmbiguity(candidate);
        if (ambiguity.fallback !== 'drop') direct.push(fallback);
      } else {
        direct.push(candidate);
      }
      continue;
    }
    const issue = withoutAmbiguity(candidate);
    const context = contextOf(block, range.start, range.end, config.ai.maxContextChars);
    const original = block.text.slice(range.start, range.end);
    const key = `${ambiguity.kind}|${original.toLowerCase()}|${context.text}`;
    const existing = byKey.get(key);
    if (existing) {
      // Même mot dans la même phrase (paragraphe recopié) : une seule question.
      existing.duplicates.push({
        blockId: block.id,
        shift: range.start - (existing.issue.range?.start ?? 0),
        issue,
      });
      continue;
    }
    const options = ambiguity.options.map((option, index) => ({
      id: String.fromCharCode(97 + index),
      start: option.start,
      end: option.end,
      original: block.text.slice(option.start, option.end),
      replacement: option.replacement,
    }));
    const entry: AmbiguityCase = {
      id: `c${cases.length + 1}`,
      kind: ambiguity.kind,
      blockId: block.id,
      original,
      options,
      context: context.text,
      info:
        ambiguity.kind === 'grammar' ? firstSentence(candidate.explanation) : INFO[ambiguity.kind],
      fallback: ambiguity.fallback,
      issue,
      duplicates: [],
    };
    byKey.set(key, entry);
    cases.push(entry);
  }
  return { direct, cases };
}

/**
 * Budget strict : au plus `maxBatches` lots de `maxCasesPerBatch` cas, les cas les
 * plus utiles d'abord (mots inconnus, puis mots déformés, grammaire, accents). Les
 * cas restants gardent leur forme sans IA.
 */
export function planBatches(
  cases: readonly AmbiguityCase[],
  budget: { maxBatches: number; maxCasesPerBatch: number },
): { batches: AmbiguityCase[][]; overflow: AmbiguityCase[] } {
  const ordered = [...cases].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  const capacity = Math.max(0, budget.maxBatches) * Math.max(0, budget.maxCasesPerBatch);
  const sent = ordered.slice(0, capacity);
  const overflow = ordered.slice(capacity);
  const batches: AmbiguityCase[][] = [];
  for (let i = 0; i < sent.length; i += budget.maxCasesPerBatch) {
    batches.push(sent.slice(i, i + budget.maxCasesPerBatch));
  }
  return { batches, overflow };
}

/** Remarques d'un cas resté sans décision de l'IA (repli). */
export function fallbackIssues(entry: AmbiguityCase): CandidateIssue[] {
  if (entry.fallback === 'drop') return [];
  return [entry.issue, ...entry.duplicates.map((duplicate) => duplicate.issue)];
}

function withoutAmbiguity(candidate: CandidateIssue): CandidateIssue {
  const rest = { ...candidate };
  delete rest.ambiguity;
  return rest;
}

/** La phrase du mot, réduite à une fenêtre autour de lui si elle est trop longue. */
export function contextOf(
  block: Block,
  start: number,
  end: number,
  maxChars: number,
): { text: string } {
  const sentence = block.sentences.find((s) => s.start <= start && start < s.end);
  let from = sentence?.start ?? 0;
  let to = sentence?.end ?? block.text.length;
  // Une phrase très courte (« M. ») : on prend le paragraphe autour.
  if (to - from < 40) {
    from = Math.max(0, start - maxChars / 2);
    to = Math.min(block.text.length, end + maxChars / 2);
  }
  if (to - from > maxChars) {
    const half = Math.floor((maxChars - (end - start)) / 2);
    from = Math.max(from, start - half);
    to = Math.min(to, end + half);
  }
  // Coupe aux limites de mots.
  while (from > 0 && from < start && /\S/.test(block.text[from - 1] ?? '')) from++;
  while (to < block.text.length && to > end && /\S/.test(block.text[to] ?? '')) to--;
  const prefix = from > (sentence?.start ?? 0) ? '…' : '';
  const suffix = to < (sentence?.end ?? block.text.length) ? '…' : '';
  return { text: `${prefix}${block.text.slice(from, to).trim()}${suffix}` };
}

function firstSentence(text: string): string {
  const sentence = /^.{1,200}?[.!?](?:\s|$)/su.exec(text)?.[0] ?? text.slice(0, 200);
  return sentence.trim();
}
