import type { Block } from '@wordfix/shared';
import type { LanguageRuleId } from '../config.js';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';
import { isContinuousText, overlapsAny } from '../text.js';

/**
 * Typographie simple et sans ambiguïté en français :
 * - deux espaces entre deux mots ;
 * - espace avant une virgule ou un point (« mot , suite ») ;
 * - virgule ou point-virgule doublé (« ,, ») ;
 * - virgule collée entre deux mots (« rouge,vert »).
 *
 * Garde-fous : les zones techniques (URL, fichiers, code) sont ignorées, et un
 * signalement n'est émis que si le texte concerné est continu dans le fichier
 * Word (aucune image, note ou champ invisible entre les caractères).
 *
 * Non traité ici (conventions variables selon les pays et les éditeurs) :
 * l'espace avant « ; : ! ? », les guillemets et les apostrophes.
 */
export class TypographyAnalyzer implements LanguageAnalyzer {
  readonly id = 'typography';

  blockKinds(config: AnalyzerContext['config']) {
    return config.proseBlockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    return [
      ...this.doubleSpaces(block, context),
      ...this.spaceBeforePunctuation(block, context),
      ...this.doubledPunctuation(block, context),
      ...this.missingSpaceAfterComma(block, context),
    ];
  }

  private doubleSpaces(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const out: LanguageIssue[] = [];
    for (const match of block.text.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!this.safe(block, context, start - 1, end + 1)) continue;
      out.push(
        issue(block, 'double_space', {
          subtype: 'spacing',
          original: match[0],
          suggestion: ' ',
          explanation: 'Deux espaces se suivent entre ces mots.',
          severity: 'minor',
          range: { start, end },
        }),
      );
    }
    return out;
  }

  private spaceBeforePunctuation(block: Block, context: AnalyzerContext): LanguageIssue[] {
    // Les équations ne figurent pas dans le texte extrait : « soit , » peut être correct.
    if (context.hasDroppedInlineContent) return [];
    const out: LanguageIssue[] = [];
    const pattern = /(\p{L}+)[ \u00a0]+([,.])(?=\s|$)/gu;
    for (const match of block.text.matchAll(pattern)) {
      const word = match[1] ?? '';
      const mark = match[2] ?? '';
      const start = match.index;
      const end = start + match[0].length;
      if (!this.safe(block, context, start, end)) continue;
      out.push(
        issue(block, 'space_before_punctuation', {
          subtype: 'spacing',
          original: match[0],
          suggestion: `${word}${mark}`,
          explanation:
            mark === ','
              ? 'En français, on ne met pas d’espace avant une virgule.'
              : 'En français, on ne met pas d’espace avant un point.',
          severity: 'minor',
          range: { start, end },
        }),
      );
    }
    return out;
  }

  private doubledPunctuation(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const out: LanguageIssue[] = [];
    for (const match of block.text.matchAll(/(?<![,;])([,;])\1(?![,;])/g)) {
      const mark = match[1] ?? '';
      const start = match.index;
      const end = start + match[0].length;
      if (!this.safe(block, context, start, end)) continue;
      out.push(
        issue(block, 'doubled_punctuation', {
          subtype: 'punctuation',
          original: match[0],
          suggestion: mark,
          explanation: `Le signe « ${mark} » est écrit deux fois de suite.`,
          severity: 'minor',
          range: { start, end },
        }),
      );
    }
    return out;
  }

  private missingSpaceAfterComma(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const out: LanguageIssue[] = [];
    // Deux mots d'au moins deux lettres (« rouge,vert ») : ni nombres (« 3,5 »),
    // ni variables (« x,y »), ni code (« f(a,b) », protégé ou exclu ci-dessous).
    const pattern = /(?<![\p{L}\p{N}([{])(\p{L}{2,}),(\p{L}{2,})(?![\p{L}\p{N}(\])}])/gu;
    for (const match of block.text.matchAll(pattern)) {
      const before = match[1] ?? '';
      const after = match[2] ?? '';
      const start = match.index;
      const end = start + match[0].length;
      if (!this.safe(block, context, start, end)) continue;
      out.push(
        issue(block, 'missing_space_after_comma', {
          subtype: 'spacing',
          original: match[0],
          suggestion: `${before}, ${after}`,
          explanation: 'Une espace est attendue après la virgule.',
          severity: 'minor',
          range: { start, end },
        }),
      );
    }
    return out;
  }

  /** Hors zone technique et texte continu dans le fichier Word. */
  private safe(block: Block, context: AnalyzerContext, start: number, end: number): boolean {
    const from = Math.max(0, start);
    const to = Math.min(block.text.length, end);
    return !overlapsAny(context.protectedRanges, from, to) && isContinuousText(block, from, to);
  }
}

function issue(
  block: Block,
  rule: LanguageRuleId,
  fields: Pick<
    LanguageIssue,
    'subtype' | 'original' | 'suggestion' | 'explanation' | 'severity' | 'range'
  >,
): LanguageIssue {
  return {
    rule,
    category: 'punctuation',
    blockId: block.id,
    confidence: 'high',
    source: 'rules',
    relatedBlockIds: [],
    ...fields,
  };
}
