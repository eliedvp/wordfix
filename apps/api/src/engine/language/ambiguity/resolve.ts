import type { Confidence } from '@wordfix/shared';
import type { AiProvider, TokenUsage } from '../../../ai/ai-provider.js';
import { neutralize, wrapDocument } from '../../formatting.js';
import { AMBIGUITY_INSTRUCTIONS } from '../../prompts/prompts.v1.js';
import { ambiguityResolutionSchema, type AmbiguityResolution } from '../../schemas.js';
import type { CandidateIssue } from '../../types.js';
import { type AmbiguityCase, type CaseOption, fallbackIssues } from './cases.js';

/**
 * Résolution des cas ambigus par l'IA, en un appel par lot.
 *
 * Règles de sécurité :
 * - l'IA ne voit que le mot, sa phrase, une information et les options du moteur ;
 * - elle ne peut que choisir une option (vérifié ici), garder le mot ou répondre
 *   « à vérifier » ; toute autre réponse est ignorée et le cas garde son repli ;
 * - une décision de l'IA n'est jamais une certitude : au mieux une Suggestion
 *   (confiance moyenne), quelle que soit la confiance annoncée par le modèle ;
 * - IA indisponible, réponse invalide : chaque cas garde sa forme sans IA.
 */

export const AMBIGUITY_SCHEMA_NAME = 'language_ambiguity';

export interface AmbiguityStats {
  cases: number;
  corrected: number;
  kept: number;
  verify: number;
  /** Décisions absentes ou invalides (option inventée, cas inconnu) : repli. */
  invalid: number;
  /** Lot entier en repli (IA indisponible, réponse hors schéma). */
  failed: string | null;
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export function buildAmbiguityInput(cases: readonly AmbiguityCase[]): string {
  const body = cases.map((entry) => {
    const options = entry.options
      .map((option) =>
        option.original.toLowerCase() === entry.original.toLowerCase()
          ? `  ${option.id}) « ${neutralize(option.replacement)} »`
          : `  ${option.id}) remplacer « ${neutralize(option.original)} » par « ${neutralize(option.replacement)} »`,
      )
      .join('\n');
    return [
      `[${entry.id}]`,
      `Mot : « ${neutralize(entry.original)} »`,
      `Phrase : « ${neutralize(entry.context)} »`,
      `Information : ${entry.info}`,
      `Options :\n${options}`,
    ].join('\n');
  });
  return wrapDocument(body.join('\n\n'));
}

export async function resolveAmbiguities(
  ai: AiProvider,
  model: string,
  cases: readonly AmbiguityCase[],
  maxOutputTokens: number,
): Promise<{ issues: CandidateIssue[]; usage: TokenUsage; stats: AmbiguityStats }> {
  const stats: AmbiguityStats = {
    cases: cases.length,
    corrected: 0,
    kept: 0,
    verify: 0,
    invalid: 0,
    failed: null,
  };
  if (cases.length === 0) return { issues: [], usage: NO_USAGE, stats };

  let data: AmbiguityResolution;
  let usage: TokenUsage;
  try {
    const result = await ai.generateStructured({
      model,
      instructions: AMBIGUITY_INSTRUCTIONS,
      input: buildAmbiguityInput(cases),
      schema: ambiguityResolutionSchema,
      schemaName: AMBIGUITY_SCHEMA_NAME,
      maxOutputTokens,
    });
    data = result.data;
    usage = result.usage;
  } catch (error) {
    stats.failed = error instanceof Error && 'kind' in error ? String(error.kind) : 'unexpected';
    return { issues: cases.flatMap(fallbackIssues), usage: NO_USAGE, stats };
  }

  const decisions = new Map<string, AmbiguityResolution['decisions'][number]>();
  for (const decision of data.decisions) {
    if (!decisions.has(decision.caseId)) decisions.set(decision.caseId, decision);
  }

  const issues: CandidateIssue[] = [];
  for (const entry of cases) {
    const decision = decisions.get(entry.id);
    const outcome = decide(entry, decision);
    stats[outcome.stat]++;
    issues.push(...outcome.issues);
  }
  return { issues, usage, stats };
}

type Decision = AmbiguityResolution['decisions'][number] | undefined;

function decide(
  entry: AmbiguityCase,
  decision: Decision,
): { stat: 'corrected' | 'kept' | 'verify' | 'invalid'; issues: CandidateIssue[] } {
  if (!decision) return { stat: 'invalid', issues: fallbackIssues(entry) };

  if (decision.decision === 'correct' && decision.confidence !== 'low') {
    const option = findOption(entry.options, decision.correction);
    if (!option) return { stat: 'invalid', issues: fallbackIssues(entry) };
    return {
      stat: 'corrected',
      issues: occurrences(entry, (shift, blockId) =>
        corrected(entry, option, shift, blockId, decision),
      ),
    };
  }

  if (decision.decision === 'keep') {
    // Le mot écrit est correct d'après l'IA. Un mot inconnu (nom, terme, mot rare)
    // ou une confusion possible disparaît ; une faute de grammaire détectée par
    // Grammalecte n'est jamais effacée par l'IA : elle devient « À vérifier ».
    if (entry.kind === 'grammar') {
      return {
        stat: 'kept',
        issues: occurrences(entry, (shift, blockId) => toVerify(entry, shift, blockId, decision)),
      };
    }
    return { stat: 'kept', issues: [] };
  }

  // « verify », ou « correct » avec une confiance faible.
  if (entry.kind === 'confusion') return { stat: 'verify', issues: [] };
  return {
    stat: 'verify',
    issues: occurrences(entry, (shift, blockId) => toVerify(entry, shift, blockId, decision)),
  };
}

/** Option choisie : recopiée à l'identique (casse et apostrophes tolérées). */
function findOption(options: readonly CaseOption[], correction: string | null): CaseOption | null {
  if (!correction) return null;
  const norm = (text: string) => text.trim().toLocaleLowerCase('fr').replace(/'/g, '’');
  const wanted = norm(correction);
  return options.find((option) => norm(option.replacement) === wanted) ?? null;
}

/** Applique une décision au cas et à ses occurrences identiques. */
function occurrences(
  entry: AmbiguityCase,
  build: (shift: number, blockId: string) => CandidateIssue,
): CandidateIssue[] {
  return [
    build(0, entry.blockId),
    ...entry.duplicates.map((duplicate) => build(duplicate.shift, duplicate.blockId)),
  ];
}

const AI_CONFIDENCE: Confidence = 'medium';

function corrected(
  entry: AmbiguityCase,
  option: CaseOption,
  shift: number,
  blockId: string,
  decision: NonNullable<Decision>,
): CandidateIssue {
  const why = cleanJustification(decision.justification);
  const head =
    entry.kind === 'confusion'
      ? `D’après la phrase, « ${option.replacement} » semble être le mot voulu, et non « ${option.original} ».`
      : entry.kind === 'grammar'
        ? `${entry.info} D’après la phrase, la correction « ${option.replacement} » semble la plus adaptée.`
        : `« ${entry.original} » ne figure pas dans le dictionnaire. D’après la phrase, « ${option.replacement} » semble être le mot voulu.`;
  return {
    category: entry.issue.category,
    subtype: entry.issue.subtype,
    blockId,
    original: option.original,
    suggestion: option.replacement,
    explanation: why ? `${head} ${why}` : head,
    severity: 'minor',
    // Jamais une certitude, même si l'IA se dit sûre : au mieux une Suggestion.
    confidence: AI_CONFIDENCE,
    source: 'verify',
    relatedBlockIds: [],
    range: { start: option.start + shift, end: option.end + shift },
  };
}

function toVerify(
  entry: AmbiguityCase,
  shift: number,
  blockId: string,
  decision: NonNullable<Decision>,
): CandidateIssue {
  const why = cleanJustification(decision.justification);
  const list = entry.options.map((option) => `« ${option.replacement} »`).join(', ');
  const head =
    entry.kind === 'grammar'
      ? `${entry.info} Le contexte ne permet pas de choisir la correction (${list}) : vérifiez ce passage.`
      : `« ${entry.original} » ne figure pas dans le dictionnaire et le contexte ne permet pas de choisir la correction (${list}) : vérifiez le mot voulu.`;
  const range = entry.issue.range ?? { start: 0, end: 0 };
  return {
    ...entry.issue,
    blockId,
    suggestion: null,
    explanation: why ? `${head} ${why}` : head,
    severity: 'minor',
    confidence: 'low',
    source: 'verify',
    range: { start: range.start + shift, end: range.end + shift },
  };
}

/** Justification du modèle : une phrase, sans balises, bornée. */
function cleanJustification(text: string): string {
  const clean = text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean) return '';
  return /[.!?…]$/.test(clean) ? clean : `${clean}.`;
}
