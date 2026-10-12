import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AcceptReliableResultDto,
  type AnalysisDto,
  type DocumentDto,
  type ExportDto,
  type ExportOptions,
  type IssueDto,
  type IssueListDto,
  type IssueStatus,
  isReliableCorrection,
} from '@wordfix/shared';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_LABEL, ExportPanel, NO_OPTIONS } from '@/components/results/export-panel';
import { FormattingPanel } from '@/components/results/formatting-panel';
import { ApiError } from '@/lib/api/client';
import { fileNameFromDisposition } from '@/lib/api/endpoints';
import { decisionsSignature, exportableIssues, requestSignature } from '@/lib/export';
import { useIssues } from '@/lib/hooks/use-issues';

/**
 * Panneaux « Mise en forme » et « Télécharger les modifications » : vrais composants et
 * vrai cache React Query ; seule l'API est simulée. Le téléchargement ne peut viser que
 * la route d'export, et seulement un document prêt correspondant aux choix affichés.
 */

const server = vi.hoisted(() => ({
  fileAvailable: true,
  /** GET /documents/:id refusé (erreur passagère) tant que ce champ est renseigné. */
  documentError: null as ApiError | null,
  /** Réponses retenues (requête en cours) tant que ce drapeau est levé. */
  holdDocument: false,
  holdExport: false,
  /** États successifs renvoyés par GET /exports/:id (le dernier est conservé). */
  sequence: [] as ExportDto[],
  getCalls: 0,
  createCalls: 0,
  createOptions: [] as unknown[],
  createError: null as ApiError | null,
  getError: null as ApiError | null,
  downloadError: null as ApiError | null,
  downloads: [] as string[],
  /** Points connus du serveur pour « Tout corriger » (même règle partagée que l'API). */
  issues: [] as IssueDto[],
  acceptCalls: 0,
  acceptError: null as ApiError | null,
}));

const saved = vi.hoisted(() => ({ files: [] as { blob: Blob; fileName: string }[] }));
vi.mock('@/lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export')>();
  return {
    ...actual,
    saveFile: (blob: Blob, fileName: string) => saved.files.push({ blob, fileName }),
  };
});

vi.mock('@/lib/api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/endpoints')>();
  return {
    ...actual,
    api: {
      getDocument: (): Promise<DocumentDto> => {
        if (server.holdDocument) return new Promise<DocumentDto>(() => undefined);
        if (server.documentError) return Promise.reject(server.documentError);
        return Promise.resolve({ id: 'doc_1', fileAvailable: server.fileAvailable } as DocumentDto);
      },
      createExport: (_analysisId: string, options?: unknown): Promise<ExportDto> => {
        server.createCalls++;
        server.createOptions.push(options);
        if (server.createError) return Promise.reject(server.createError);
        return Promise.resolve(server.sequence[0] ?? exportDto('QUEUED'));
      },
      getExport: (): Promise<ExportDto> => {
        server.getCalls++;
        if (server.holdExport) return new Promise<ExportDto>(() => undefined);
        if (server.getError) return Promise.reject(server.getError);
        const next = server.sequence.length > 1 ? server.sequence.shift() : server.sequence[0];
        return next ? Promise.resolve(next) : Promise.reject(new ApiError('NOT_FOUND', 'x', 404));
      },
      listIssues: (): Promise<IssueListDto> =>
        Promise.resolve({
          items: server.issues.map((i) => ({ ...i })),
          total: server.issues.length,
          blocks: {},
        }),
      acceptReliable: (): Promise<AcceptReliableResultDto> => {
        server.acceptCalls++;
        if (server.acceptError) return Promise.reject(server.acceptError);
        const ids = server.issues.filter(isReliableCorrection).map((i) => i.id);
        for (const issue of server.issues) if (ids.includes(issue.id)) issue.status = 'accepted';
        return Promise.resolve({
          acceptedIds: ids,
          analysis: { id: 'ana_1', reviewedCount: ids.length, issueCount: server.issues.length },
        });
      },
      downloadExport: (id: string) => {
        server.downloads.push(id);
        if (server.downloadError) return Promise.reject(server.downloadError);
        return Promise.resolve({
          blob: new Blob(['corrigé'], { type: 'application/octet-stream' }),
          fileName: 'Rapport (corrigé).docx',
        });
      },
    },
  };
});

function exportDto(status: ExportDto['status'], fields: Partial<ExportDto> = {}): ExportDto {
  return {
    id: 'exp_1',
    analysisId: 'ana_1',
    status,
    requestedCount: 2,
    appliedCount: status === 'READY' ? 2 : 0,
    skipped: [],
    errorCode: null,
    options: { typography: false, layout: false },
    beautified: status === 'READY' ? { typography: 0, layout: 0 } : null,
    createdAt: '2026-10-11T10:00:00.000Z',
    completedAt: status === 'READY' || status === 'FAILED' ? '2026-10-11T10:00:05.000Z' : null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...fields,
  };
}

const analysis = {
  id: 'ana_1',
  documentId: 'doc_1',
  warnings: [],
  skippedAiChecks: [],
} as unknown as AnalysisDto;

function issue(id: string, status: IssueStatus, fields: Partial<IssueDto> = {}): IssueDto {
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
      charEnd: 4,
      label: null,
    },
    related: [],
    original: `fote ${id}`,
    suggestion: `faute ${id}`,
    explanation: '',
    status,
    userText: null,
    docOrder: 0,
    ...fields,
  };
}

const decided = () => [
  issue('iss_a', 'accepted'),
  issue('iss_b', 'edited', { userText: 'ma version' }),
  issue('iss_c', 'ignored'),
  // Point encore ouvert mais non fiable (confiance moyenne) : jamais appliqué d'office.
  issue('iss_d', 'open', { confidence: 'medium' }),
];

/** « Mise en forme » et « Télécharger », options partagées comme dans l'écran des résultats. */
function Panels({ issues }: { issues: IssueDto[] }) {
  const [options, setOptions] = useState<ExportOptions>(NO_OPTIONS);
  return (
    <>
      <FormattingPanel
        analysis={analysis}
        issues={issues}
        options={options}
        onChange={setOptions}
        onShowStructure={() => undefined}
      />
      <ExportPanel analysis={analysis} issues={issues} options={options} />
    </>
  );
}

/** Comme l'écran réel : les points viennent du cache (mis à jour par « Tout corriger »). */
function LivePanels() {
  const { data } = useIssues('ana_1', true);
  return data ? <Panels issues={data.items} /> : null;
}

function renderLive(issues: IssueDto[]) {
  server.issues = issues.map((i) => ({ ...i }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LivePanels />
    </QueryClientProvider>,
  );
}

function renderPanel(issues: IssueDto[]) {
  server.issues = issues.map((i) => ({ ...i }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Panels issues={issues} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    update: (next: IssueDto[]) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Panels issues={next} />
        </QueryClientProvider>,
      ),
  };
}

/** Empreinte stockée par le panneau pour ces choix, sans option « Embellir ». */
const signatureOf = (issues: IssueDto[]) =>
  requestSignature(decisionsSignature(issues), { typography: false, layout: false });

/** Bouton unique « Télécharger les modifications » (préparer puis télécharger). */
const mainButton = () => screen.queryByRole('button', { name: DOWNLOAD_LABEL });
/** Clique sur le bouton principal dès qu'il est utilisable (fichier d'origine confirmé). */
const clickMain = async () => {
  const button = await screen.findByRole('button', { name: DOWNLOAD_LABEL });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
};
/** Aucun fichier n'a été demandé ni enregistré. */
const nothingDownloaded = () => {
  expect(server.downloads).toEqual([]);
  expect(saved.files).toHaveLength(0);
};

beforeEach(() => {
  Object.assign(server, {
    fileAvailable: true,
    documentError: null,
    holdDocument: false,
    holdExport: false,
    sequence: [],
    getCalls: 0,
    createCalls: 0,
    createOptions: [],
    createError: null,
    getError: null,
    downloadError: null,
    downloads: [],
    issues: [],
    acceptCalls: 0,
    acceptError: null,
  });
  saved.files = [];
  window.sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('Règles du document corrigé', () => {
  it('seuls les points acceptés (avec proposition) et modifiés sont appliqués', () => {
    const issues = [
      ...decided(),
      issue('iss_e', 'accepted', { suggestion: null }),
      issue('iss_f', 'verified'),
    ];
    expect(exportableIssues(issues).map((i) => i.id)).toEqual(['iss_a', 'iss_b']);
  });

  it('l’empreinte des choix change avec le texte appliqué, pas avec les autres points', () => {
    const base = decisionsSignature(decided());
    const ignoredMore = decided().map((i) =>
      i.id === 'iss_d' ? { ...i, status: 'ignored' as const } : i,
    );
    expect(decisionsSignature(ignoredMore)).toBe(base);
    const edited = decided().map((i) => (i.id === 'iss_b' ? { ...i, userText: 'autre' } : i));
    expect(decisionsSignature(edited)).not.toBe(base);
  });

  it('nom du fichier lu dans Content-Disposition (forme UTF-8 prioritaire)', () => {
    expect(
      fileNameFromDisposition(
        `attachment; filename="Rapport ete (corrige).docx"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9%20%28corrig%C3%A9%29.docx`,
      ),
    ).toBe('Rapport été (corrigé).docx');
    expect(fileNameFromDisposition('attachment; filename="a.docx"')).toBe('a.docx');
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe('Panneau « Télécharger les modifications »', () => {
  it('aucune modification choisie : téléchargement impossible, explication', async () => {
    renderPanel([issue('iss_c', 'ignored'), issue('iss_d', 'open', { confidence: 'low' })]);
    expect(await screen.findByText(/acceptez ou modifiez au moins un point/)).toBeInTheDocument();
    expect(mainButton()).toBeDisabled();
    expect(server.createCalls).toBe(0);
    nothingDownloaded();
  });

  it('un clic : attente, préparation puis téléchargement automatique du seul document corrigé', async () => {
    server.sequence = [exportDto('QUEUED'), exportDto('RUNNING'), exportDto('READY')];
    renderPanel(decided());
    expect(
      (await screen.findByText('Corrections acceptées ou modifiées')).nextSibling,
    ).toHaveTextContent('2 corrections');
    await clickMain();
    expect(server.createCalls).toBe(1);

    expect(await screen.findByText(/en attente de préparation/)).toBeInTheDocument();
    // Pendant la préparation : bouton occupé, aucun téléchargement.
    expect(screen.getByRole('button', { name: 'Préparation de votre document…' })).toBeDisabled();
    nothingDownloaded();
    expect(
      await screen.findByText(
        'Préparation de votre document…',
        { selector: 'p' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    nothingDownloaded();

    expect(
      await screen.findByText(
        /Document prêt : 2 sur 2 corrections appliquées/,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    // Téléchargé une seule fois, automatiquement, depuis la route d'export.
    await waitFor(() => expect(saved.files).toHaveLength(1));
    expect(server.downloads).toEqual(['exp_1']);
    expect(saved.files[0]?.fileName).toBe('Rapport (corrigé).docx');
    expect(screen.getByText(/Téléchargement lancé\. Rien ne s’est passé/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.downloads).toEqual(['exp_1']);
    // Le document prêt correspond aux choix : un nouveau clic retélécharge, sans demande.
    await clickMain();
    await waitFor(() => expect(saved.files).toHaveLength(2));
    expect(server.downloads).toEqual(['exp_1', 'exp_1']);
    expect(server.createCalls).toBe(1);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  }, 15_000);

  it('choix modifiés pendant la préparation : pas de téléchargement automatique d’un document périmé', async () => {
    server.sequence = [exportDto('RUNNING'), exportDto('READY')];
    const { update } = renderPanel(decided());
    await clickMain();
    await screen.findByText('Préparation de votre document…', { selector: 'p' });
    update(decided().map((i) => (i.id === 'iss_d' ? { ...i, status: 'accepted' as const } : i)));
    expect(
      await screen.findByText(/Vos choix ont changé depuis la génération/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    nothingDownloaded();
    expect(screen.getByRole('button', { name: 'Télécharger la version précédente' })).toBeEnabled();
    expect(mainButton()).toBeEnabled();
  }, 15_000);

  it('corrections non appliquées : passage, correction choisie et motif', async () => {
    server.sequence = [
      exportDto('READY', {
        appliedCount: 1,
        skipped: [{ issueId: 'iss_b', reason: 'format_boundary' }],
      }),
    ];
    renderPanel(decided());
    await clickMain();
    expect(
      await screen.findByText(/1 sur 2 corrections appliquées/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const list = screen.getByText(/1 correction non appliquée/).closest('details');
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).getByText('fote iss_b')).toBeInTheDocument();
    expect(within(list as HTMLElement).getByText('ma version')).toBeInTheDocument();
    expect(within(list as HTMLElement).getByText(/La mise en forme change/)).toBeInTheDocument();
  });

  it('aucune correction applicable : échec explicite, aucun téléchargement, pas de nouvel essai identique', async () => {
    server.sequence = [
      exportDto('FAILED', {
        errorCode: 'EXPORT_NO_APPLICABLE',
        skipped: [
          { issueId: 'iss_a', reason: 'block_changed' },
          { issueId: 'iss_b', reason: 'field' },
        ],
      }),
    ];
    renderPanel(decided());
    await clickMain();
    expect(await screen.findByText('Aucun document corrigé n’a été produit.')).toBeInTheDocument();
    expect(screen.getByText(/n'a pu être appliquée sans risque/)).toBeInTheDocument();
    expect(screen.getByText(/2 corrections non appliquées/)).toBeInTheDocument();
    nothingDownloaded();
    expect(mainButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /Réessayer/ })).toBeNull();
  });

  it.each([
    ['EXPORT_TIMEOUT', /a pris trop de temps/, true],
    ['EXPORT_FAILED', /n'a pas pu être produit/, true],
    ['EXPORT_TOO_LARGE', /trop volumineux ou trop complexe/, false],
  ] as const)(
    'échec %s : message clair, nouvel essai seulement s’il peut aboutir',
    async (code, text, retry) => {
      server.sequence = [exportDto('FAILED', { errorCode: code })];
      renderPanel(decided());
      await clickMain();
      expect(await screen.findByText(text)).toBeInTheDocument();
      nothingDownloaded();
      expect(mainButton()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Réessayer' }) !== null).toBe(retry);
      if (retry) {
        await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
        expect(server.createCalls).toBe(2);
      }
    },
  );

  it('choix modifiés après la génération : document signalé comme périmé, nouvelle version proposée', async () => {
    server.sequence = [exportDto('READY')];
    const { update } = renderPanel(decided());
    await clickMain();
    await screen.findByText(/Document prêt/);
    update(decided().map((i) => (i.id === 'iss_d' ? { ...i, status: 'accepted' as const } : i)));
    expect(
      await screen.findByText(/Vos choix ont changé depuis la génération/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Télécharger la version précédente' })).toBeEnabled();
    // Le bouton principal prépare désormais une nouvelle version (nouvelle demande).
    await userEvent.click(mainButton() as HTMLElement);
    expect(server.createCalls).toBe(2);
  });

  it('demande refusée (quota) : message du serveur affiché, aucun téléchargement', async () => {
    server.createError = new ApiError(
      'EXPORT_RATE_LIMITED',
      'Vous avez atteint la limite de documents corrigés. Réessayez un peu plus tard.',
      429,
    );
    renderPanel(decided());
    await clickMain();
    expect(await screen.findByText(/limite de documents corrigés/)).toBeInTheDocument();
    nothingDownloaded();
  });

  it('téléchargement refusé (expiré) : message, aucun fichier enregistré', async () => {
    server.sequence = [exportDto('READY')];
    server.downloadError = new ApiError(
      'EXPORT_EXPIRED',
      "Le document corrigé n'est plus disponible (conservation de 24 h après l'import).",
      410,
    );
    renderPanel(decided());
    await clickMain();
    expect(await screen.findByText(/n'est plus disponible/)).toBeInTheDocument();
    expect(server.downloads).toEqual(['exp_1']);
    expect(saved.files).toHaveLength(0);
  });

  it('document corrigé expiré : jamais téléchargé', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(decided()) }),
    );
    server.sequence = [exportDto('READY', { expiresAt: '2026-01-01T00:00:00.000Z' })];
    renderPanel(decided());
    expect(await screen.findByText(/n’est plus disponible/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /version précédente/ })).toBeNull();
    // Le bouton demande un nouveau document ; l'expiré n'est jamais téléchargé.
    await clickMain();
    expect(server.createCalls).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    nothingDownloaded();
  });

  it('fichier d’origine supprimé : téléchargement impossible, explication', async () => {
    server.fileAvailable = false;
    renderPanel(decided());
    expect(await screen.findByText(/fichier d’origine a été supprimé/)).toBeInTheDocument();
    expect(mainButton()).toBeNull();
  });

  it('après rechargement : l’export suivi est relu, sans nouvelle demande ni téléchargement automatique', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(decided()) }),
    );
    server.sequence = [exportDto('READY')];
    renderPanel(decided());
    expect(await screen.findByText(/Document prêt/)).toBeInTheDocument();
    expect(server.createCalls).toBe(0);
    nothingDownloaded();
    expect(mainButton()).toBeEnabled();
  });

  it('export suivi introuvable (404) : oublié, une nouvelle demande est possible', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: 'x' }),
    );
    server.getError = new ApiError('NOT_FOUND', 'Introuvable', 404);
    renderPanel(decided());
    expect(await screen.findByRole('button', { name: DOWNLOAD_LABEL })).toBeEnabled();
    await waitFor(() => expect(window.sessionStorage.getItem('wordfix.export.ana_1')).toBeNull());
  });

  const track = () =>
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(decided()) }),
    );

  it('état de l’export suivi en cours de chargement : aucune nouvelle demande proposée', async () => {
    track();
    server.holdExport = true;
    renderPanel(decided());
    expect(await screen.findByText('Chargement de votre document corrigé…')).toBeInTheDocument();
    // Le fichier d'origine est confirmé disponible : seul l'état inconnu bloque.
    await waitFor(() => expect(server.getCalls).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Télécharger|Réessayer/ })).toBeNull();
  });

  it('état de l’export suivi indisponible (erreur passagère) : message, aucune nouvelle demande, reprise', async () => {
    track();
    server.getError = new ApiError(
      'INTERNAL_ERROR',
      'Une erreur inattendue est survenue. Réessayez dans un instant.',
      503,
    );
    renderPanel(decided());
    expect(
      await screen.findByText(/L’état de votre document corrigé n’a pas pu être récupéré/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Aucune nouvelle demande n’est envoyée/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Télécharger|Réessayer$/ })).toBeNull();
    // L'export suivi n'est pas oublié (ce n'est pas un 404).
    expect(window.sessionStorage.getItem('wordfix.export.ana_1')).not.toBeNull();

    // Le service répond de nouveau : l'export déjà prêt est retrouvé, sans nouvelle demande.
    server.getError = null;
    server.sequence = [exportDto('READY')];
    await userEvent.click(screen.getByRole('button', { name: 'Récupérer l’état maintenant' }));
    expect(await screen.findByText(/Document prêt/)).toBeInTheDocument();
    expect(server.createCalls).toBe(0);
  });

  it('disponibilité du fichier d’origine pas encore confirmée : bouton désactivé', async () => {
    server.holdDocument = true;
    renderPanel(decided());
    expect(
      await screen.findByText('Vérification de la disponibilité de votre fichier d’origine…'),
    ).toBeInTheDocument();
    expect(mainButton()).toBeDisabled();
  });

  it('vérification du fichier d’origine impossible : message clair, bouton désactivé jusqu’à confirmation', async () => {
    server.documentError = new ApiError('NETWORK_ERROR', 'Connexion impossible.', 0);
    renderPanel(decided());
    expect(
      await screen.findByText(
        /La disponibilité de votre fichier d’origine n’a pas pu être vérifiée/,
      ),
    ).toBeInTheDocument();
    expect(mainButton()).toBeDisabled();

    server.documentError = null;
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier maintenant' }));
    await waitFor(() => expect(mainButton()).toBeEnabled());
    expect(screen.queryByText(/n’a pas pu être vérifiée/)).toBeNull();
    expect(server.createCalls).toBe(0);
  });

  it('mise en forme seule (aucune correction choisie) : téléchargement possible, options envoyées, compte rendu', async () => {
    server.sequence = [
      exportDto('READY', {
        requestedCount: 0,
        appliedCount: 0,
        options: { typography: true, layout: false },
        beautified: { typography: 3, layout: 0 },
      }),
    ];
    renderPanel([issue('iss_c', 'ignored')]);
    expect(await screen.findByRole('button', { name: DOWNLOAD_LABEL })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Typographie française/ }));
    expect(screen.getByText('Mise en forme').nextSibling).toHaveTextContent(
      'Typographie française',
    );
    await clickMain();
    expect(server.createOptions).toEqual([{ typography: true, layout: false }]);
    expect(await screen.findByText('Document prêt : mise en forme appliquée.')).toBeInTheDocument();
    expect(screen.getByText('Mise en forme : 3 corrections typographiques.')).toBeInTheDocument();
    await waitFor(() => expect(saved.files).toHaveLength(1));
    expect(mainButton()).toBeEnabled();
  });

  it('mise en forme sur un document déjà conforme : message clair, aucun téléchargement', async () => {
    server.sequence = [
      exportDto('FAILED', {
        requestedCount: 0,
        errorCode: 'EXPORT_UNCHANGED',
        options: { typography: false, layout: true },
      }),
    ];
    renderPanel([]);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /Harmonisation de la présentation/ }),
    );
    await clickMain();
    expect(
      await screen.findByText(/n'avait besoin d'aucune des améliorations/),
    ).toBeInTheDocument();
    nothingDownloaded();
    expect(mainButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('option changée après la génération : document signalé comme périmé', async () => {
    server.sequence = [exportDto('READY')];
    renderPanel(decided());
    await clickMain();
    await screen.findByText(/Document prêt/);
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Harmonisation de la présentation/ }),
    );
    expect(
      await screen.findByText(/Vos choix ont changé depuis la génération/),
    ).toBeInTheDocument();
    expect(mainButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Télécharger la version précédente' })).toBeEnabled();
  });
});

describe('Corrections fiables au téléchargement', () => {
  /** Une correction fiable, une incertaine, un point à vérifier, une décision antérieure. */
  const mixed = () => [
    issue('iss_r', 'open'),
    issue('iss_u', 'open', { nature: 'suggestion', confidence: 'medium' }),
    issue('iss_v', 'open', { nature: 'verify', suggestion: null }),
    issue('iss_e', 'edited', { userText: 'ma version' }),
  ];

  it('case cochée par défaut : « Tout corriger » puis export ; les points incertains ne sont jamais acceptés', async () => {
    server.sequence = [exportDto('READY')];
    renderLive(mixed());
    const include = await screen.findByRole('checkbox', {
      name: 'Inclure les corrections fiables (1)',
    });
    expect(include).toBeChecked();
    await clickMain();
    await waitFor(() => expect(server.createCalls).toBe(1));
    expect(server.acceptCalls).toBe(1);
    // Seule la correction fiable est acceptée ; la décision antérieure est conservée.
    expect(server.issues.map((i) => [i.id, i.status])).toEqual([
      ['iss_r', 'accepted'],
      ['iss_u', 'open'],
      ['iss_v', 'open'],
      ['iss_e', 'edited'],
    ]);
    // Annulable comme « Tout corriger » (même lot gardé dans l'onglet).
    expect(JSON.parse(window.sessionStorage.getItem('wordfix.bulk.ana_1') ?? '[]')).toEqual([
      'iss_r',
    ]);
    expect(await screen.findByText(/1 correction fiable acceptée/)).toBeInTheDocument();
    await waitFor(() => expect(saved.files).toHaveLength(1));
  });

  it('case décochée : aucune acceptation automatique', async () => {
    server.sequence = [exportDto('READY')];
    renderLive(mixed());
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Inclure les corrections fiables (1)' }),
    );
    await clickMain();
    await waitFor(() => expect(server.createCalls).toBe(1));
    expect(server.acceptCalls).toBe(0);
    expect(server.issues.find((i) => i.id === 'iss_r')?.status).toBe('open');
  });

  it('acceptation refusée par le serveur : message, aucun export demandé', async () => {
    server.acceptError = new ApiError('NETWORK_ERROR', 'Connexion impossible.', 0);
    renderLive(mixed());
    await clickMain();
    expect(await screen.findByText('Connexion impossible.')).toBeInTheDocument();
    expect(server.createCalls).toBe(0);
    nothingDownloaded();
  });

  it('seules des corrections fiables en attente : le téléchargement est possible (case cochée)', async () => {
    server.sequence = [exportDto('READY')];
    renderLive([issue('iss_r', 'open')]);
    const button = await screen.findByRole('button', { name: DOWNLOAD_LABEL });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Inclure les corrections fiables/ }),
    );
    expect(mainButton()).toBeDisabled();
  });

  it('points à vérifier manuellement : signalés, sans bloquer le téléchargement', async () => {
    renderLive(mixed());
    expect(
      await screen.findByText(/1 point demande une vérification de votre part/),
    ).toBeInTheDocument();
    expect(screen.getByText(/ne bloque pas le téléchargement/)).toBeInTheDocument();
    await waitFor(() => expect(mainButton()).toBeEnabled());
  });

  it('document prêt mais corrections fiables encore en attente : un clic prépare une version à jour', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(mixed()) }),
    );
    server.sequence = [exportDto('READY')];
    renderLive(mixed());
    await screen.findByText(/Document prêt/);
    await clickMain();
    await waitFor(() => expect(server.createCalls).toBe(1));
    expect(server.acceptCalls).toBe(1);
  });
});
