'use client';

import {
  type BlockContextDto,
  CATEGORY_LABELS,
  CONFIDENCE_LABELS,
  type IssueDto,
  type IssueLocationDto,
  type IssueSubtype,
  SUBTYPE_LABELS,
} from '@wordfix/shared';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  EyeOff,
  Pencil,
  RotateCcw,
  SearchCheck,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isDone, wordDiff } from './filtering';
import { NatureBadge } from './nature-badge';

export type IssueAction =
  | { type: 'accept' }
  | { type: 'edit'; text: string }
  | { type: 'ignore' }
  | { type: 'verify' }
  | { type: 'reopen' };

const STATUS_TEXT: Record<string, string> = {
  accepted: 'Correction acceptée et copiée.',
  edited: 'Votre version a été enregistrée.',
  ignored: 'Point ignoré.',
  verified: 'Vous avez vérifié ce point.',
};

const CONFIDENCE_HELP =
  'Indique à quel point WordFix est sûr de ce point. Une confiance faible signifie : relisez avant de décider.';

export function locationText(location: IssueLocationDto): string {
  return [
    location.sectionPath,
    location.paragraphInSection ? `paragraphe ${location.paragraphInSection}` : null,
    location.label,
    location.estimatedPage ? `page ~${location.estimatedPage} (estimée)` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Paragraphe d'origine, l'extrait signalé surligné (fenêtre autour s'il est long). */
function ContextText({
  block,
  start,
  end,
}: {
  block?: BlockContextDto;
  start: number;
  end: number;
}) {
  if (!block) return null;
  const text = block.text;
  const windowStart = text.length > 700 ? Math.max(0, start - 280) : 0;
  const windowEnd = text.length > 700 ? Math.min(text.length, end + 280) : text.length;
  return (
    <p className="text-ink font-serif text-[15px] leading-7 whitespace-pre-line">
      {windowStart > 0 ? '… ' : ''}
      {text.slice(windowStart, start)}
      <mark className="rounded-sm bg-amber-100 px-0.5 text-inherit">{text.slice(start, end)}</mark>
      {text.slice(end, windowEnd)}
      {windowEnd < text.length ? ' …' : ''}
    </p>
  );
}

export function IssueDetail({
  issue,
  blocks,
  position,
  total,
  onPrevious,
  onNext,
  onAction,
}: {
  issue: IssueDto;
  blocks: Record<string, BlockContextDto>;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onAction: (action: IssueAction) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.userText ?? issue.suggestion ?? issue.original);

  const subtype = SUBTYPE_LABELS[issue.subtype as IssueSubtype] ?? issue.subtype;
  const diff = issue.suggestion ? wordDiff(issue.original, issue.suggestion) : null;
  const canCorrect = issue.nature === 'error' || issue.nature === 'suggestion';
  const done = isDone(issue);

  return (
    <article aria-label="Détail du point" className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2">
        <NatureBadge nature={issue.nature} />
        <span className="text-ink text-sm font-medium">
          {CATEGORY_LABELS[issue.category]} · {subtype}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span className="text-ink-subtle text-xs">
            {position} / {total}
          </span>
          <Button variant="ghost" size="sm" onClick={onPrevious} aria-label="Point précédent (K)">
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" onClick={onNext} aria-label="Point suivant (J)">
            <ChevronRight aria-hidden />
          </Button>
        </span>
      </header>
      <p className="text-ink-subtle mt-2 text-sm">{locationText(issue.location)}</p>

      <div className="border-hairline bg-canvas rounded-control mt-4 border p-4">
        <ContextText
          block={blocks[issue.location.blockId]}
          start={issue.location.charStart}
          end={issue.location.charEnd}
        />
      </div>

      {diff ? (
        <div className="mt-4">
          <h3 className="text-ink-subtle text-xs font-semibold">Proposition</h3>
          <p className="text-ink mt-1 text-[15px] leading-7">
            {diff.prefix}
            {diff.removed ? (
              <del className="bg-nature-error-soft text-nature-error rounded-sm px-0.5">
                {diff.removed}
              </del>
            ) : null}
            {diff.added ? (
              <ins className="bg-brand-soft text-brand-deep rounded-sm px-0.5 font-medium no-underline">
                {diff.added}
              </ins>
            ) : null}
            {diff.suffix}
          </p>
        </div>
      ) : null}

      <p className="text-ink mt-4">{issue.explanation}</p>
      <p className="text-ink-subtle mt-2 text-xs" title={CONFIDENCE_HELP}>
        {CONFIDENCE_LABELS[issue.confidence]}
        <span className="sr-only"> : {CONFIDENCE_HELP}</span>
      </p>

      {issue.related.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-ink-subtle text-xs font-semibold">Passage à comparer</h3>
          <ul className="mt-2 space-y-3">
            {issue.related.map((related) => (
              <li key={related.blockId} className="border-hairline rounded-control border p-3">
                <p className="text-ink-subtle mb-1 text-xs">{locationText(related)}</p>
                <ContextText
                  block={blocks[related.blockId]}
                  start={related.charStart}
                  end={related.charEnd}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editing ? (
        <div className="mt-5">
          <label htmlFor="user-text" className="text-ink text-sm font-medium">
            Votre version
          </label>
          <textarea
            id="user-text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={2000}
            rows={3}
            className="border-hairline-strong rounded-control focus:border-brand mt-1 w-full border p-3 text-sm focus:ring-3 focus:ring-emerald-600/15 focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => onAction({ type: 'edit', text: draft })}
              disabled={draft.trim().length === 0}
            >
              <Copy aria-hidden />
              Enregistrer et copier
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-hairline mt-auto border-t pt-5">
          {done ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-ink-muted text-sm">{STATUS_TEXT[issue.status]}</p>
              <Button variant="secondary" size="sm" onClick={() => onAction({ type: 'reopen' })}>
                <RotateCcw aria-hidden />
                Rouvrir
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {canCorrect && issue.suggestion ? (
                <Button onClick={() => onAction({ type: 'accept' })} title="Raccourci : A">
                  <Check aria-hidden />
                  {issue.nature === 'error' ? 'Appliquer la correction' : 'Accepter'}
                </Button>
              ) : null}
              {canCorrect ? (
                <Button variant="secondary" onClick={() => setEditing(true)} title="Raccourci : E">
                  <Pencil aria-hidden />
                  Modifier
                </Button>
              ) : null}
              {!canCorrect || !issue.suggestion ? (
                <Button
                  variant={canCorrect ? 'secondary' : 'primary'}
                  onClick={() => onAction({ type: 'verify' })}
                  title="Raccourci : V"
                >
                  <SearchCheck aria-hidden />
                  J’ai vérifié
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => onAction({ type: 'ignore' })}
                title="Raccourci : I"
              >
                <EyeOff aria-hidden />
                Ignorer
              </Button>
            </div>
          )}
          <p className={cn('text-ink-subtle mt-3 text-xs', done && 'hidden')}>
            Le fichier Word n’est pas modifié : la correction est copiée pour que vous la reportiez
            dans Word.
          </p>
        </div>
      )}
    </article>
  );
}
