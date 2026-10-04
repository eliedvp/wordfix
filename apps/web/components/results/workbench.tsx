'use client';

import type { AnalysisDto, IssueDto, IssueNature, IssueStatus } from '@wordfix/shared';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LoaderCircle, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useIssues, useUpdateIssue } from '@/lib/hooks/use-issues';
import { cn } from '@/lib/utils';
import {
  applyFilters,
  CATEGORY_FILTERS,
  categoryCounts,
  type Filters,
  filtersToParams,
  isDone,
  parseFilters,
  type ViewFilter,
} from './filtering';
import { type IssueAction, IssueDetail } from './issue-detail';
import { IssueList } from './issue-list';
import { SummaryBand } from './summary-band';

const VIEWS: { key: ViewFilter; label: string }[] = [
  { key: 'open', label: 'À traiter' },
  { key: 'done', label: 'Traités' },
  { key: 'all', label: 'Tous' },
];

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Espace de relecture (Review Workbench) : synthèse, filtres, liste des points
 * dans l'ordre du document et détail du point sélectionné. Les filtres et le
 * point ouvert sont gardés dans l'adresse : un rechargement conserve la vue.
 */
export function Workbench({ analysis }: { analysis: AnalysisDto }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const desktop = useIsDesktop();

  const issuesQuery = useIssues(analysis.id, true);
  const update = useUpdateIssue(analysis.id);

  const filters = useMemo(
    () => parseFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const requestedId = searchParams.get('point');

  const all = useMemo(() => issuesQuery.data?.items ?? [], [issuesQuery.data]);
  const visible = useMemo(() => applyFilters(all, filters), [all, filters]);
  const counts = useMemo(() => categoryCounts(all, filters), [all, filters]);

  // Le point sélectionné reste affiché même s'il vient d'être traité (vue « À traiter »).
  const [stickyId, setStickyId] = useState<string | null>(null);
  const selectedId =
    requestedId && all.some((issue) => issue.id === requestedId)
      ? requestedId
      : desktop
        ? (visible[0]?.id ?? null)
        : null;
  const listed = useMemo(() => {
    const sticky = all.find((issue) => issue.id === stickyId);
    if (!sticky || visible.some((issue) => issue.id === stickyId)) return visible;
    return [...visible, sticky].sort((a, b) => a.docOrder - b.docOrder);
  }, [all, visible, stickyId]);
  const selectedIndex = listed.findIndex((issue) => issue.id === selectedId);
  const selected: IssueDto | undefined =
    listed[selectedIndex] ?? all.find((i) => i.id === selectedId);

  const navigate = useCallback(
    (next: Filters, point: string | null) => {
      const query = filtersToParams(next, point).toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const select = useCallback(
    (id: string | null) => {
      setStickyId(id);
      navigate(filters, id);
    },
    [filters, navigate],
  );

  const move = useCallback(
    (delta: number) => {
      if (listed.length === 0) return;
      const index = selectedIndex < 0 ? 0 : (selectedIndex + delta + listed.length) % listed.length;
      select(listed[index]?.id ?? null);
    },
    [listed, selectedIndex, select],
  );

  /** Après une décision, on passe au prochain point encore à traiter. */
  const goToNextOpen = useCallback(
    (fromId: string) => {
      const start = listed.findIndex((issue) => issue.id === fromId);
      const next =
        listed.slice(start + 1).find((issue) => !isDone(issue) && issue.id !== fromId) ??
        listed.find((issue) => !isDone(issue) && issue.id !== fromId);
      select(next?.id ?? fromId);
    },
    [listed, select],
  );

  const setStatus = useCallback(
    (issue: IssueDto, status: IssueStatus, userText?: string) =>
      update.mutateAsync({ id: issue.id, status, userText }).catch(() => {
        toast.error(
          'Votre choix n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.',
        );
        throw new Error('update failed');
      }),
    [update],
  );

  const act = useCallback(
    async (issue: IssueDto, action: IssueAction) => {
      try {
        switch (action.type) {
          case 'accept': {
            if (!issue.suggestion) return;
            const copied = await copy(issue.suggestion);
            await setStatus(issue, 'accepted');
            toast.success(
              copied ? 'Correction copiée. Reportez-la dans Word.' : 'Correction acceptée.',
            );
            break;
          }
          case 'edit': {
            const copied = await copy(action.text);
            await setStatus(issue, 'edited', action.text);
            toast.success(
              copied
                ? 'Votre version est copiée. Reportez-la dans Word.'
                : 'Votre version est enregistrée.',
            );
            break;
          }
          case 'verify':
            await setStatus(issue, 'verified');
            break;
          case 'ignore':
            await setStatus(issue, 'ignored');
            toast('Point ignoré.', {
              duration: 5000,
              action: { label: 'Annuler', onClick: () => void setStatus(issue, 'open') },
            });
            break;
          case 'reopen':
            await setStatus(issue, 'open');
            return;
        }
        goToNextOpen(issue.id);
      } catch {
        // Le message d'erreur a déjà été affiché.
      }
    },
    [goToNextOpen, setStatus],
  );

  // Raccourcis clavier : J/K pour naviguer, A accepter, I ignorer, V vérifier.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'j') move(1);
      else if (key === 'k') move(-1);
      else if (selected && !isDone(selected)) {
        if (key === 'a' && selected.suggestion) void act(selected, { type: 'accept' });
        else if (key === 'i') void act(selected, { type: 'ignore' });
        else if (key === 'v') void act(selected, { type: 'verify' });
        else return;
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, move, selected]);

  const toggleNature = (nature: IssueNature) => {
    const natures = filters.natures.includes(nature)
      ? filters.natures.filter((n) => n !== nature)
      : [...filters.natures, nature];
    navigate({ ...filters, natures }, null);
  };

  const detail = selected ? (
    <IssueDetail
      // La clé réinitialise le formulaire de modification à chaque changement de point.
      key={selected.id}
      issue={selected}
      blocks={issuesQuery.data?.blocks ?? {}}
      position={selectedIndex + 1}
      total={listed.length}
      onPrevious={() => move(-1)}
      onNext={() => move(1)}
      onAction={(action) => void act(selected, action)}
    />
  ) : null;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <SummaryBand
        analysis={analysis}
        activeNatures={filters.natures}
        onToggleNature={toggleNature}
      />

      <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="Filtrer par catégorie"
        >
          {CATEGORY_FILTERS.map((filter) => {
            const active = filters.category === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                aria-pressed={active}
                onClick={() => navigate({ ...filters, category: filter.key }, null)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand bg-brand-soft text-brand-deep'
                    : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong',
                )}
              >
                {filter.label}{' '}
                <span className="text-ink-subtle ml-0.5 tabular-nums">{counts[filter.key]}</span>
              </button>
            );
          })}
        </div>
        <div
          className="border-hairline bg-surface rounded-control flex shrink-0 border p-0.5"
          role="group"
          aria-label="Afficher"
        >
          {VIEWS.map((view) => (
            <button
              key={view.key}
              type="button"
              aria-pressed={filters.view === view.key}
              onClick={() => navigate({ ...filters, view: view.key }, null)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                filters.view === view.key ? 'bg-brand text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {view.label}
            </button>
          ))}
        </div>
      </div>

      {issuesQuery.isPending ? (
        <div className="text-ink-subtle grid place-items-center py-20">
          <LoaderCircle className="size-6 animate-spin" aria-label="Chargement des points" />
        </div>
      ) : issuesQuery.isError ? (
        <div className="py-16 text-center">
          <p className="text-ink">Les points relevés n’ont pas pu être chargés.</p>
          <Button className="mt-4" variant="secondary" onClick={() => void issuesQuery.refetch()}>
            Réessayer
          </Button>
        </div>
      ) : listed.length === 0 ? (
        <EmptyState
          analysis={analysis}
          view={filters.view}
          filtered={filters.category !== 'all' || filters.natures.length > 0}
        />
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <nav
            aria-label="Points relevés"
            className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2"
          >
            <IssueList issues={listed} selectedId={selectedId} onSelect={select} />
          </nav>
          {desktop ? (
            <div className="border-hairline bg-surface rounded-card border p-6 shadow-sm lg:sticky lg:top-20 lg:self-start">
              {detail}
            </div>
          ) : (
            <DialogPrimitive.Root
              open={Boolean(selected)}
              onOpenChange={(open) => !open && select(null)}
            >
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
                <DialogPrimitive.Content className="bg-surface fixed inset-x-0 bottom-0 z-50 max-h-[92vh] overflow-y-auto rounded-t-2xl p-5 shadow-xl focus:outline-none">
                  <DialogPrimitive.Title className="sr-only">Détail du point</DialogPrimitive.Title>
                  <DialogPrimitive.Description className="sr-only">
                    Explication, proposition et actions pour ce point.
                  </DialogPrimitive.Description>
                  <DialogPrimitive.Close className="text-ink-subtle mb-2 ml-auto flex items-center gap-1 text-sm">
                    <X className="size-4" aria-hidden /> Fermer
                  </DialogPrimitive.Close>
                  {detail}
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  analysis,
  view,
  filtered,
}: {
  analysis: AnalysisDto;
  view: ViewFilter;
  filtered: boolean;
}) {
  let message = 'Aucun point ne correspond à ces filtres.';
  if (!filtered && view === 'open' && analysis.issueCount > 0) {
    message = 'Tous les points ont été traités. Votre relecture est terminée.';
  } else if (!filtered && analysis.issueCount === 0) {
    message = 'WordFix n’a relevé aucun point dans ce document.';
  } else if (!filtered && view === 'done') {
    message = 'Aucun point traité pour l’instant.';
  }
  return <p className="text-ink-muted py-16 text-center">{message}</p>;
}
