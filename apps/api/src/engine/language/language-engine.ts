import type { BlockKind, IssueCategory } from '@wordfix/shared';
import { confidenceRank } from '../postprocess/nature-policy.js';
import { AccentConfusionAnalyzer } from './analyzers/accent-confusion.analyzer.js';
import { GrammarAnalyzer } from './analyzers/grammar.analyzer.js';
import { RepetitionAnalyzer } from './analyzers/repetition.analyzer.js';
import { SentenceAnalyzer } from './analyzers/sentence.analyzer.js';
import { SpellingAnalyzer } from './analyzers/spelling.analyzer.js';
import { TypographyAnalyzer } from './analyzers/typography.analyzer.js';
import {
  LANGUAGE_ENGINE_CONFIG,
  LANGUAGE_RULE_IDS,
  type LanguageEngineConfig,
  type LanguageRuleId,
} from './config.js';
import { detectBlockLanguage, detectDocumentLanguage, type LanguageLexicon } from './detection.js';
import { peekSpellingDictionaries } from './spelling/dictionaries.js';
import { findProtectedRanges, WORD_PATTERN } from './text.js';
import type {
  AnalyzerContext,
  DocumentContext,
  LanguageAnalyzer,
  LanguageInput,
  LanguageIssue,
} from './types.js';

/**
 * WordFix Language Engine : analyse linguistique déterministe et locale.
 *
 * Il parcourt une fois les paragraphes du document extrait, confie chacun aux
 * analyseurs qui l'acceptent, plafonne chaque règle, retire ses propres doublons
 * et renvoie des problèmes au format commun du moteur (source « rules »).
 * Aucun appel réseau, aucun état partagé : même entrée, même sortie.
 */
export class LanguageEngine {
  private readonly kinds: Map<LanguageAnalyzer, ReadonlySet<BlockKind>>;

  constructor(
    private readonly analyzers: readonly LanguageAnalyzer[],
    private readonly config: LanguageEngineConfig = LANGUAGE_ENGINE_CONFIG,
  ) {
    this.kinds = new Map(analyzers.map((a) => [a, new Set(a.blockKinds(config))]));
  }

  analyze(input: LanguageInput): LanguageIssue[] {
    const counts = new Map<LanguageRuleId, number>();
    const out: LanguageIssue[] = [];
    const hasDroppedInlineContent = input.meta.skipped.equations > 0;
    const caps = documentCaps(this.config, input.meta.wordCount);
    const languageKinds = new Set(this.config.languageBlockKinds);
    const document: DocumentContext = {
      wordCount: input.meta.wordCount,
      wordCounts: countWords(input, this.config),
      counters: new Map(),
      grammar: input.grammar ?? null,
      language: detectDocumentLanguage(
        input.blocks.filter((block) => languageKinds.has(block.kind)),
        this.config.language,
      ),
    };
    const lexicon = languageLexicon();

    for (const block of input.blocks) {
      if (block.text.trim().length === 0) continue;
      const accepting = this.analyzers.filter((a) => this.kinds.get(a)?.has(block.kind));
      if (accepting.length === 0) continue;

      const context: AnalyzerContext = {
        config: this.config,
        protectedRanges: findProtectedRanges(block.text),
        hasDroppedInlineContent,
        document,
        language: detectBlockLanguage(block, document.language, this.config.language, lexicon),
      };
      const found: LanguageIssue[] = [];
      for (const analyzer of accepting) {
        for (const issue of analyzer.analyze(block, context)) {
          if (!isValidRange(issue, block.text.length)) continue;
          found.push(issue);
        }
      }

      for (const issue of dedupe(found)) {
        const count = counts.get(issue.rule) ?? 0;
        if (count >= caps[issue.rule]) continue;
        counts.set(issue.rule, count + 1);
        out.push(issue);
      }
    }
    return out;
  }
}

/** Moteur avec les analyseurs disponibles, dans l'ordre de priorité. */
export function createLanguageEngine(config: LanguageEngineConfig = LANGUAGE_ENGINE_CONFIG) {
  return new LanguageEngine(
    [
      new RepetitionAnalyzer(),
      new SpellingAnalyzer(),
      new GrammarAnalyzer(),
      new AccentConfusionAnalyzer(),
      new TypographyAnalyzer(),
      new SentenceAnalyzer(),
    ],
    config,
  );
}

/**
 * Dictionnaires français et anglais comme indice secondaire de langue, s'ils sont
 * chargés (toujours le cas dans le worker, qui les attend avant chaque analyse).
 */
function languageLexicon(): LanguageLexicon | null {
  const dictionaries = peekSpellingDictionaries();
  if (!dictionaries) return null;
  return {
    isFrench: (word) => dictionaries.french.isCorrect(word),
    isEnglish: (word) => dictionaries.english.has(word),
  };
}

/** Plafond de chaque règle pour ce document : le minimum, ou proportionnel à la longueur. */
export function documentCaps(
  config: LanguageEngineConfig,
  wordCount: number,
): Record<LanguageRuleId, number> {
  const caps = {} as Record<LanguageRuleId, number>;
  for (const rule of LANGUAGE_RULE_IDS) {
    const proportional = Math.ceil((config.capsPerThousandWords[rule] * wordCount) / 1000);
    caps[rule] = Math.max(config.caps[rule], proportional);
  }
  return caps;
}

/** Occurrences de chaque mot (en minuscules) dans les paragraphes relus : un seul passage. */
function countWords(input: LanguageInput, config: LanguageEngineConfig): Map<string, number> {
  const kinds = new Set(config.languageBlockKinds);
  const counts = new Map<string, number>();
  for (const block of input.blocks) {
    if (!kinds.has(block.kind)) continue;
    for (const match of block.text.matchAll(WORD_PATTERN)) {
      const word = match[0].toLowerCase();
      counts.set(word, (counts.get(word) ?? 0) + 1);
      // « l’informatique » compte aussi pour « informatique ».
      const elided = /^[\p{L}]{1,7}['’](.+)$/u.exec(word)?.[1];
      if (elided) counts.set(elided, (counts.get(elided) ?? 0) + 1);
    }
  }
  return counts;
}

function isValidRange(issue: LanguageIssue, length: number): boolean {
  return issue.range.start >= 0 && issue.range.end <= length && issue.range.start < issue.range.end;
}

/** Les fautes de langue forment une même famille (comme dans la finalisation). */
function family(category: IssueCategory, subtype: string): string {
  return category === 'spelling' || category === 'grammar' || category === 'punctuation'
    ? 'language'
    : `${category}:${subtype}`;
}

/**
 * Dans un paragraphe, deux problèmes de la même famille qui se chevauchent n'en
 * font qu'un : on garde le plus sûr, puis le premier trouvé. Nombre de problèmes
 * par paragraphe faible : la comparaison deux à deux reste négligeable.
 */
function dedupe(issues: LanguageIssue[]): LanguageIssue[] {
  const ordered = issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (a, b) =>
        confidenceRank(b.issue.confidence) - confidenceRank(a.issue.confidence) ||
        a.index - b.index,
    );
  const kept: { issue: LanguageIssue; index: number }[] = [];
  for (const entry of ordered) {
    const { issue } = entry;
    const duplicate = kept.some(
      ({ issue: other }) =>
        family(other.category, other.subtype) === family(issue.category, issue.subtype) &&
        other.range.start < issue.range.end &&
        issue.range.start < other.range.end,
    );
    if (!duplicate) kept.push(entry);
  }
  return kept.sort((a, b) => a.issue.range.start - b.issue.range.start).map((e) => e.issue);
}
