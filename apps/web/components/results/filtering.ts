import type { IssueCategory, IssueDto, IssueNature } from '@wordfix/shared';

/** Filtres de catégorie affichés : la ponctuation est regroupée avec la grammaire. */
export const CATEGORY_FILTERS = [
  { key: 'all', label: 'Tous', categories: null },
  { key: 'spelling', label: 'Orthographe', categories: ['spelling'] },
  { key: 'grammar', label: 'Grammaire', categories: ['grammar', 'punctuation'] },
  { key: 'style', label: 'Style', categories: ['style'] },
  { key: 'coherence', label: 'Cohérence', categories: ['coherence'] },
  { key: 'structure', label: 'Structure', categories: ['structure'] },
] as const satisfies readonly {
  key: string;
  label: string;
  categories: readonly IssueCategory[] | null;
}[];

export type CategoryFilterKey = (typeof CATEGORY_FILTERS)[number]['key'];
export type ViewFilter = 'open' | 'done' | 'all';

export interface Filters {
  category: CategoryFilterKey;
  natures: IssueNature[];
  view: ViewFilter;
}

export const DEFAULT_FILTERS: Filters = { category: 'all', natures: [], view: 'open' };

export function isDone(issue: IssueDto): boolean {
  return issue.status !== 'open';
}

function matchesCategory(issue: IssueDto, key: CategoryFilterKey): boolean {
  const filter = CATEGORY_FILTERS.find((f) => f.key === key);
  return (
    !filter?.categories || (filter.categories as readonly IssueCategory[]).includes(issue.category)
  );
}

export function applyFilters(issues: IssueDto[], filters: Filters): IssueDto[] {
  return issues.filter(
    (issue) =>
      matchesCategory(issue, filters.category) &&
      (filters.natures.length === 0 || filters.natures.includes(issue.nature)) &&
      (filters.view === 'all' || (filters.view === 'done' ? isDone(issue) : !isDone(issue))),
  );
}

/** Nombre de problèmes par filtre de catégorie, avec les autres filtres appliqués. */
export function categoryCounts(
  issues: IssueDto[],
  filters: Filters,
): Record<CategoryFilterKey, number> {
  const counts = {} as Record<CategoryFilterKey, number>;
  for (const filter of CATEGORY_FILTERS) {
    counts[filter.key] = applyFilters(issues, { ...filters, category: filter.key }).length;
  }
  return counts;
}

export function parseFilters(params: URLSearchParams): Filters {
  const category = params.get('categorie');
  const view = params.get('vue');
  const natures = (params.get('nature') ?? '')
    .split(',')
    .filter((n): n is IssueNature => ['error', 'suggestion', 'potential', 'verify'].includes(n));
  return {
    category: CATEGORY_FILTERS.some((f) => f.key === category)
      ? (category as CategoryFilterKey)
      : 'all',
    natures,
    view: view === 'done' || view === 'all' ? view : 'open',
  };
}

export function filtersToParams(filters: Filters, selected: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category !== 'all') params.set('categorie', filters.category);
  if (filters.natures.length > 0) params.set('nature', filters.natures.join(','));
  if (filters.view !== 'open') params.set('vue', filters.view);
  if (selected) params.set('point', selected);
  return params;
}

/** Regroupe les problèmes par section, dans l'ordre du document. */
export function groupBySection(issues: IssueDto[]): { section: string; items: IssueDto[] }[] {
  const groups: { section: string; items: IssueDto[] }[] = [];
  for (const issue of issues) {
    const last = groups.at(-1);
    if (last && last.section === issue.location.sectionPath) last.items.push(issue);
    else groups.push({ section: issue.location.sectionPath, items: [issue] });
  }
  return groups;
}

/** Différence mot à mot entre l'original et la suggestion (préfixe et suffixe communs). */
export function wordDiff(
  before: string,
  after: string,
): { prefix: string; removed: string; added: string; suffix: string } {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return {
    prefix: a.slice(0, start).join(''),
    removed: a.slice(start, endA).join(''),
    added: b.slice(start, endB).join(''),
    suffix: a.slice(endA).join(''),
  };
}
