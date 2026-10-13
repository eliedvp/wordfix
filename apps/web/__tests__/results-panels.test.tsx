import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AcceptReliableResultDto,
  type AnalysisDto,
  type AnalysisWarning,
  type DocumentDto,
  type DocumentStructureDto,
  type ExportDto,
  type IssueDto,
  type IssueListDto,
  type IssueStatus,
  isReliableCorrection,
  type UndoAcceptResultDto,
  type UpdatedIssueDto,
} from '@wordfix/shared';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';

/**
 * Écran des résultats : action principale « Corriger et télécharger » toujours visible,
 * puis trois panneaux facultatifs. Vrais composants, vrais hooks et vrai cache
 * React Query ; seule l'API est un serveur en mémoire. Les chiffres affichés sont
 * comparés à l'état du serveur, jamais supposés.
 */

const url = vi.hoisted(() => {
  let search = '';
  /** Comme Next.js, l'adresse peut n'être mise à jour qu'après coup. */
  let deferred = false;
  const listeners = new Set<() => void>();
  return {
    get: () => search,
    set(next: string) {
      search = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    defer: (value: boolean) => {
      deferred = value;
    },
    replace(href: string) {
      const next = href.split('?')[1] ?? '';
      if (deferred) setTimeout(() => this.set(next), 30);
      else this.set(next);
    },
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/analyses/ana_1',
  useRouter: () => ({
    replace: (href: string) => url.replace(href),
    push: (href: string) => url.replace(href),
  }),
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(url.subscribe, url.get, url.get)),
}));

const toasts = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('sonner', () => ({
  toast: Object.assign((message: string) => toasts.messages.push(message), {
    success: (message: string) => toasts.messages.push(message),
    error: (message: string) => toasts.messages.push(message),
  }),
}));

const server = vi.hoisted(() => ({
  issues: [] as IssueDto[],
  warnings: [] as AnalysisWarning[],
  acceptCalls: 0,
  createCalls: 0,
  /** Réponse du PATCH retenue tant que cette promesse n'est pas résolue. */
  hold: null as Promise<void> | null,
  /** Structure renvoyée avec la liste des points (absente : API antérieure). */
  structure: undefined as DocumentStructureDto | null | undefined,
}));
const reviewed = () => server.issues.filter((issue) => issue.status !== 'open').length;
const progress = () => ({
  id: 'ana_1',
  reviewedCount: reviewed(),
  issueCount: server.issues.length,
});

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
    score: 77,
    scoreDetail: null,
    warnings: server.warnings,
    skippedAiChecks: [],
    errorCode: null,
    wordCount: 1000,
    estimatedPages: 3,
    natureCounts: { error: 3, suggestion: 1, potential: 1, verify: 0 },
    categoryCounts: {
      spelling: 3,
      grammar: 0,
      punctuation: 0,
      style: 1,
      coherence: 0,
      structure: 1,
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
    getAnalysis: () => Promise.resolve(analysisDto()),
    listIssues: (): Promise<IssueListDto> =>
      Promise.resolve({
        items: server.issues.map((issue) => ({ ...issue })),
        total: server.issues.length,
        blocks: {},
        ...(server.structure === undefined ? {} : { structure: server.structure }),
      }),
    updateIssue: async (
      id: string,
      status: IssueStatus,
      userText?: string,
    ): Promise<UpdatedIssueDto> => {
      const issue = server.issues.find((item) => item.id === id);
      if (!issue) throw new Error('introuvable');
      issue.status = status;
      issue.userText = status === 'edited' ? (userText ?? null) : null;
      const response = { ...issue, analysis: progress() };
      await server.hold;
      return response;
    },
    acceptReliable: (): Promise<AcceptReliableResultDto> => {
      server.acceptCalls++;
      const ids = server.issues.filter(isReliableCorrection).map((i) => i.id);
      for (const issue of server.issues) if (ids.includes(issue.id)) issue.status = 'accepted';
      return Promise.resolve({ acceptedIds: ids, analysis: progress() });
    },
    undoAccept: (_id: string, ids: string[]): Promise<UndoAcceptResultDto> => {
      const reopened = server.issues.filter((i) => ids.includes(i.id) && i.status === 'accepted');
      for (const issue of reopened) issue.status = 'open';
      return Promise.resolve({ reopenedIds: reopened.map((i) => i.id), analysis: progress() });
    },
    getDocument: (): Promise<DocumentDto> =>
      Promise.resolve({ id: 'doc_1', fileAvailable: true } as DocumentDto),
    createExport: (): Promise<ExportDto> => {
      server.createCalls++;
      // Demande acceptée ; la préparation reste en cours ici (seule la demande est vérifiée).
      return Promise.resolve({
        id: 'exp_1',
        analysisId: 'ana_1',
        status: 'QUEUED',
        requestedCount: 2,
        appliedCount: 0,
        skipped: [],
        errorCode: null,
        options: { typography: false, layout: false },
        beautified: null,
        createdAt: '2026-10-11T10:00:00.000Z',
        completedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
    getExport: () => new Promise<ExportDto>(() => undefined),
    downloadExport: () => Promise.reject(new Error('non utilisé')),
  },
}));

function issue(id: string, order: number, fields: Partial<IssueDto> = {}): IssueDto {
  return {
    id,
    category: 'spelling',
    subtype: 'test',
    nature: 'error',
    severity: 'minor',
    confidence: 'high',
    source: 'rules',
    location: {
      blockId: `b_${order}`,
      sectionPath: '1. Introduction',
      paragraphInSection: order,
      estimatedPage: 1,
      charStart: 0,
      charEnd: 4,
      label: null,
    },
    related: [],
    original: `fote ${id}`,
    suggestion: `faute ${id}`,
    explanation: `Explication ${id}.`,
    status: 'open',
    userText: null,
    docOrder: order,
    ...fields,
  };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AnalysisScreen id="ana_1" />
    </QueryClientProvider>,
  );
}

const actions = () => screen.getByRole('navigation', { name: 'Autres actions' });
const action = (name: string) => within(actions()).getByRole('button', { name });
const panel = (id: string) => document.getElementById(`panneau-${id}`) as HTMLElement;
/** Carte de l'action principale, toujours visible. */
const card = () => screen.getByRole('region', { name: 'Votre document corrigé' });
/** Bouton principal, une fois les points chargés. */
const mainButton = () => within(card()).findByRole('button', { name: 'Corriger et télécharger' });
/** Ouvre « Détails et options » (repliés par défaut) dans la carte principale. */
const openDetails = async () => {
  const summary = await within(card()).findByText('Détails et options');
  if (!summary.closest('details')?.open) await userEvent.click(summary);
};
/** Écran des résultats affiché (analyse chargée). */
const ready = () => screen.findByRole('navigation', { name: 'Autres actions' });
const PANEL_IDS = ['infos', 'corriger', 'mise-en-forme'];
const openPanels = () => PANEL_IDS.filter((id) => !panel(id).hidden);
/** Contenu du presse-papiers simulé (vide s'il n'a jamais été écrit). */
const clipboardText = () => navigator.clipboard.readText().catch(() => '');

beforeEach(() => {
  url.defer(false);
  url.set('');
  server.issues = [
    issue('iss_a', 1), // correction fiable
    issue('iss_b', 2, { confidence: 'medium' }), // incertaine : jamais acceptée d'office
    issue('iss_c', 3, { nature: 'suggestion', category: 'style', confidence: 'medium' }),
    issue('iss_d', 4, {
      nature: 'potential',
      category: 'structure',
      subtype: 'heading_numbering',
      suggestion: null,
    }),
    issue('iss_e', 5, { status: 'edited', userText: 'ma version' }), // décision antérieure
  ];
  server.warnings = ['AI_DISABLED'];
  server.acceptCalls = 0;
  server.createCalls = 0;
  server.hold = null;
  server.structure = undefined;
  toasts.messages = [];
  window.sessionStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = () => {};
});

describe('Partie supérieure et actions', () => {
  it('haut inchangé (score, document, compteurs, progression) ; avertissements déplacés', async () => {
    renderScreen();
    const top = await screen.findByRole('region', { name: 'Synthèse de l’analyse' });
    expect(within(top).getByText('77')).toBeInTheDocument();
    expect(within(top).getByRole('heading', { name: 'Rapport.docx' })).toBeInTheDocument();
    expect(within(top).getByRole('group', { name: 'Filtrer par nature' })).toBeInTheDocument();
    expect(within(top).getByText('1 / 5 points traités')).toBeInTheDocument();
    expect(within(top).getByText('Comment est calculé ce score ?')).toBeInTheDocument();
    // L'avertissement n'est plus en haut, mais dans « Informations sur l'analyse ».
    expect(within(top).queryByText(/^Analyse effectuée sans IA/)).toBeNull();
    expect(within(top).getByText('Sans IA')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel('infos')).getByText(/^Analyse effectuée sans IA/)).toBeInTheDocument(),
    );
  });

  it('action principale visible dès le chargement, avant les actions facultatives', async () => {
    renderScreen();
    await ready();
    const button = await mainButton();
    await waitFor(() => expect(button).toBeEnabled());
    // Ce qui sera appliqué, en une phrase ; détails et options repliés.
    expect(within(card()).getByTestId('export-summary')).toHaveTextContent(
      '2 corrections seront appliquées : 1 choisie par vous et 1 correction fiable (annulable).',
    );
    expect(within(card()).getByText('Détails et options').closest('details')).not.toHaveAttribute(
      'open',
    );
    // La carte précède la rangée des actions facultatives.
    expect(
      card().compareDocumentPosition(actions()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(openPanels()).toEqual([]);
  });

  it('bouton principal hors de l’écran (mobile) : repris en bas de l’écran, même action, une seule demande', async () => {
    // Le navigateur signale la rangée du bouton principal sous le bas de l'écran.
    let report: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;
    const original = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
        report = callback;
      }
      observe() {
        report?.([{ isIntersecting: false, boundingClientRect: { top: 900 } as DOMRect }]);
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      renderScreen();
      await ready();
      await waitFor(() =>
        expect(
          within(card()).getByRole('button', { name: 'Corriger et télécharger' }),
        ).toBeEnabled(),
      );
      const bar = await screen.findByTestId('barre-action-principale');
      // Hors de la carte (aucun doublon dans la carte), même libellé, même état.
      expect(card()).not.toContainElement(bar);
      const barButton = within(bar).getByRole('button', { name: 'Corriger et télécharger' });
      expect(barButton).toBeEnabled();
      act(() => {
        barButton.click();
        barButton.click();
      });
      await waitFor(() => expect(server.createCalls).toBe(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(server.acceptCalls).toBe(1);
      expect(server.createCalls).toBe(1);
      // La rangée du bouton redevient visible : la barre disparaît.
      act(() => report?.([{ isIntersecting: true, boundingClientRect: { top: 300 } as DOMRect }]));
      expect(screen.queryByTestId('barre-action-principale')).toBeNull();
    } finally {
      window.IntersectionObserver = original;
    }
  });

  it('barre du bas activée au clavier : le focus passe au bouton principal de la carte et y reste', async () => {
    const user = userEvent.setup();
    let report: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;
    const original = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
        report = callback;
      }
      observe() {
        report?.([{ isIntersecting: false, boundingClientRect: { top: 900 } as DOMRect }]);
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      renderScreen();
      await ready();
      const inline = await mainButton();
      await waitFor(() => expect(inline).toBeEnabled());
      const bar = await screen.findByTestId('barre-action-principale');
      const barButton = within(bar).getByRole('button', { name: 'Corriger et télécharger' });
      barButton.focus();
      await user.keyboard('{Enter}');
      // Focus transféré au bouton de la carte (pas à la barre, pas perdu sur la page).
      expect(document.activeElement).toBe(inline);
      expect(card()).toContainElement(document.activeElement as HTMLElement);
      await waitFor(() => expect(server.createCalls).toBe(1));
      expect(server.acceptCalls).toBe(1);
      // La carte est à l'écran : la barre disparaît, le focus reste sur le bouton de la carte,
      // occupé mais toujours focalisable (jamais `disabled` pendant la préparation).
      act(() => report?.([{ isIntersecting: true, boundingClientRect: { top: 300 } as DOMRect }]));
      expect(screen.queryByTestId('barre-action-principale')).toBeNull();
      expect(document.activeElement).toBe(inline);
      expect(inline).toHaveAccessibleName('Préparation de votre document…');
      expect(inline).toHaveAttribute('aria-disabled', 'true');
      expect(inline).not.toBeDisabled();
    } finally {
      window.IntersectionObserver = original;
    }
  });

  it('aucun panneau ouvert au chargement ; un seul à la fois ; un second clic referme', async () => {
    renderScreen();
    await ready();
    expect(openPanels()).toEqual([]);
    for (const name of ['Informations sur l’analyse', 'Revoir les corrections', 'Mise en forme']) {
      expect(action(name)).toHaveAttribute('aria-expanded', 'false');
    }

    await userEvent.click(action('Informations sur l’analyse'));
    expect(openPanels()).toEqual(['infos']);
    expect(url.get()).toBe('panneau=infos');
    await userEvent.click(action('Mise en forme'));
    expect(openPanels()).toEqual(['mise-en-forme']);
    expect(action('Informations sur l’analyse')).toHaveAttribute('aria-expanded', 'false');
    expect(action('Mise en forme')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(action('Mise en forme'));
    expect(openPanels()).toEqual([]);
    expect(url.get()).toBe('');
  });

  it('les compteurs du haut ouvrent « Corriger » avec le filtre correspondant', async () => {
    renderScreen();
    const natures = await screen.findByRole('group', { name: 'Filtrer par nature' });
    await userEvent.click(within(natures).getByRole('button', { name: /À examiner/ }));
    expect(url.get()).toContain('nature=potential');
    expect(url.get()).toContain('panneau=corriger');
    expect(openPanels()).toEqual(['corriger']);
    const list = await within(panel('corriger')).findByRole('navigation', {
      name: 'Points relevés',
    });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(list).toHaveTextContent('fote iss_d');
  });

  it('deux filtres changés coup sur coup : aucun n’est perdu (adresse mise à jour après coup)', async () => {
    url.set('panneau=corriger&nature=potential');
    renderScreen();
    const natures = await screen.findByRole('group', { name: 'Filtrer par nature' });
    await within(panel('corriger')).findByRole('group', { name: 'Afficher' });
    url.defer(true);
    fireEvent.click(within(natures).getByRole('button', { name: /À examiner/ }));
    fireEvent.click(within(panel('corriger')).getByRole('button', { name: 'Traités' }));
    await waitFor(() => expect(url.get()).toContain('vue=done'));
    await new Promise((r) => setTimeout(r, 60));
    expect(url.get()).not.toContain('nature=');
    expect(url.get()).toContain('panneau=corriger');
  });
});

describe('« Aller à « Corriger et télécharger » » (relecture terminée)', () => {
  /** Relecture terminée affichée ; `before` attend l'état voulu de la carte avant le clic. */
  const goTo = async (before: () => Promise<unknown>) => {
    url.set('panneau=corriger');
    renderScreen();
    await ready();
    const button = await within(panel('corriger')).findByRole('button', {
      name: /^Aller à «\sCorriger et télécharger\s»$/,
    });
    await before();
    await userEvent.click(button);
  };

  it('focus sur le bouton principal de la carte, jamais sur un autre bouton', async () => {
    // Tout est traité : une correction acceptée et une modifiée à appliquer.
    server.issues = server.issues.map((i, n) => ({
      ...i,
      status: i.status === 'edited' ? 'edited' : n === 0 ? 'accepted' : 'ignored',
    }));
    const main = () => within(card()).getByRole('button', { name: 'Corriger et télécharger' });
    await goTo(() => waitFor(() => expect(main()).toBeEnabled()));
    expect(document.activeElement).toBe(main());
  });

  it('rien à appliquer (bouton désactivé) : focus sur le titre de la carte, qui l’explique', async () => {
    server.issues = server.issues.map((i) => ({ ...i, status: 'ignored', userText: null }));
    await goTo(() =>
      // Disponibilité du fichier confirmée : seul « rien à appliquer » désactive le bouton.
      waitFor(() =>
        expect(
          within(card()).getByText(/acceptez ou modifiez au moins un point/),
        ).toBeInTheDocument(),
      ),
    );
    expect(within(card()).getByRole('button', { name: 'Corriger et télécharger' })).toBeDisabled();
    expect(document.activeElement).toBe(
      within(card()).getByRole('heading', { name: 'Votre document corrigé' }),
    );
    expect(within(card()).getByText(/acceptez ou modifiez au moins un point/)).toBeInTheDocument();
  });
});

describe('Panneaux', () => {
  it('Informations : avertissements et problèmes détectés, chiffres réels, accès aux points', async () => {
    url.set('panneau=infos');
    renderScreen();
    await ready();
    const infos = panel('infos');
    const byType = await within(infos).findByRole('list', { name: 'Par type' });
    expect(byType).toHaveTextContent('1correction fiable, applicable avec « Tout corriger »');
    expect(byType).toHaveTextContent('1point à vérifier manuellement');
    expect(byType).toHaveTextContent('2autres suggestions');
    expect(byType).toHaveTextContent('1point déjà traité');
    const table = within(infos).getByRole('table');
    expect(within(table).getByRole('row', { name: /Orthographe 3 2/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Structure 1 1/ })).toBeInTheDocument();
    expect(
      within(infos).getByText(/numéros de page indiqués pour chaque point sont estimés/),
    ).toBeInTheDocument();

    await userEvent.click(
      within(table).getByRole('button', { name: 'Voir les points : Structure' }),
    );
    expect(url.get()).toContain('categorie=structure');
    expect(openPanels()).toEqual(['corriger']);
  });

  it('Mise en forme : contrôles faits, non faits (sans IA) et à faire dans Word, jamais présentés comme vérifiés', async () => {
    url.set('panneau=mise-en-forme');
    renderScreen();
    await ready();
    const formatting = panel('mise-en-forme');
    await within(formatting).findByRole('checkbox', { name: /Typographie française/ });
    expect(
      within(formatting).getByRole('checkbox', { name: /Harmonisation de la présentation/ }),
    ).not.toBeChecked();
    const rows = within(formatting).getAllByRole('listitem');
    const row = (label: string) => rows.find((li) => li.textContent?.startsWith(label));
    // Un point relevé prouve que le contrôle s'appliquait.
    expect(row('Numérotation des titres')).toHaveTextContent('Contrôlé : 1 écart relevé');
    // Structure inconnue (API antérieure) : jamais présenté comme contrôlé ni réussi.
    expect(row('Sommaire et titres')).toHaveTextContent('Non déterminé');
    expect(row('Sommaire et titres')).toHaveTextContent(
      /la présence d’un sommaire n’est pas connue/,
    );
    expect(row('Sommaire et titres')).not.toHaveTextContent(/Contrôlé/);
    expect(row('Titres mis en forme')).toHaveTextContent('Non déterminé');
    expect(within(formatting).queryByText(/Contrôlé : aucun/)).toBeNull();
    // La pagination n'est jamais présentée comme vérifiée.
    expect(row('Pagination')).toHaveTextContent('Non vérifiée');
    expect(row('Pagination')).toHaveTextContent(/ne recalcule pas la pagination/);
    // Analyse sans IA : les contrôles qui en dépendent ne sont pas dits « contrôlés ».
    expect(row('Transitions')).toHaveTextContent('Non vérifié : analyse sans IA');
    expect(row('Sections manquantes')).toHaveTextContent('Non vérifié : analyse sans IA');
    expect(within(formatting).getByText(/Non vérifiable par WordFix/)).toBeInTheDocument();
    expect(
      within(formatting).getByText(/Numéros de page du sommaire et pagination/),
    ).toBeInTheDocument();
  });

  it('Corriger : accepter ne copie rien ; « Copier » est explicite', async () => {
    const user = userEvent.setup();
    url.set('panneau=corriger');
    renderScreen();
    await ready();
    const detail = await within(panel('corriger')).findByRole('article', {
      name: 'Détail du point',
    });
    // Accepter : aucune copie dans le presse-papiers (resté vide).
    await user.click(within(detail).getByRole('button', { name: 'Appliquer la correction' }));
    await waitFor(() => expect(server.issues[0]?.status).toBe('accepted'));
    expect(await clipboardText()).toBe('');
    expect(toasts.messages).toContain(
      'Correction acceptée : elle sera appliquée au document téléchargé.',
    );
    // « Copier » sur le point suivant : copie explicite de sa proposition, sans décision.
    const article = () =>
      within(panel('corriger')).getByRole('article', { name: 'Détail du point' });
    await waitFor(() => expect(article()).toHaveTextContent('Explication iss_b.'));
    const next = article();
    await user.click(within(next).getByRole('button', { name: 'Copier' }));
    expect(await clipboardText()).toBe('faute iss_b');
    expect(server.issues[1]?.status).toBe('open');
    expect(screen.queryByText(/reportiez dans Word/)).toBeNull();
  });

  it('« Corriger et télécharger » en un clic, sans ouvrir de panneau : fiables incluses, incertaines jamais ; annulables', async () => {
    renderScreen();
    await ready();
    await openDetails();
    expect(
      within(card()).getByRole('checkbox', { name: 'Inclure les corrections fiables (1)' }),
    ).toBeChecked();
    expect(
      within(card()).getByText(/1 point incertain demande votre vérification/),
    ).toBeInTheDocument();
    const button = await mainButton();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    await waitFor(() => expect(server.createCalls).toBe(1));
    expect(server.acceptCalls).toBe(1);
    expect(server.issues.map((i) => [i.id, i.status])).toEqual([
      ['iss_a', 'accepted'],
      ['iss_b', 'open'],
      ['iss_c', 'open'],
      ['iss_d', 'open'],
      ['iss_e', 'edited'],
    ]);
    // Le compteur du haut suit la décision, confirmée par le serveur.
    expect(await screen.findByText('2 / 5 points traités')).toBeInTheDocument();
    expect(openPanels()).toEqual([]);
    // L'acceptation reste annulable dans « Revoir les corrections ».
    await userEvent.click(action('Revoir les corrections'));
    await userEvent.click(
      await within(panel('corriger')).findByRole('button', { name: 'Annuler « Tout corriger »' }),
    );
    await waitFor(() => expect(server.issues[0]?.status).toBe('open'));
  });

  it('double clic sur « Corriger et télécharger » : une seule demande', async () => {
    renderScreen();
    await ready();
    const button = await mainButton();
    await waitFor(() => expect(button).toBeEnabled());
    // Deux clics avant tout nouveau rendu (le bouton n'est pas encore désactivé).
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(server.createCalls).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.acceptCalls).toBe(1);
    expect(server.createCalls).toBe(1);
  });

  it('décision lente puis « Mise en forme » : la réponse du serveur ne ramène pas sur « Revoir les corrections »', async () => {
    url.set('panneau=corriger');
    renderScreen();
    await ready();
    const detail = await within(panel('corriger')).findByRole('article', {
      name: 'Détail du point',
    });
    let release!: () => void;
    server.hold = new Promise((resolve) => (release = resolve));
    await userEvent.click(within(detail).getByRole('button', { name: 'Appliquer la correction' }));
    // L'utilisateur ouvre « Mise en forme » avant la réponse du serveur.
    await userEvent.click(action('Mise en forme'));
    expect(openPanels()).toEqual(['mise-en-forme']);
    await act(async () => release());
    await waitFor(() =>
      expect(toasts.messages).toContain(
        'Correction acceptée : elle sera appliquée au document téléchargé.',
      ),
    );
    expect(openPanels()).toEqual(['mise-en-forme']);
    expect(url.get()).toContain('panneau=mise-en-forme');
    // Le point suivant est tout de même sélectionné pour le retour dans la revue.
    expect(url.get()).toContain('point=iss_b');
  });

  it.each([
    ['HEADINGS_INFERRED', /déduits de leur apparence.*À revoir/],
    ['PARSER_FALLBACK', 'Non vérifié : lecture simplifiée'],
  ] as const)(
    'Mise en forme : avertissement %s reflété dans le contrôle des styles de titre',
    async (warning, text) => {
      server.warnings = [warning];
      url.set('panneau=mise-en-forme');
      renderScreen();
      await ready();
      const formatting = panel('mise-en-forme');
      await within(formatting).findByRole('checkbox', { name: /Typographie française/ });
      const row = within(formatting)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith('Titres mis en forme'));
      expect(row).toHaveTextContent(text);
      // Avec l'IA active (aucun AI_DISABLED), les contrôles IA ont réellement eu lieu.
      expect(
        within(formatting)
          .getAllByRole('listitem')
          .find((li) => li.textContent?.startsWith('Transitions')),
      ).toHaveTextContent('Contrôlé par l’IA');
    },
  );

  it('changer de panneau conserve les options de mise en forme, la case des corrections fiables et les décisions', async () => {
    url.set('panneau=mise-en-forme');
    renderScreen();
    await ready();
    const typography = await within(panel('mise-en-forme')).findByRole('checkbox', {
      name: /Typographie française/,
    });
    await userEvent.click(typography);

    // La carte principale reprend l'option choisie ; la case est décochée.
    await openDetails();
    expect(within(card()).getByTestId('export-summary')).toHaveTextContent(
      'avec la mise en forme : Typographie française',
    );
    const include = within(card()).getByRole('checkbox', {
      name: 'Inclure les corrections fiables (1)',
    });
    await userEvent.click(include);

    // Une décision dans la revue, sur un autre point que la correction fiable.
    await userEvent.click(action('Revoir les corrections'));
    const list = await within(panel('corriger')).findByRole('navigation', {
      name: 'Points relevés',
    });
    await userEvent.click(within(list).getByRole('button', { name: /fote iss_c/ }));
    const detail = within(panel('corriger')).getByRole('article', { name: 'Détail du point' });
    await waitFor(() => expect(detail).toHaveTextContent('Explication iss_c.'));
    await userEvent.click(within(detail).getByRole('button', { name: 'Ignorer' }));
    await waitFor(() => expect(server.issues[2]?.status).toBe('ignored'));

    // Retour sur chaque panneau : rien n'a été perdu.
    await userEvent.click(action('Mise en forme'));
    expect(
      within(panel('mise-en-forme')).getByRole('checkbox', { name: /Typographie française/ }),
    ).toBeChecked();
    expect(
      within(card()).getByRole('checkbox', { name: 'Inclure les corrections fiables (1)' }),
    ).not.toBeChecked();
    expect(within(card()).getByText('Typographie française')).toBeInTheDocument();
    await userEvent.click(action('Revoir les corrections'));
    await userEvent.click(within(panel('corriger')).getByRole('button', { name: 'Traités' }));
    const treated = within(panel('corriger')).getByRole('navigation', { name: 'Points relevés' });
    expect(within(treated).getAllByLabelText('Traité')).toHaveLength(2);
    // Aucune acceptation automatique (case décochée) ; décisions conservées.
    expect(server.acceptCalls).toBe(0);
    expect(server.issues.map((i) => i.status)).toEqual([
      'open',
      'open',
      'ignored',
      'open',
      'edited',
    ]);
  });
});

describe('Mise en forme : présence (API) et conformité (points relevés)', () => {
  const structure = (fields: Partial<DocumentStructureDto>): DocumentStructureDto => ({
    headings: 4,
    inferredHeadings: 0,
    numberedHeadings: 3,
    comparedNumberedHeadings: 2,
    tocEntries: 0,
    comparableTocEntries: 0,
    pageMethod: 'rendered_break',
    ...fields,
  });
  const rowsOf = async () => {
    url.set('panneau=mise-en-forme');
    renderScreen();
    await ready();
    const formatting = panel('mise-en-forme');
    await within(formatting).findByRole('checkbox', { name: /Typographie française/ });
    const rows = within(formatting).getAllByRole('listitem');
    return (label: string) => rows.find((li) => li.textContent?.startsWith(label));
  };
  const withoutNumberingIssue = () => {
    server.issues = server.issues.filter((i) => i.subtype !== 'heading_numbering');
  };

  it('aucun sommaire Word : « Non applicable », jamais « contrôlé » ; titres reconnus : « Contrôlé »', async () => {
    server.structure = structure({ tocEntries: 0 });
    const row = await rowsOf();
    expect(row('Sommaire et titres')).toHaveTextContent('Non applicable');
    expect(row('Sommaire et titres')).toHaveTextContent('Aucun sommaire Word détecté');
    expect(row('Sommaire et titres')).not.toHaveTextContent(/Contrôlé/);
    expect(row('Numérotation des titres')).toHaveTextContent('Contrôlé : 1 écart relevé');
    expect(row('Numérotation des titres')).toHaveTextContent('3 titres numérotés');
    expect(row('Titres mis en forme')).toHaveTextContent('Contrôlé');
    expect(row('Titres mis en forme')).toHaveTextContent('Les 4 titres sont reconnus par Word');
    expect(row('Pagination')).toHaveTextContent('Non vérifiée');
    expect(row('Pagination')).toHaveTextContent(/dernier enregistrement/);
  });

  it('sommaire présent et conforme : contrôlé, sans prétendre vérifier ses numéros de page', async () => {
    server.structure = structure({ tocEntries: 6, comparableTocEntries: 5 });
    const row = await rowsOf();
    expect(row('Sommaire et titres')).toHaveTextContent(
      'Contrôlé : chaque entrée comparée correspond à un titre',
    );
    expect(row('Sommaire et titres')).toHaveTextContent('5 entrées comparées');
    expect(row('Sommaire et titres')).toHaveTextContent(
      'Les numéros de page du sommaire ne sont pas vérifiés.',
    );
  });

  it('sommaire présent avec un écart relevé : présence et écart affichés séparément', async () => {
    server.structure = structure({ tocEntries: 3, comparableTocEntries: 3 });
    server.issues.push(
      issue('iss_t', 6, {
        nature: 'potential',
        category: 'structure',
        subtype: 'toc_mismatch',
        suggestion: null,
      }),
    );
    const row = await rowsOf();
    expect(row('Sommaire et titres')).toHaveTextContent(
      'Contrôlé : 1 entrée sans titre correspondant',
    );
    expect(row('Sommaire et titres')).toHaveTextContent('3 entrées comparées');
  });

  it('sommaire présent mais aucun titre : « Non vérifié » ; aucun titre : styles « Non applicable »', async () => {
    withoutNumberingIssue();
    server.structure = structure({
      headings: 0,
      numberedHeadings: 0,
      comparedNumberedHeadings: 0,
      tocEntries: 2,
      comparableTocEntries: 2,
    });
    const row = await rowsOf();
    expect(row('Sommaire et titres')).toHaveTextContent('Non vérifié');
    expect(row('Sommaire et titres')).toHaveTextContent('aucun titre dans le document');
    expect(row('Titres mis en forme')).toHaveTextContent('Non applicable');
    expect(row('Numérotation des titres')).toHaveTextContent('Non applicable');
  });

  it('un seul titre numéroté : numérotation « Non applicable »', async () => {
    withoutNumberingIssue();
    server.structure = structure({ numberedHeadings: 1, comparedNumberedHeadings: 0 });
    const row = await rowsOf();
    expect(row('Numérotation des titres')).toHaveTextContent('Non applicable');
    expect(row('Numérotation des titres')).toHaveTextContent('Un seul titre numéroté');
  });

  it('plusieurs titres numérotés sans écart relevé : « Contrôlé : aucun écart »', async () => {
    withoutNumberingIssue();
    server.structure = structure({ numberedHeadings: 3, comparedNumberedHeadings: 2 });
    const row = await rowsOf();
    expect(row('Numérotation des titres')).toHaveTextContent('Contrôlé : aucun écart');
    expect(row('Numérotation des titres')).toHaveTextContent('2 numéros de titre comparés');
    expect(row('Numérotation des titres')).toHaveTextContent('le premier numéro de chaque niveau');
  });

  it('titres numérotés sans suite comparable (« 1. » puis « 1.1 ») : « Non applicable », jamais « Contrôlé »', async () => {
    withoutNumberingIssue();
    server.structure = structure({ numberedHeadings: 2, comparedNumberedHeadings: 0 });
    const row = await rowsOf();
    expect(row('Numérotation des titres')).toHaveTextContent('Non applicable');
    expect(row('Numérotation des titres')).toHaveTextContent(
      'Aucun titre numéroté ne suit un autre titre du même niveau',
    );
    expect(row('Numérotation des titres')).not.toHaveTextContent(/Contrôlé/);
  });

  it('titres déduits de leur apparence : « À revoir », avec leur nombre', async () => {
    server.structure = structure({ inferredHeadings: 2 });
    const row = await rowsOf();
    expect(row('Titres mis en forme')).toHaveTextContent('À revoir');
    expect(row('Titres mis en forme')).toHaveTextContent('2 titres déduits de leur apparence');
  });

  it('contenu extrait expiré (structure null) : « Non déterminé »', async () => {
    withoutNumberingIssue();
    server.structure = null;
    const row = await rowsOf();
    expect(row('Numérotation des titres')).toHaveTextContent('Non déterminé');
    expect(row('Sommaire et titres')).toHaveTextContent('Non déterminé');
    expect(row('Titres mis en forme')).toHaveTextContent('Non déterminé');
  });

  it('lecture simplifiée : aucun contrôle de structure présenté comme fait, même avec une structure', async () => {
    withoutNumberingIssue();
    server.warnings = ['PARSER_FALLBACK'];
    server.structure = structure({ tocEntries: 0 });
    const row = await rowsOf();
    for (const label of ['Numérotation des titres', 'Sommaire et titres', 'Titres mis en forme']) {
      expect(row(label)).toHaveTextContent('Non vérifié : lecture simplifiée');
    }
    expect(row('Pagination')).toHaveTextContent('Non vérifiée');
  });
});
