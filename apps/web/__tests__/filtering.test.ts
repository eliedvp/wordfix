import type { IssueDto } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  categoryCounts,
  DEFAULT_FILTERS,
  filtersToParams,
  groupBySection,
  parseFilters,
  wordDiff,
} from '@/components/results/filtering';

function issue(partial: Partial<IssueDto>): IssueDto {
  return {
    id: 'iss_1',
    category: 'spelling',
    subtype: 'misspelling',
    nature: 'error',
    severity: 'major',
    confidence: 'high',
    source: 'local',
    location: {
      blockId: 'b_000001',
      sectionPath: 'Introduction',
      paragraphInSection: 1,
      estimatedPage: 1,
      charStart: 0,
      charEnd: 4,
      label: null,
    },
    related: [],
    original: 'test',
    suggestion: 'teste',
    explanation: 'x',
    status: 'open',
    userText: null,
    docOrder: 0,
    ...partial,
  };
}

const issues = [
  issue({ id: 'a', category: 'grammar' }),
  issue({ id: 'b', category: 'punctuation', status: 'ignored' }),
  issue({
    id: 'c',
    category: 'structure',
    nature: 'verify',
    location: { ...issue({}).location, sectionPath: 'Conclusion' },
  }),
];

describe('filtres de la liste des problèmes', () => {
  it('affiche par défaut les points à traiter', () => {
    expect(applyFilters(issues, DEFAULT_FILTERS).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('regroupe la ponctuation avec la grammaire', () => {
    const filtered = applyFilters(issues, { ...DEFAULT_FILTERS, category: 'grammar', view: 'all' });
    expect(filtered.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('filtre par nature et compte par catégorie', () => {
    const filters = { ...DEFAULT_FILTERS, natures: ['verify' as const] };
    expect(applyFilters(issues, filters).map((i) => i.id)).toEqual(['c']);
    expect(categoryCounts(issues, DEFAULT_FILTERS)).toMatchObject({
      all: 2,
      grammar: 1,
      structure: 1,
    });
  });

  it('garde les filtres dans l’adresse', () => {
    const params = filtersToParams(
      { category: 'style', natures: ['error', 'verify'], view: 'done' },
      'iss_9',
    );
    expect(params.toString()).toBe('categorie=style&nature=error%2Cverify&vue=done&point=iss_9');
    expect(parseFilters(params)).toEqual({
      category: 'style',
      natures: ['error', 'verify'],
      view: 'done',
    });
    expect(parseFilters(new URLSearchParams('categorie=pirate&vue=x'))).toEqual(DEFAULT_FILTERS);
  });

  it('regroupe par section dans l’ordre du document', () => {
    expect(groupBySection(issues).map((g) => [g.section, g.items.length])).toEqual([
      ['Introduction', 2],
      ['Conclusion', 1],
    ]);
  });
});

describe('wordDiff', () => {
  it('isole les mots modifiés', () => {
    expect(wordDiff('plusieurs serveurs informatique', 'plusieurs serveurs informatiques')).toEqual(
      {
        prefix: 'plusieurs serveurs ',
        removed: 'informatique',
        added: 'informatiques',
        suffix: '',
      },
    );
  });
});
