import type { Block } from '@wordfix/shared';
import { getSpellingDictionaries } from '../spelling/dictionaries.js';
import type { WordFrequency } from '../spelling/frequency.js';
import { TECHNICAL_TERMS } from '../spelling/technical-terms.js';
import { overlapsAny } from '../text.js';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';

/**
 * Accent oublié sur un mot qui en forme un autre (« les taches qui m'ont été
 * confiées » pour « les tâches »). Le dictionnaire ne peut rien signaler :
 * « taches » est un mot correct. Quand une variante accentuée est beaucoup plus
 * courante, le mot devient un cas ambigu que seule l'IA, avec la phrase, peut
 * trancher. Sans décision de l'IA, aucune remarque (repli « drop ») : le mot écrit
 * est peut-être le bon.
 */
const WORD = /(?<![\p{L}\p{N}_'’-])\p{Ll}+(?![\p{L}\p{N}_'’-])/gu;
const TECHNICAL = new Set(TECHNICAL_TERMS);
const accentCount = (word: string) => (word.normalize('NFD').match(/\p{M}/gu) ?? []).length;

export class AccentConfusionAnalyzer implements LanguageAnalyzer {
  readonly id = 'accent_confusion';

  constructor(
    private readonly frequencyFactory: () => WordFrequency = () =>
      getSpellingDictionaries().frequency,
  ) {}

  blockKinds(config: AnalyzerContext['config']) {
    return config.proseBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const config = context.config.ambiguity;
    const frequency = this.frequencyFactory();
    const out: LanguageIssue[] = [];
    for (const match of block.text.matchAll(WORD)) {
      const word = match[0];
      const start = match.index;
      if ([...word].length < config.confusionMinLength || TECHNICAL.has(word)) continue;
      if (overlapsAny(context.protectedRanges, start, start + word.length)) continue;
      // Confusion d'accents française : seulement dans un passage sûrement en français.
      if (context.language.at(start) !== 'fr') continue;
      const own = frequency.of(word);
      if (own === null) continue; // mot inconnu : traité par l'orthographe
      // Mot employé souvent dans le document : choix voulu de l'auteur.
      const occurrences = context.document.wordCounts.get(word) ?? 0;
      if (occurrences >= context.config.spelling.repeatedUnknownThreshold) continue;
      const variants = frequency
        .accentVariants(word)
        .filter(
          (variant) =>
            // Accent oublié seulement (taches → tâches) : jamais un accent en moins
            // ou déplacé (approché / approche, précèdent / précédent sont voulus).
            accentCount(variant.word) > accentCount(word) &&
            // Présent / participe passé (décide / décidé, gagne / gagné) : affaire de
            // grammaire (Grammalecte), pas un accent oublié.
            variant.word.replace(/é(e?s?)$/u, 'e$1') !== word &&
            variant.zipf >= config.confusionMinZipf &&
            variant.zipf - own >= config.confusionMinZipfGap,
        )
        .sort((a, b) => b.zipf - a.zipf)
        .slice(0, config.maxOptions);
      if (variants.length === 0) continue;
      const options = variants.map((variant) => ({
        start,
        end: start + word.length,
        replacement: variant.word,
      }));
      out.push({
        rule: 'accent_confusion',
        category: 'spelling',
        subtype: 'accent',
        blockId: block.id,
        original: word,
        suggestion: null,
        explanation: `« ${word} » existe, mais ${options.map((o) => `« ${o.replacement} »`).join(' ou ')} est beaucoup plus courant : vérifiez le mot voulu.`,
        severity: 'minor',
        confidence: 'low',
        source: 'rules',
        relatedBlockIds: [],
        range: { start, end: start + word.length },
        ambiguity: { kind: 'confusion', options, fallback: 'drop' },
      });
    }
    return out;
  }
}
