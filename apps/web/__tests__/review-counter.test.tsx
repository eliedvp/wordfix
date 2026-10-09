import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AnalysisDto,
  IssueDto,
  IssueListDto,
  IssueNature,
  IssueStatus,
  UpdatedIssueDto,
} from '@wordfix/shared';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';
import { ApiError } from '@/lib/api/client';

/**
 * Compteur « points traités » de l'écran de relecture : vrais composants, vrais
 * hooks de données et vrai cache React Query ; seule l'API est remplacée par un
 * serveur en mémoire, qui peut retarder, réordonner ou refuser ses réponses.
 * Le compteur affiché est toujours comparé à l'état du serveur, jamais supposé.
 */

// --- Adresse de la page (filtres et point ouvert sont dans l'URL) ------------------
const url = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  return {
    get: () => search,
    set: (next: string) => {
      search = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/analyses/ana_1',
  useRouter: () => ({
    replace: (href: string) => url.set(href.split('?')[1] ?? ''),
    push: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(url.subscribe, url.get, url.get)),
}));

// --- Serveur simulé --------------------------------------------------------------
interface Server {
  issues: IssueDto[];
  /** Réponse de GET /analyses/:id refusée (429) tant que ce drapeau est levé. */
  analysisDown: boolean;
  analysisCalls: number;
  /** PATCH retenus (pour réordonner les réponses) ou refusés, par identifiant. */
  hold: Map<string, Promise<void>>;
  failPatch: Set<string>;
  /** PATCH réussi mais sans compteur dans la réponse (API d'une version antérieure). */
  withoutProgress: boolean;
}
const server: Server = vi.hoisted(() => ({
  issues: [],
  analysisDown: false,
  analysisCalls: 0,
  hold: new Map(),
  failPatch: new Set(),
  withoutProgress: false,
}));

// Messages affichés à l'utilisateur (un succès ne doit jamais produire d'erreur).
const toasts = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, {
    success: () => undefined,
    error: (message: string) => toasts.errors.push(message),
  }),
}));

const reviewed = () => server.issues.filter((issue) => issue.status !== 'open').length;

function analysisDto(): AnalysisDto {
  return {
    id: 'ana_1',
    documentId: 'doc_1',
    documentName: 'Rapport.docx',
    status: 'COMPLETED',
    progress: 100,
    chunksTotal: 3,
    chunksDone: 3,
    steps: [],
    score: 80,
    scoreDetail: null,
    warnings: [],
    skippedAiChecks: [],
    errorCode: null,
    wordCount: 1000,
    estimatedPages: 3,
    natureCounts: { error: 1, suggestion: 1, potential: 1, verify: 1 },
    categoryCounts: {
      spelling: 2,
      grammar: 0,
      punctuation: 0,
      style: 1,
      coherence: 1,
      structure: 0,
    },
    issueCount: server.issues.length,
    reviewedCount: reviewed(),
    createdAt: '2026-10-09T12:00:00.000Z',
    startedAt: '2026-10-09T12:00:01.000Z',
    completedAt: '2026-10-09T12:00:30.000Z',
    etaSeconds: null,
  };
}

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getAnalysis: () => {
      server.analysisCalls++;
      if (server.analysisDown) {
        return Promise.reject(new ApiError('RATE_LIMITED', 'Trop de requêtes', 429));
      }
      return Promise.resolve(analysisDto());
    },
    listIssues: (): Promise<IssueListDto> =>
      Promise.resolve({
        items: server.issues.map((issue) => ({ ...issue })),
        total: server.issues.length,
        blocks: {},
      }),
    updateIssue: async (id: string, status: IssueStatus): Promise<UpdatedIssueDto> => {
      const issue = server.issues.find((item) => item.id === id);
      if (!issue) throw new ApiError('NOT_FOUND', 'Introuvable', 404);
      // Écriture et recomptage côté serveur au moment de la requête, comme l'API.
      if (server.failPatch.has(id)) {
        await server.hold.get(id);
        throw new ApiError('NETWORK_ERROR', 'Connexion impossible.', 0);
      }
      issue.status = status;
      if (server.withoutProgress) {
        await server.hold.get(id);
        return { ...issue } as UpdatedIssueDto;
      }
      const response: UpdatedIssueDto = {
        ...issue,
        analysis: { id: 'ana_1', reviewedCount: reviewed(), issueCount: server.issues.length },
      };
      await server.hold.get(id);
      return response;
    },
  },
}));

function issue(id: string, nature: IssueNature, category: IssueDto['category'], order: number) {
  return {
    id,
    category,
    subtype: 'test',
    nature,
    severity: 'minor',
    confidence: 'medium',
    source: 'rules',
    location: {
      blockId: `b_${order}`,
      sectionPath: '1. Introduction',
      paragraphInSection: order,
      estimatedPage: 1,
      charStart: 0,
      charEnd: 5,
      label: null,
    },
    related: [],
    original: `extrait ${id}`,
    // Les points « À examiner » et « À vérifier » n'ont pas de correction : « J'ai vérifié ».
    suggestion: nature === 'error' || nature === 'suggestion' ? `correction ${id}` : null,
    explanation: `Explication ${id}.`,
    status: 'open',
    userText: null,
    docOrder: order,
  } satisfies IssueDto;
}

// --- Rendu -------------------------------------------------------------------------
function renderScreen() {
  // Pas de nouvel essai automatique : chaque échec simulé est visible tel quel.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AnalysisScreen id="ana_1" />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const counter = () => screen.getByText(/\d+ \/ \d+ points traités/);
const list = () => screen.getByRole('navigation', { name: 'Points relevés' });
/** Points affichés comme traités dans la liste (icône « Traité »). */
const treatedInList = () =>
  within(list())
    .queryAllByLabelText('Traité')
    .map((icon) => icon.closest('button')?.textContent ?? '');

async function decide(label: 'Ignorer' | 'J’ai vérifié') {
  const panel = await screen.findByRole('article', { name: 'Détail du point' });
  await userEvent.click(await within(panel).findByRole('button', { name: label }));
}

beforeEach(() => {
  url.set('');
  server.issues = [
    issue('iss_a', 'error', 'spelling', 1),
    issue('iss_b', 'suggestion', 'style', 2),
    issue('iss_c', 'potential', 'coherence', 3),
    issue('iss_d', 'verify', 'spelling', 4),
  ];
  server.analysisDown = false;
  server.analysisCalls = 0;
  server.hold = new Map();
  server.failPatch = new Set();
  server.withoutProgress = false;
  toasts.errors = [];
  // Écran large : le détail du point est affiché à côté de la liste.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Compteur « points traités » après une décision', () => {
  it('« Ignorer » puis « J’ai vérifié » : compteur et statuts identiques au serveur', async () => {
    renderScreen();
    expect(await screen.findByText('0 / 4 points traités')).toBeInTheDocument();

    await decide('Ignorer'); // iss_a
    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'));
    expect(server.issues.find((i) => i.id === 'iss_a')?.status).toBe('ignored');

    // Point suivant encore ouvert : iss_b (suggestion), puis iss_c (sans correction).
    await decide('Ignorer'); // iss_b
    await decide('J’ai vérifié'); // iss_c
    await waitFor(() => expect(counter()).toHaveTextContent('3 / 4 points traités'));
    expect(server.issues.map((i) => i.status)).toEqual(['ignored', 'ignored', 'verified', 'open']);
    expect(counter()).toHaveTextContent(`${reviewed()} / 4 points traités`);
  });

  it('relecture de l’analyse refusée après le PATCH (429) : le compteur suit quand même la décision', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    server.analysisDown = true;

    await decide('Ignorer');
    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'));
    // La relecture a bien été tentée et refusée : le compteur vient de la réponse du PATCH.
    expect(server.analysisCalls).toBeGreaterThan(1);
    expect(reviewed()).toBe(1);
  });

  it('relecture échouée : retentée jusqu’à réussir, le compteur rattrape le serveur', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    server.analysisDown = true;
    await decide('Ignorer');
    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'));

    // Entre-temps, un autre onglet traite un point ; l'API redevient disponible.
    server.issues[3]!.status = 'verified';
    server.analysisDown = false;
    await waitFor(() => expect(counter()).toHaveTextContent('2 / 4 points traités'), {
      timeout: 8000,
    });
  }, 15_000);

  it('décisions rapides dont les réponses arrivent dans le désordre : le compteur ne recule pas', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    let releaseFirst!: () => void;
    server.hold.set('iss_a', new Promise((resolve) => (releaseFirst = resolve)));

    await decide('Ignorer'); // iss_a : réponse retenue (compteur serveur = 1)
    await decide('Ignorer'); // iss_b : réponse immédiate (compteur serveur = 2)
    await waitFor(() => expect(counter()).toHaveTextContent('2 / 4 points traités'));

    await act(async () => releaseFirst()); // la réponse ancienne (« 1 ») arrive en dernier
    await waitFor(() => expect(server.analysisCalls).toBeGreaterThan(2));
    expect(counter()).toHaveTextContent('2 / 4 points traités');
    expect(reviewed()).toBe(2);
  });

  it('décision refusée : seul ce point redevient « à traiter », les autres décisions restent', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    let releaseFailure!: () => void;
    server.failPatch.add('iss_a');
    server.hold.set('iss_a', new Promise((resolve) => (releaseFailure = resolve)));

    await decide('Ignorer'); // iss_a : échouera
    await decide('Ignorer'); // iss_b : réussit
    await act(async () => releaseFailure());

    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'));
    // Un vrai échec reste signalé.
    expect(toasts.errors).toEqual([
      'Votre choix n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Traités' }));
    expect(treatedInList()).toEqual([expect.stringContaining('extrait iss_b')]);
    expect(server.issues.map((i) => i.status)).toEqual(['open', 'ignored', 'open', 'open']);
  });

  it('réponse du PATCH sans compteur (API antérieure) : décision conservée, aucun faux message d’échec', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    server.withoutProgress = true;
    server.analysisDown = true; // la relecture est d'abord refusée, comme dans le test E2E

    await decide('Ignorer');
    await waitFor(() => expect(server.analysisCalls).toBeGreaterThan(1));
    // Enregistré sur le serveur, affiché comme traité, sans message d'échec.
    expect(server.issues[0]!.status).toBe('ignored');
    expect(toasts.errors).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Traités' }));
    expect(treatedInList()).toEqual([expect.stringContaining('extrait iss_a')]);
    // Sans compteur dans la réponse, il attend la relecture… puis la rattrape.
    expect(counter()).toHaveTextContent('0 / 4 points traités');
    server.analysisDown = false;
    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'), {
      timeout: 8000,
    });
  }, 15_000);

  it('changement de filtre : le compteur reste global (traités / total), la liste suit le filtre', async () => {
    renderScreen();
    await screen.findByText('0 / 4 points traités');
    await decide('Ignorer'); // iss_a (orthographe)
    await waitFor(() => expect(counter()).toHaveTextContent('1 / 4 points traités'));

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Filtrer par catégorie' })).getByRole('button', {
        name: /Style/,
      }),
    );
    expect(url.get()).toContain('categorie=style');
    expect(counter()).toHaveTextContent('1 / 4 points traités');

    await userEvent.click(screen.getByRole('button', { name: 'Traités' }));
    expect(url.get()).toContain('vue=done');
    // Aucun point de style traité, compteur inchangé.
    expect(
      screen.queryByRole('navigation', { name: 'Points relevés' }) ? treatedInList() : [],
    ).toEqual([]);
    expect(counter()).toHaveTextContent('1 / 4 points traités');

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Filtrer par catégorie' })).getByRole('button', {
        name: /Tous/,
      }),
    );
    expect(treatedInList()).toEqual([expect.stringContaining('extrait iss_a')]);
  });

  it('rechargement de la page : compteur et points traités relus depuis le serveur', async () => {
    const first = renderScreen();
    await screen.findByText('0 / 4 points traités');
    await decide('Ignorer');
    await decide('Ignorer');
    await waitFor(() => expect(counter()).toHaveTextContent('2 / 4 points traités'));
    first.unmount();

    // Nouveau cache (comme un rechargement), même adresse.
    renderScreen();
    expect(await screen.findByText('2 / 4 points traités')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Traités' }));
    expect(treatedInList()).toEqual([
      expect.stringContaining('extrait iss_a'),
      expect.stringContaining('extrait iss_b'),
    ]);
  });
});
