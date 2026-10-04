import type { IssueLocationDto } from '@wordfix/shared';
import { newId } from '../../common/ids.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CandidateIssue } from '../types.js';
import { anchorExcerpt, firstSentenceRange } from './anchor.js';
import { fingerprint } from './fingerprint.js';
import type { LocationResolver } from './location.js';
import { adjustSeverity, decideNature, ensureHedged } from './nature-policy.js';

export type RejectReason =
  'unknown_block' | 'excerpt_not_found' | 'identical_suggestion' | 'inside_quotation';

export type MaterializeResult =
  { ok: true; data: Prisma.IssueCreateManyInput } | { ok: false; reason: RejectReason };

const LANGUAGE_CATEGORIES = new Set(['spelling', 'grammar', 'punctuation']);

/**
 * Transforme un problème candidat en enregistrement prêt à stocker, après les
 * contrôles du backend : bloc existant, extrait réellement présent (sinon rejet),
 * suggestion différente de l'original, pas de « correction » dans une citation
 * en cas de doute, nature et gravité décidées ici, formulation prudente imposée.
 */
export function materialize(
  candidate: CandidateIssue,
  resolver: LocationResolver,
  analysisId: string,
): MaterializeResult {
  const block = resolver.block(candidate.blockId);
  if (!block) return { ok: false, reason: 'unknown_block' };

  let range: { start: number; end: number };
  if (candidate.range) {
    range = candidate.range;
  } else if (candidate.original) {
    const anchor = anchorExcerpt(block.text, candidate.original);
    if (!anchor) return { ok: false, reason: 'excerpt_not_found' };
    range = anchor;
  } else {
    range = firstSentenceRange(block.text, block.sentences);
  }
  const original = block.text.slice(range.start, range.end);

  let suggestion = candidate.suggestion?.trim() ? candidate.suggestion : null;
  if (suggestion !== null && suggestion.trim() === original.trim()) {
    if (LANGUAGE_CATEGORIES.has(candidate.category))
      return { ok: false, reason: 'identical_suggestion' };
    suggestion = null;
  }

  if (
    LANGUAGE_CATEGORIES.has(candidate.category) &&
    candidate.confidence !== 'high' &&
    isInsideQuotation(block.text, range.start)
  ) {
    return { ok: false, reason: 'inside_quotation' };
  }

  const nature = decideNature({ ...candidate, suggestion });
  const location = resolver.resolve(block.id, range.start, range.end);
  if (!location) return { ok: false, reason: 'unknown_block' };

  const related: IssueLocationDto[] = [];
  for (const relatedId of candidate.relatedBlockIds) {
    if (relatedId === block.id) continue;
    const relatedBlock = resolver.block(relatedId);
    if (!relatedBlock) continue;
    const excerpt = candidate.relatedExcerpts?.[relatedId];
    const anchor = excerpt ? anchorExcerpt(relatedBlock.text, excerpt) : null;
    const relatedRange = anchor ?? firstSentenceRange(relatedBlock.text, relatedBlock.sentences);
    const relatedLocation = resolver.resolve(relatedId, relatedRange.start, relatedRange.end);
    if (relatedLocation) related.push(relatedLocation);
  }

  return {
    ok: true,
    data: {
      id: newId('iss'),
      analysisId,
      category: candidate.category,
      subtype: candidate.subtype,
      nature,
      severity: adjustSeverity(nature, candidate.severity),
      confidence: candidate.confidence,
      source: candidate.source,
      blockId: block.id,
      sectionId: block.sectionId,
      sectionPath: location.sectionPath,
      paragraphInSection: location.paragraphInSection,
      charStart: range.start,
      charEnd: range.end,
      estimatedPage: location.estimatedPage,
      docOrder: block.order * 10_000 + Math.min(range.start, 9_999),
      original,
      suggestion,
      explanation: ensureHedged(nature, candidate.subtype, candidate.explanation.trim()).slice(
        0,
        400,
      ),
      related: related as unknown as Prisma.InputJsonValue,
      fingerprint: fingerprint({
        category: candidate.category,
        subtype: candidate.subtype,
        blockId: block.id,
        start: range.start,
        end: range.end,
      }),
    },
  };
}

/** L'extrait se trouve-t-il entre des guillemets (citation) ? */
function isInsideQuotation(text: string, position: number): boolean {
  const before = text.slice(0, position);
  const opened = (before.match(/«/g)?.length ?? 0) - (before.match(/»/g)?.length ?? 0);
  if (opened > 0) return true;
  const straight = before.match(/"/g)?.length ?? 0;
  const curlyOpen = before.match(/“/g)?.length ?? 0;
  const curlyClose = before.match(/”/g)?.length ?? 0;
  return straight % 2 === 1 || curlyOpen > curlyClose;
}
