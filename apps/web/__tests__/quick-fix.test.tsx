import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AcceptReliableResultDto,
  type IssueDto,
  type IssueListDto,
  isReliableCorrection,
  type UndoAcceptResultDto,
} from '@wordfix/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickFix } from '@/components/results/quick-fix';
import { ApiError } from '@/lib/api/client';
import { useIssues } from '@/lib/hooks/use-issues';

/**
 * « Tout corriger » : vrais composants, vrai cache React Query ; l'API est un serveur
 * en mémoire qui applique la même règle partagée (isReliableCorrection).
 */
const server = vi.hoisted(() => ({
  issues: [] as IssueDto[],
  acceptCalls: 0,
  undoCalls: [] as string[][],
  failAccept: null as ApiError | null,
}));

const progress = () => ({
  id: 'ana_1',
  reviewedCount: server.issues.filter((i) => i.status !== 'open').length,
  issueCount: server.issues.length,
});

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    listIssues: (): Promise<IssueListDto> =>
      Promise.resolve({
        items: server.issues.map((i) => ({ ...i })),
        total: server.issues.length,
        blocks: {},
      }),
    acceptReliable: (): Promise<AcceptReliableResultDto> => {
      server.acceptCalls++;
      if (server.failAccept) return Promise.reject(server.failAccept);
      const ids = server.issues.filter(isReliableCorrection).map((i) => i.id);
      for (const issue of server.issues) if (ids.includes(issue.id)) issue.status = 'accepted';
      return Promise.resolve({ acceptedIds: ids, analysis: progress() });
    },
    undoAccept: (_analysisId: string, ids: string[]): Promise<UndoAcceptResultDto> => {
      server.undoCalls.push(ids);
      const reopened = server.issues.filter((i) => ids.includes(i.id) && i.status === 'accepted');
      for (const issue of reopened) issue.status = 'open';
      return Promise.resolve({ reopenedIds: reopened.map((i) => i.id), analysis: progress() });
    },
  },
}));

function issue(id: string, fields: Partial<IssueDto> = {}): IssueDto {
  return {
    id,
    category: 'spelling',
    subtype: 'test',
    nature: 'error',
    severity: 'minor',
    confidence: 'high',
    source: 'rules',
    location: {
      blockId: 'b',
      sectionPath: '',
      paragraphInSection: null,
      estimatedPage: null,
      charStart: 0,
      charEnd: 1,
      label: null,
    },
    related: [],
    original: `fote ${id}`,
    suggestion: `faute ${id}`,
    explanation: '',
    status: 'open',
    userText: null,
    docOrder: 0,
    ...fields,
  };
}

function Harness() {
  const { data } = useIssues('ana_1', true);
  return data ? <QuickFix analysisId="ana_1" issues={data.items} /> : null;
}

function renderQuickFix() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  server.issues = [
    issue('iss_a'),
    issue('iss_b', { category: 'grammar' }),
    issue('iss_c', { confidence: 'medium' }),
    issue('iss_d', { nature: 'verify', suggestion: null }),
    issue('iss_e', { category: 'style' }),
    issue('iss_f', { status: 'edited', userText: 'ma version' }),
    issue('iss_g', { status: 'ignored' }),
  ];
  server.acceptCalls = 0;
  server.undoCalls = [];
  server.failAccept = null;
  window.sessionStorage.clear();
});

describe('Tout corriger', () => {
  it('annonce seulement les corrections sûres encore à traiter', async () => {
    renderQuickFix();
    expect(await screen.findByRole('button', { name: 'Tout corriger (2)' })).toBeEnabled();
    expect(screen.getByText(/2 corrections sûres/)).toBeInTheDocument();
    expect(screen.getByText(/vos propres décisions ne sont jamais modifiés/)).toBeInTheDocument();
  });

  it('accepte en une action, puis permet d’annuler', async () => {
    renderQuickFix();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout corriger (2)' }));
    expect(server.acceptCalls).toBe(1);
    expect(await screen.findByText(/2 corrections acceptées\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tout corriger \(/ })).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem('wordfix.bulk.ana_1') ?? '[]')).toEqual([
      'iss_a',
      'iss_b',
    ]);
    // Décisions de l'utilisateur et points incertains intacts.
    expect(server.issues.map((i) => i.status)).toEqual([
      'accepted',
      'accepted',
      'open',
      'open',
      'open',
      'edited',
      'ignored',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Annuler « Tout corriger »' }));
    expect(server.undoCalls).toEqual([['iss_a', 'iss_b']]);
    expect(await screen.findByText(/2 corrections remises à traiter\./)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Tout corriger (2)' })).toBeEnabled();
    expect(window.sessionStorage.getItem('wordfix.bulk.ana_1')).toBeNull();
  });

  it('annulation après une décision de l’utilisateur : sa décision est conservée et signalée', async () => {
    renderQuickFix();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout corriger (2)' }));
    await screen.findByText(/2 corrections acceptées/);
    // Le serveur a entre-temps enregistré une modification de l'utilisateur sur iss_b.
    const b = server.issues.find((i) => i.id === 'iss_b');
    if (b) b.status = 'edited';
    await userEvent.click(screen.getByRole('button', { name: 'Annuler « Tout corriger »' }));
    expect(
      await screen.findByText(/1 correction remise à traiter\. 1 point modifié depuis/),
    ).toBeInTheDocument();
  });

  it('refus du serveur : message affiché, aucune décision supposée', async () => {
    server.failAccept = new ApiError(
      'ANALYSIS_NOT_READY',
      "Les résultats ne sont pas encore disponibles : l'analyse est en cours.",
      409,
    );
    renderQuickFix();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout corriger (2)' }));
    expect(await screen.findByText(/pas encore disponibles/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tout corriger (2)' })).toBeEnabled();
  });

  it('rien de sûr à corriger ni à annuler : la carte n’apparaît pas', async () => {
    server.issues = [issue('iss_c', { confidence: 'low' }), issue('iss_f', { status: 'accepted' })];
    renderQuickFix();
    await waitFor(() => expect(server.issues.length).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Correction rapide' })).toBeNull();
  });

  it('règle partagée : orthographe, grammaire, ponctuation ; erreur sûre ; proposition utilisable', () => {
    expect(isReliableCorrection(issue('x'))).toBe(true);
    expect(isReliableCorrection(issue('x', { category: 'punctuation' }))).toBe(true);
    expect(isReliableCorrection(issue('x', { category: 'coherence' }))).toBe(false);
    expect(isReliableCorrection(issue('x', { nature: 'suggestion' }))).toBe(false);
    expect(isReliableCorrection(issue('x', { confidence: 'medium' }))).toBe(false);
    expect(isReliableCorrection(issue('x', { status: 'verified' }))).toBe(false);
    expect(isReliableCorrection(issue('x', { suggestion: null }))).toBe(false);
    expect(isReliableCorrection(issue('x', { original: 'a', suggestion: 'a' }))).toBe(false);
    expect(isReliableCorrection(issue('x', { suggestion: 'a\nb' }))).toBe(false);
  });
});
