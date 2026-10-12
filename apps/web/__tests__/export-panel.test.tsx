import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalysisDto, DocumentDto, ExportDto, IssueDto, IssueStatus } from '@wordfix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from '@/components/results/export-panel';
import { ApiError } from '@/lib/api/client';
import { fileNameFromDisposition } from '@/lib/api/endpoints';
import { decisionsSignature, exportableIssues, requestSignature } from '@/lib/export';

/**
 * Panneau « Document corrigé » : vrais composants et vrai cache React Query ; seule
 * l'API est simulée. Le téléchargement ne peut viser que la route d'export.
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

const analysis = { id: 'ana_1', documentId: 'doc_1' } as AnalysisDto;

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
  issue('iss_d', 'open'),
];

function renderPanel(issues: IssueDto[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ExportPanel analysis={analysis} issues={issues} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    update: (next: IssueDto[]) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <ExportPanel analysis={analysis} issues={next} />
        </QueryClientProvider>,
      ),
  };
}

/** Empreinte stockée par le panneau pour ces choix, sans option « Embellir ». */
const signatureOf = (issues: IssueDto[]) =>
  requestSignature(decisionsSignature(issues), { typography: false, layout: false });

const panel = () => screen.getByRole('region', { name: 'Document corrigé' });
const downloadButton = () => within(panel()).queryByRole('button', { name: /Télécharger/ });

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

describe('Panneau « Document corrigé »', () => {
  it('aucune correction choisie : génération impossible, explication', async () => {
    renderPanel([issue('iss_c', 'ignored'), issue('iss_d', 'open')]);
    expect(await screen.findByText(/Acceptez ou modifiez au moins un point/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Générer le document corrigé' })).toBeDisabled();
    expect(downloadButton()).toBeNull();
  });

  it('attente, génération puis téléchargement du seul document corrigé', async () => {
    server.sequence = [exportDto('QUEUED'), exportDto('RUNNING'), exportDto('READY')];
    renderPanel(decided());
    expect(
      await screen.findByText('2 corrections acceptées ou modifiées seront appliquées', {
        exact: false,
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Générer le document corrigé' }));
    expect(server.createCalls).toBe(1);

    expect(await screen.findByText(/en attente de génération/)).toBeInTheDocument();
    // Aucun téléchargement tant que le document n'est pas prêt.
    expect(downloadButton()).toBeNull();
    expect(
      await screen.findByText('Génération du document corrigé…', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(downloadButton()).toBeNull();

    expect(
      await screen.findByText(
        /Document corrigé prêt : 2 sur 2 corrections appliquées/,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Télécharger le document corrigé' }));
    await waitFor(() => expect(saved.files).toHaveLength(1));
    expect(server.downloads).toEqual(['exp_1']);
    expect(saved.files[0]?.fileName).toBe('Rapport (corrigé).docx');
    // Le document prêt correspond aux choix : pas de nouvelle demande proposée.
    expect(screen.queryByRole('button', { name: /Générer/ })).toBeNull();
  }, 15_000);

  it('corrections non appliquées : passage, correction choisie et motif', async () => {
    server.sequence = [
      exportDto('READY', {
        appliedCount: 1,
        skipped: [{ issueId: 'iss_b', reason: 'format_boundary' }],
      }),
    ];
    renderPanel(decided());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
    expect(await screen.findByText('Aucun document corrigé n’a été produit.')).toBeInTheDocument();
    expect(screen.getByText(/n'a pu être appliquée sans risque/)).toBeInTheDocument();
    expect(screen.getByText(/2 corrections non appliquées/)).toBeInTheDocument();
    expect(downloadButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /Réessayer|Générer/ })).toBeNull();
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
      await userEvent.click(
        await screen.findByRole('button', { name: 'Générer le document corrigé' }),
      );
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(downloadButton()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Réessayer' }) !== null).toBe(retry);
    },
  );

  it('choix modifiés après la génération : document signalé comme périmé, nouvelle version proposée', async () => {
    server.sequence = [exportDto('READY')];
    const { update } = renderPanel(decided());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
    await screen.findByText(/Document corrigé prêt/);
    update(decided().map((i) => (i.id === 'iss_d' ? { ...i, status: 'accepted' as const } : i)));
    expect(
      await screen.findByText(/Vos choix ont changé depuis la génération/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Télécharger la version précédente' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Générer une nouvelle version' })).toBeEnabled();
  });

  it('demande refusée (quota) : message du serveur affiché', async () => {
    server.createError = new ApiError(
      'EXPORT_RATE_LIMITED',
      'Vous avez atteint la limite de documents corrigés. Réessayez un peu plus tard.',
      429,
    );
    renderPanel(decided());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
    expect(await screen.findByText(/limite de documents corrigés/)).toBeInTheDocument();
    expect(downloadButton()).toBeNull();
  });

  it('téléchargement refusé (expiré) : message, aucun fichier enregistré', async () => {
    server.sequence = [exportDto('READY')];
    server.downloadError = new ApiError(
      'EXPORT_EXPIRED',
      "Le document corrigé n'est plus disponible (conservation de 24 h après l'import).",
      410,
    );
    renderPanel(decided());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Télécharger le document corrigé' }),
    );
    expect(await screen.findByText(/n'est plus disponible/)).toBeInTheDocument();
    expect(saved.files).toHaveLength(0);
  });

  it('document corrigé expiré : plus de téléchargement proposé', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(decided()) }),
    );
    server.sequence = [exportDto('READY', { expiresAt: '2026-01-01T00:00:00.000Z' })];
    renderPanel(decided());
    expect(await screen.findByText(/n’est plus disponible/)).toBeInTheDocument();
    expect(downloadButton()).toBeNull();
  });

  it('fichier d’origine supprimé : génération impossible, explication', async () => {
    server.fileAvailable = false;
    renderPanel(decided());
    expect(await screen.findByText(/fichier d’origine a été supprimé/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Générer/ })).toBeNull();
  });

  it('après rechargement : l’export suivi est relu, sans nouvelle demande', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: signatureOf(decided()) }),
    );
    server.sequence = [exportDto('READY')];
    renderPanel(decided());
    expect(await screen.findByText(/Document corrigé prêt/)).toBeInTheDocument();
    expect(server.createCalls).toBe(0);
  });

  it('export suivi introuvable (404) : oublié, une nouvelle demande est possible', async () => {
    window.sessionStorage.setItem(
      'wordfix.export.ana_1',
      JSON.stringify({ id: 'exp_1', signature: 'x' }),
    );
    server.getError = new ApiError('NOT_FOUND', 'Introuvable', 404);
    renderPanel(decided());
    expect(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    ).toBeEnabled();
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
    expect(await screen.findByText('Chargement du document corrigé…')).toBeInTheDocument();
    // Le fichier d'origine est confirmé disponible : seul l'état inconnu bloque.
    await waitFor(() => expect(server.getCalls).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Générer|Réessayer/ })).toBeNull();
    expect(downloadButton()).toBeNull();
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
    expect(screen.queryByRole('button', { name: /Générer|Réessayer$/ })).toBeNull();
    expect(downloadButton()).toBeNull();
    // L'export suivi n'est pas oublié (ce n'est pas un 404).
    expect(window.sessionStorage.getItem('wordfix.export.ana_1')).not.toBeNull();

    // Le service répond de nouveau : l'export déjà prêt est retrouvé, sans nouvelle demande.
    server.getError = null;
    server.sequence = [exportDto('READY')];
    await userEvent.click(screen.getByRole('button', { name: 'Récupérer l’état maintenant' }));
    expect(await screen.findByText(/Document corrigé prêt/)).toBeInTheDocument();
    expect(server.createCalls).toBe(0);
  });

  it('disponibilité du fichier d’origine pas encore confirmée : génération désactivée', async () => {
    server.holdDocument = true;
    renderPanel(decided());
    expect(
      await screen.findByText('Vérification de la disponibilité de votre fichier d’origine…'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Générer le document corrigé' })).toBeDisabled();
  });

  it('vérification du fichier d’origine impossible : message clair, génération désactivée jusqu’à confirmation', async () => {
    server.documentError = new ApiError('NETWORK_ERROR', 'Connexion impossible.', 0);
    renderPanel(decided());
    expect(
      await screen.findByText(
        /La disponibilité de votre fichier d’origine n’a pas pu être vérifiée/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Générer le document corrigé' })).toBeDisabled();

    server.documentError = null;
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier maintenant' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Générer le document corrigé' })).toBeEnabled(),
    );
    expect(screen.queryByText(/n’a pas pu être vérifiée/)).toBeNull();
    expect(server.createCalls).toBe(0);
  });

  it('« Embellir » sans correction choisie : génération possible, options envoyées, compte rendu', async () => {
    server.sequence = [
      exportDto('READY', {
        requestedCount: 0,
        appliedCount: 0,
        options: { typography: true, layout: false },
        beautified: { typography: 3, layout: 0 },
      }),
    ];
    renderPanel([issue('iss_c', 'ignored')]);
    const button = await screen.findByRole('button', { name: 'Générer le document corrigé' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Typographie française/ }));
    expect(screen.getByText(/seules les améliorations « Embellir » cochées/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Générer le document corrigé' }));
    expect(server.createOptions).toEqual([{ typography: true, layout: false }]);
    expect(await screen.findByText('Document embelli prêt.')).toBeInTheDocument();
    expect(screen.getByText('Embellissement : 3 corrections typographiques.')).toBeInTheDocument();
    expect(downloadButton()).toBeEnabled();
  });

  it('« Embellir » sur un document déjà conforme : message clair, aucun téléchargement', async () => {
    server.sequence = [
      exportDto('FAILED', {
        requestedCount: 0,
        errorCode: 'EXPORT_UNCHANGED',
        options: { typography: false, layout: true },
      }),
    ];
    renderPanel([]);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Mise en page harmonisée/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Générer le document corrigé' }));
    expect(
      await screen.findByText(/n'avait besoin d'aucune des améliorations/),
    ).toBeInTheDocument();
    expect(downloadButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('option changée après la génération : document signalé comme périmé', async () => {
    server.sequence = [exportDto('READY')];
    renderPanel(decided());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Générer le document corrigé' }),
    );
    await screen.findByText(/Document corrigé prêt/);
    await userEvent.click(screen.getByRole('checkbox', { name: /Mise en page harmonisée/ }));
    expect(
      await screen.findByText(/Vos choix ont changé depuis la génération/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Générer une nouvelle version' })).toBeEnabled();
  });
});
