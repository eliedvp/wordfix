import type { Block } from '@wordfix/shared';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';
import { overlapsAny } from '../text.js';

/**
 * Répétitions évidentes : un même mot écrit deux fois de suite (« permet permet »,
 * « le le »), séparé seulement par des espaces. C'est une faute de frappe quasi
 * certaine, d'où une confiance élevée et une correction proposée.
 *
 * Volontairement exclus (pas assez sûr pour cette fondation) :
 * - les répétitions séparées par une ponctuation (« oui, oui ») ;
 * - les mots d'une même famille (« il permet de permettre ») ;
 * - les répétitions à distance dans la phrase.
 */
const REPEATED_WORD = /(?<![\p{L}\p{N}])(\p{L}+)[ \u00a0\u202f]+(\p{L}+)(?![\p{L}\p{N}'’-])/gu;

export class RepetitionAnalyzer implements LanguageAnalyzer {
  readonly id = 'repetition';

  blockKinds(config: AnalyzerContext['config']) {
    return config.languageBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const { allowedRepeats, maxWordLength } = context.config.repetition;
    const allowed = new Set(allowedRepeats);
    const out: LanguageIssue[] = [];

    REPEATED_WORD.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REPEATED_WORD.exec(block.text)) !== null) {
      const first = match[1] ?? '';
      const second = match[2] ?? '';
      // Avance d'un mot seulement : « le le le » donne deux paires à examiner.
      REPEATED_WORD.lastIndex = match.index + first.length;

      if (first.toLowerCase() !== second.toLowerCase()) continue;
      if (first.length > maxWordLength) continue;
      if (allowed.has(first.toLowerCase())) continue;
      // Un trait d'union juste avant rattache le premier mot à un mot composé.
      if (/[-'’]$/.test(block.text.slice(0, match.index))) continue;

      const start = match.index;
      const end = start + match[0].length;
      if (overlapsAny(context.protectedRanges, start, end)) continue;

      out.push({
        rule: 'repeated_word',
        category: 'spelling',
        subtype: 'typo',
        blockId: block.id,
        original: match[0],
        suggestion: first,
        explanation: `Le mot « ${first} » est écrit deux fois de suite.`,
        severity: 'major',
        confidence: 'high',
        source: 'rules',
        relatedBlockIds: [],
        range: { start, end },
      });
    }
    return out;
  }
}
