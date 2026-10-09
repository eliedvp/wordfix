import { render, screen } from '@testing-library/react';
import type { AnalysisDto } from '@wordfix/shared';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';
import { SummaryBand } from '@/components/results/summary-band';

/**
 * IA indisponible (quota, délai, panne) : l'analyse est COMPLETED avec les résultats
 * déterministes. L'interface affiche les résultats et une indication non bloquante,
 * jamais « L’analyse n’a pas abouti ».
 */
const completedWithoutAi: AnalysisDto = {
  id: 'ana_1',
  documentId: 'doc_1',
  documentName: 'Rapport.docx',
  status: 'COMPLETED',
  progress: 100,
  chunksTotal: 6,
  chunksDone: 6,
  steps: [],
  score: 82,
  scoreDetail: null,
  warnings: ['AI_CHECKS_SKIPPED'],
  skippedAiChecks: [
    { check: 'local', skipped: 3, total: 12 },
    { check: 'global', skipped: 1, total: 1 },
    { check: 'ambiguity', skipped: 2, total: 2 },
  ],
  errorCode: null,
  wordCount: 1200,
  estimatedPages: 4,
  natureCounts: { error: 2, suggestion: 3, potential: 1, verify: 1 },
  categoryCounts: {
    spelling: 3,
    grammar: 2,
    punctuation: 0,
    style: 1,
    coherence: 0,
    structure: 1,
  },
  issueCount: 7,
  reviewedCount: 0,
  createdAt: '2026-10-08T12:00:00.000Z',
  startedAt: '2026-10-08T12:00:01.000Z',
  completedAt: '2026-10-08T12:00:20.000Z',
  etaSeconds: null,
};

vi.mock('@/lib/hooks/use-analysis', () => ({
  useAnalysis: () => ({ data: completedWithoutAi, error: null, isPending: false }),
}));
vi.mock('@/components/results/workbench', () => ({
  Workbench: ({ analysis }: { analysis: AnalysisDto }) => (
    <div>Résultats de {analysis.documentName}</div>
  ),
}));

const AI_NOTICE = /Certaines vérifications avancées par IA n’ont pas pu être effectuées/;

describe('Analyse terminée sans IA', () => {
  it('affiche les résultats, jamais l’écran « L’analyse n’a pas abouti »', () => {
    render(<AnalysisScreen id="ana_1" />);
    expect(screen.getByText('Résultats de Rapport.docx')).toBeInTheDocument();
    expect(screen.queryByText(/n’a pas abouti/)).not.toBeInTheDocument();
    expect(screen.queryByText(/momentanément indisponible/)).not.toBeInTheDocument();
  });

  it('signale, sans bloquer, que des vérifications par IA manquent', () => {
    render(
      <SummaryBand analysis={completedWithoutAi} activeNatures={[]} onToggleNature={() => {}} />,
    );
    expect(screen.getByText(AI_NOTICE)).toBeInTheDocument();
    expect(screen.getByText('82')).toBeInTheDocument();
  });

  it('détaille les vérifications IA non effectuées (limite de débit, indisponibilité…)', () => {
    render(
      <SummaryBand analysis={completedWithoutAi} activeNatures={[]} onToggleNature={() => {}} />,
    );
    const list = screen.getByRole('list', { name: 'Vérifications IA non effectuées' });
    expect(list).toHaveTextContent(
      'Relecture par IA paragraphe par paragraphe : 3 passages sur 12 non relus.',
    );
    expect(list).toHaveTextContent(
      'Cohérence du document entier (contradictions entre les parties) : non vérifiée.',
    );
    expect(list).toHaveTextContent('Mots ambigus : 2 cas non départagés par l’IA.');
  });

  it('aucun détail quand toutes les vérifications IA ont abouti', () => {
    render(
      <SummaryBand
        analysis={{ ...completedWithoutAi, warnings: [], skippedAiChecks: [] }}
        activeNatures={[]}
        onToggleNature={() => {}}
      />,
    );
    expect(screen.queryByText(AI_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Vérifications IA non effectuées' })).toBeNull();
  });
});
