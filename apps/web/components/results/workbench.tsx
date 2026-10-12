'use client';

import {
  type AnalysisDto,
  type ExportOptions,
  type IssueDto,
  type IssueNature,
  type IssueStatus,
  isReliableCorrection,
} from '@wordfix/shared';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ChevronDown,
  Download,
  Info,
  LoaderCircle,
  type LucideIcon,
  PencilLine,
  Pilcrow,
  X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useIssues, useUpdateIssue } from '@/lib/hooks/use-issues';
import { cn } from '@/lib/utils';
import { AnalysisInfoPanel } from './analysis-info-panel';
import { ExportPanel, NO_OPTIONS, needsManualCheck } from './export-panel';
import {
  applyFilters,
  CATEGORY_FILTERS,
  type CategoryFilterKey,
  categoryCounts,
  DEFAULT_FILTERS,
  type Filters,
  filtersToParams,
  isDone,
  parseFilters,
  type ViewFilter,
} from './filtering';
import { FormattingPanel } from './formatting-panel';
import { type IssueAction, IssueDetail } from './issue-detail';
import { IssueList } from './issue-list';
import { QuickFix } from './quick-fix';
import { SummaryBand } from './summary-band';

const VIEWS: { key: ViewFilter; label: string }[] = [
  { key: 'open', label: 'À traiter' },
  { key: 'done', label: 'Traités' },
  { key: 'all', label: 'Tous' },
];

/** Les quatre actions sous la partie supérieure ; un seul panneau ouvert à la fois. */
export const PANELS = [
  { key: 'infos', label: 'Informations sur l’analyse', icon: Info },
  { key: 'corriger', label: 'Corriger', icon: PencilLine },
  { key: 'mise-en-forme', label: 'Mise en forme', icon: Pilcrow },
  { key: 'telecharger', label: 'Télécharger les modifications', icon: Download },
] as const satisfies readonly { key: string; label: string; icon: LucideIcon }[];
export type PanelKey = (typeof PANELS)[number]['key'];
const PANEL_PARAM = 'panneau';

function parsePanel(params: URLSearchParams): PanelKey | null {
  const value = params.get(PANEL_PARAM);
  if (PANELS.some((panel) => panel.key === value)) return value as PanelKey;
  // Ancienne adresse avec un point ouvert : ce point est dans « Corriger ».
  return params.has('point') ? 'corriger' : null;
}

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
 * Écran des résultats : partie supérieure (score, document, compteurs, progression),
 * puis quatre actions — Informations sur l'analyse, Corriger, Mise en forme,
 * Télécharger les modifications. Une action ouvre son panneau sous la rangée ; un seul
 * panneau à la fois, aucun au chargement. Panneau, filtres et point ouvert sont gardés
 * dans l'adresse : un rechargement conserve la vue. Les panneaux fermés restent montés
 * (masqués) : un export en cours et les choix en cours ne sont pas perdus.
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
  const panel = useMemo(
    () => parsePanel(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const requestedId = searchParams.get('point');

  const all = useMemo(() => issuesQuery.data?.items ?? [], [issuesQuery.data]);
  const visible = useMemo(() => applyFilters(all, filters), [all, filters]);
  const counts = useMemo(() => categoryCounts(all, filters), [all, filters]);

  // Mise en forme choisie : partagée par « Mise en forme » et « Télécharger ».
  const [options, setOptions] = useState<ExportOptions>(NO_OPTIONS);

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

  // Dernier état demandé (panneau et filtres) : l'adresse n'est mise à jour qu'après
  // coup, et deux clics rapprochés ne doivent pas repartir d'un état périmé.
  const latest = useRef({ filters, panel });
  useEffect(() => {
    latest.current = { filters, panel };
  }, [filters, panel]);

  const navigate = useCallback(
    (next: Filters, point: string | null, nextPanel: PanelKey | null) => {
      latest.current = { filters: next, panel: nextPanel };
      const params = filtersToParams(next, point);
      if (nextPanel) params.set(PANEL_PARAM, nextPanel);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );
  const changeFilters = useCallback(
    (change: Partial<Filters>) =>
      navigate({ ...latest.current.filters, ...change }, null, 'corriger'),
    [navigate],
  );
  /** Ouvre un panneau (ou le referme s'il est déjà ouvert). */
  const togglePanel = useCallback(
    (key: PanelKey) =>
      navigate(latest.current.filters, null, latest.current.panel === key ? null : key),
    [navigate],
  );
  const openPanel = useCallback(
    (key: PanelKey) => navigate(latest.current.filters, null, key),
    [navigate],
  );

  /**
   * Sélectionne un point. Un choix de l'utilisateur (liste, J/K) ouvre « Corriger » ;
   * après une décision, le panneau ouvert à ce moment est conservé : la réponse du
   * serveur peut arriver après que l'utilisateur a ouvert un autre panneau.
   */
  const select = useCallback(
    (id: string | null, panelAfter: PanelKey | null = 'corriger') => {
      setStickyId(id);
      navigate(latest.current.filters, id, panelAfter);
    },
    [navigate],
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
      select(next?.id ?? fromId, latest.current.panel);
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
            // Aucune copie automatique : la correction sera appliquée au document final.
            await setStatus(issue, 'accepted');
            toast.success('Correction acceptée : elle sera appliquée au document téléchargé.');
            break;
          }
          case 'edit':
            await setStatus(issue, 'edited', action.text);
            toast.success(
              'Votre version est enregistrée : elle sera appliquée au document téléchargé.',
            );
            break;
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
          case 'copy':
            if (await copy(action.text)) toast.success('Correction copiée.');
            else toast.error('La copie a échoué : sélectionnez le texte pour le copier.');
            return;
        }
        goToNextOpen(issue.id);
      } catch {
        // Le message d'erreur a déjà été affiché.
      }
    },
    [goToNextOpen, setStatus],
  );

  // Raccourcis clavier (panneau « Corriger » ouvert) : J/K pour naviguer, A accepter,
  // I ignorer, V vérifier.
  useEffect(() => {
    if (panel !== 'corriger') return;
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
  }, [act, move, panel, selected]);

  // Compteurs du haut : filtre par nature, dans le panneau « Corriger ».
  const toggleNature = (nature: IssueNature) => {
    const current = latest.current.filters.natures;
    const natures = current.includes(nature)
      ? current.filter((n) => n !== nature)
      : [...current, nature];
    changeFilters({ natures });
  };
  const showManual = () =>
    navigate({ ...DEFAULT_FILTERS, natures: ['potential', 'verify'] }, null, 'corriger');
  const showCategory = (category: CategoryFilterKey) =>
    navigate({ ...DEFAULT_FILTERS, category, view: 'all' }, null, 'corriger');

  // Panneau ouvert par l'utilisateur : amené à l'écran s'il commence sous le bas de la
  // fenêtre (fréquent sur mobile, où les quatre actions occupent la largeur).
  const shownPanel = useRef(panel);
  useEffect(() => {
    if (shownPanel.current === panel) return;
    shownPanel.current = panel;
    if (!panel) return;
    const element = document.getElementById(`panneau-${panel}`);
    if (element && element.getBoundingClientRect().top > window.innerHeight - 120) {
      element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [panel]);

  const reliable = useMemo(() => all.filter(isReliableCorrection).length, [all]);
  const manual = useMemo(() => all.filter(needsManualCheck).length, [all]);

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

  const loading = issuesQuery.isPending ? (
    <div className="text-ink-subtle grid place-items-center py-12">
      <LoaderCircle className="size-6 animate-spin" aria-label="Chargement des points" />
    </div>
  ) : issuesQuery.isError ? (
    <div className="py-10 text-center">
      <p className="text-ink">Les points relevés n’ont pas pu être chargés.</p>
      <Button className="mt-4" variant="secondary" onClick={() => void issuesQuery.refetch()}>
        Réessayer
      </Button>
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <SummaryBand
        analysis={analysis}
        activeNatures={filters.natures}
        onToggleNature={toggleNature}
        showWarnings={false}
      />

      <nav aria-label="Actions" className="mt-6">
        <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {PANELS.map((item) => {
            const open = panel === item.key;
            const Icon = item.icon;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`panneau-${item.key}`}
                  onClick={() => togglePanel(item.key)}
                  className={cn(
                    'rounded-control flex h-full w-full items-center gap-2 border px-3 py-3 text-left text-[13px] leading-tight font-semibold transition-colors sm:gap-2.5 sm:px-4 sm:text-sm',
                    open
                      ? 'border-brand bg-brand text-white shadow-sm'
                      : 'border-hairline bg-surface text-ink hover:border-brand/60 hover:bg-brand-soft/40',
                  )}
                >
                  <Icon
                    className={cn('size-5 shrink-0', open ? 'text-white' : 'text-brand')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  <ChevronDown
                    className={cn(
                      'hidden size-4 shrink-0 transition-transform sm:block',
                      open && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <Panel id="infos" title="Informations sur l’analyse" open={panel === 'infos'}>
        {loading ?? (
          <AnalysisInfoPanel analysis={analysis} issues={all} onShowCategory={showCategory} />
        )}
      </Panel>

      <Panel id="corriger" title="Corriger" open={panel === 'corriger'}>
        {loading ?? (
          <div className="space-y-6">
            <div className="space-y-3">
              <QuickFix analysisId={analysis.id} issues={all} />
              {reliable === 0 ? (
                <p className="text-ink-subtle text-sm">
                  « Tout corriger » : aucune correction fiable en attente.
                </p>
              ) : null}
              {manual > 0 ? (
                <p className="text-ink-muted text-sm">
                  {manual > 1
                    ? `${manual} points demandent une vérification de votre part : ils ne sont jamais appliqués automatiquement.`
                    : '1 point demande une vérification de votre part : il n’est jamais appliqué automatiquement.'}{' '}
                  <button
                    type="button"
                    onClick={showManual}
                    className="text-brand-deep font-medium underline underline-offset-4"
                  >
                    Les afficher
                  </button>
                </p>
              ) : null}
            </div>

            <section aria-labelledby="review-title">
              <h3 id="review-title" className="text-ink font-semibold">
                Vérifier les corrections
              </h3>
              <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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
                        onClick={() => changeFilters({ category: filter.key })}
                        className={cn(
                          'shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                          active
                            ? 'border-brand bg-brand-soft text-brand-deep'
                            : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong',
                        )}
                      >
                        {filter.label}{' '}
                        <span className="text-ink-subtle ml-0.5 tabular-nums">
                          {counts[filter.key]}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div
                  className="border-hairline bg-surface rounded-control flex shrink-0 self-start border p-0.5"
                  role="group"
                  aria-label="Afficher"
                >
                  {VIEWS.map((view) => (
                    <button
                      key={view.key}
                      type="button"
                      aria-pressed={filters.view === view.key}
                      onClick={() => changeFilters({ view: view.key })}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-sm font-medium',
                        filters.view === view.key
                          ? 'bg-brand text-white'
                          : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      {view.label}
                    </button>
                  ))}
                </div>
              </div>
              {filters.natures.length > 0 ? (
                <p className="text-ink-subtle mt-2 text-xs">
                  Filtre des compteurs du haut actif.{' '}
                  <button
                    type="button"
                    onClick={() => changeFilters({ natures: [] })}
                    className="text-brand-deep font-medium underline underline-offset-4"
                  >
                    Retirer ce filtre
                  </button>
                </p>
              ) : null}

              {listed.length === 0 ? (
                <EmptyState
                  analysis={analysis}
                  view={filters.view}
                  filtered={filters.category !== 'all' || filters.natures.length > 0}
                  onDownload={() => openPanel('telecharger')}
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
                      open={panel === 'corriger' && Boolean(selected)}
                      onOpenChange={(open) => !open && select(null)}
                    >
                      <DialogPrimitive.Portal>
                        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
                        <DialogPrimitive.Content className="bg-surface fixed inset-x-0 bottom-0 z-50 max-h-[92vh] overflow-y-auto rounded-t-2xl p-5 shadow-xl focus:outline-none">
                          <DialogPrimitive.Title className="sr-only">
                            Détail du point
                          </DialogPrimitive.Title>
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
            </section>
          </div>
        )}
      </Panel>

      <Panel id="mise-en-forme" title="Mise en forme" open={panel === 'mise-en-forme'}>
        {loading ?? (
          <FormattingPanel
            analysis={analysis}
            issues={all}
            options={options}
            onChange={setOptions}
            onShowStructure={() => showCategory('structure')}
            structure={issuesQuery.data?.structure}
          />
        )}
      </Panel>

      <Panel id="telecharger" title="Télécharger les modifications" open={panel === 'telecharger'}>
        {loading ?? (
          <ExportPanel
            key={analysis.id}
            analysis={analysis}
            issues={all}
            options={options}
            onEditFormatting={() => openPanel('mise-en-forme')}
            onShowManual={showManual}
          />
        )}
      </Panel>
    </div>
  );
}

/** Panneau d'une action : monté en permanence, masqué quand il est fermé. */
function Panel({
  id,
  title,
  open,
  children,
}: {
  id: PanelKey;
  title: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={`panneau-${id}`}
      aria-labelledby={`panneau-${id}-titre`}
      hidden={!open}
      className="border-hairline bg-surface rounded-card mt-4 scroll-mt-20 border p-5 shadow-sm sm:p-6"
    >
      <h2 id={`panneau-${id}-titre`} className="font-display text-ink mb-4 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyState({
  analysis,
  view,
  filtered,
  onDownload,
}: {
  analysis: AnalysisDto;
  view: ViewFilter;
  filtered: boolean;
  onDownload: () => void;
}) {
  let message = 'Aucun point ne correspond à ces filtres.';
  let finished = false;
  if (!filtered && view === 'open' && analysis.issueCount > 0) {
    message = 'Tous les points ont été traités. Votre relecture est terminée.';
    finished = true;
  } else if (!filtered && analysis.issueCount === 0) {
    message = 'WordFix n’a relevé aucun point dans ce document.';
    finished = true;
  } else if (!filtered && view === 'done') {
    message = 'Aucun point traité pour l’instant.';
  }
  return (
    <div className="py-10 text-center">
      <p className="text-ink-muted">{message}</p>
      {finished ? (
        <Button className="mt-4" onClick={onDownload}>
          <Download aria-hidden />
          Passer au téléchargement
        </Button>
      ) : null}
    </div>
  );
}
