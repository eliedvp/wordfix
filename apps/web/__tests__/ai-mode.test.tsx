import { render, screen } from '@testing-library/react';
import type { AnalysisDto } from '@wordfix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SummaryBand } from '@/components/results/summary-band';
import { aiPrivacyStatement, privacyStatements } from '@/lib/copy';

vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));

/**
 * Mode sans IA : l'analyse terminée et son score ne doivent jamais laisser croire que
 * des vérifications par IA ont été faites ; la confidentialité dit ce qui est vraiment
 * fait du texte, selon le mode réellement configuré.
 */
const base: AnalysisDto = {
  id: 'ana_1',
  documentId: 'doc_1',
  documentName: 'Rapport.docx',
  status: 'COMPLETED',
  progress: 100,
  chunksTotal: 0,
  chunksDone: 0,
  steps: [],
  score: 91,
  scoreDetail: null,
  warnings: ['HEADINGS_INFERRED', 'AI_DISABLED'],
  skippedAiChecks: [],
  errorCode: null,
  wordCount: 1200,
  estimatedPages: 4,
  natureCounts: { error: 2, suggestion: 1, potential: 0, verify: 1 },
  categoryCounts: { spelling: 3, grammar: 1, punctuation: 0, style: 0, coherence: 0, structure: 0 },
  issueCount: 4,
  reviewedCount: 0,
  createdAt: '2026-10-10T12:00:00.000Z',
  startedAt: '2026-10-10T12:00:01.000Z',
  completedAt: '2026-10-10T12:00:05.000Z',
  etaSeconds: null,
};

const band = (analysis: AnalysisDto) =>
  render(<SummaryBand analysis={analysis} activeNatures={[]} onToggleNature={() => {}} />);

describe('Analyse sans IA : clairement signalée', () => {
  it('score marqué « Sans IA », portée limitée, avertissement visible et en premier', () => {
    band(base);
    expect(screen.getByText('Sans IA')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'Score des vérifications automatiques, sans IA : 91 sur 100',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ce score ne tient compte que des vérifications automatiques/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reflète la forme et la cohérence/)).not.toBeInTheDocument();
    // L'avertissement « sans IA » est le premier de la liste des avertissements.
    const notice = screen.getByText(/^Analyse effectuée sans IA/).closest('li');
    expect(notice?.textContent).toMatch(/n’ont pas été faites/);
    expect(notice?.parentElement?.firstElementChild).toBe(notice);
  });

  it('analyse avec IA : ni badge ni mention « sans IA »', () => {
    band({ ...base, warnings: [] });
    expect(screen.queryByText('Sans IA')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Score : 91 sur 100' })).toBeInTheDocument();
    expect(screen.getByText(/reflète la forme et la cohérence/)).toBeInTheDocument();
  });
});

describe('Confidentialité : envoi à un service d’IA selon le mode réel', () => {
  it('sans IA (et tests) : aucun envoi ; jamais « envoyé à OpenAI »', () => {
    for (const mode of ['none', 'fake'] as const) {
      expect(aiPrivacyStatement(mode)).toBe(
        'Votre document n’est envoyé à aucun service d’intelligence artificielle.',
      );
      expect(privacyStatements(mode).join(' ')).not.toMatch(/OpenAI/);
    }
  });

  it('fournisseurs payants : nommés explicitement', () => {
    expect(aiPrivacyStatement('openai')).toBe(
      'Pour l’analyse, le texte de votre document est envoyé à OpenAI.',
    );
    expect(aiPrivacyStatement('gemini')).toMatch(/envoyé à Google \(Gemini\)/);
  });

  it('mode inconnu (API injoignable) : formulation prudente, qui ne promet pas l’absence d’envoi', () => {
    expect(aiPrivacyStatement(null)).toMatch(/peut être envoyé/);
    expect(privacyStatements(null)).toHaveLength(5);
  });
});

describe('Lecture du mode IA côté serveur', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lit le mode exposé par l’API', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ mode: 'none' })));
    vi.stubGlobal('fetch', fetchMock);
    const { getAiMode } = await import('@/lib/ai-mode');
    await expect(getAiMode()).resolves.toBe('none');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/ai-mode$/),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('API injoignable ou réponse inattendue : mode inconnu (null)', async () => {
    const { getAiMode } = await import('@/lib/ai-mode');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('connexion refusée'))),
    );
    await expect(getAiMode()).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ mode: 'mistral' }))),
    );
    await expect(getAiMode()).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 500 }))),
    );
    await expect(getAiMode()).resolves.toBeNull();
  });
});
