import type { Block } from '@wordfix/shared';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';
import { countWords, numericShare } from '../text.js';

/**
 * Phrases excessivement longues. Ce n'est jamais une faute : la remarque est une
 * suggestion de lisibilité (confiance moyenne, aucune correction imposée).
 * Les énumérations (points-virgules) et les phrases faites surtout de chiffres
 * ou de références ne sont pas signalées : leur longueur est normale.
 */
export class SentenceAnalyzer implements LanguageAnalyzer {
  readonly id = 'sentence';

  blockKinds(config: AnalyzerContext['config']) {
    return config.proseBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const { longSentenceWords, enumerationSemicolons, maxNumericShare } = context.config.sentence;
    const out: LanguageIssue[] = [];

    for (const sentence of block.sentences) {
      const text = block.text.slice(sentence.start, sentence.end);
      const words = countWords(text);
      if (words <= longSentenceWords) continue;
      if ((text.match(/;/g)?.length ?? 0) >= enumerationSemicolons) continue;
      if (numericShare(text) > maxNumericShare) continue;

      out.push({
        rule: 'long_sentence',
        category: 'style',
        subtype: 'too_long',
        blockId: block.id,
        original: text,
        suggestion: null,
        explanation: `Cette phrase compte ${words} mots : la découper pourrait la rendre plus facile à lire.`,
        severity: 'minor',
        confidence: 'medium',
        source: 'rules',
        relatedBlockIds: [],
        range: { start: sentence.start, end: sentence.end },
      });
    }
    return out;
  }
}
