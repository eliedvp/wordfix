import type { TextRange } from '@wordfix/shared';

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

const sentenceSegmenter = new Intl.Segmenter('fr', { granularity: 'sentence' });

/** Découpe en phrases (positions dans le texte, espaces de bord exclus). */
export function splitSentences(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const lead = segment.length - segment.trimStart().length;
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    ranges.push({ start: index + lead, end: index + lead + trimmed.length });
  }
  return ranges;
}
