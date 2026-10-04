'use client';

import type { IssueDto } from '@wordfix/shared';
import { Check, EyeOff, Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { NATURES } from '@/lib/nature';
import { cn } from '@/lib/utils';
import { groupBySection, isDone } from './filtering';

const STATUS_ICON = { accepted: Check, verified: Check, edited: Pencil, ignored: EyeOff } as const;

/** Liste des problèmes dans l'ordre du document, regroupés par section. */
export function IssueList({
  issues,
  selectedId,
  onSelect,
}: {
  issues: IssueDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="space-y-4">
      {groupBySection(issues).map((group, index) => (
        <section key={`${group.section}-${index}`} aria-label={group.section}>
          <h3
            className="text-ink-subtle mb-1.5 truncate px-1 text-xs font-semibold"
            title={group.section}
          >
            {group.section}
          </h3>
          <ul className="space-y-1">
            {group.items.map((issue) => {
              const nature = NATURES[issue.nature];
              const done = isDone(issue);
              const StatusIcon = done
                ? STATUS_ICON[issue.status as keyof typeof STATUS_ICON]
                : null;
              const selected = issue.id === selectedId;
              return (
                <li key={issue.id}>
                  <button
                    ref={selected ? selectedRef : undefined}
                    type="button"
                    onClick={() => onSelect(issue.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'rounded-control flex w-full items-start gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors',
                      nature.border,
                      selected ? 'bg-surface shadow-sm ring-1 ring-slate-200' : 'hover:bg-surface',
                      done && 'opacity-60',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-ink line-clamp-2 text-sm">
                        <span className="sr-only">{nature.label} : </span>
                        {issue.original}
                      </span>
                      <span className="text-ink-subtle mt-0.5 block text-xs">
                        {issue.location.estimatedPage ? `p. ~${issue.location.estimatedPage}` : ''}
                        {issue.location.label ? ` · ${issue.location.label}` : ''}
                      </span>
                    </span>
                    {StatusIcon ? (
                      <StatusIcon
                        className="text-ink-subtle mt-0.5 size-4 shrink-0"
                        aria-label="Traité"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
