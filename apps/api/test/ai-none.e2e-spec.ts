import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, DocumentDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { AI_PROVIDER, type AiProvider } from '../src/ai/ai-provider.js';
import { AnalysisRunner } from '../src/engine/analysis-runner.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildDocx } from './fixtures/builders.js';
import { reviewDocumentNodes } from './fixtures/review-document.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

/**
 * Mode sans IA (AI_PROVIDER=none), configuration par défaut de WordFix : aucune clé,
 * budget IA à 0. Une analyse complète doit se terminer avec le seul moteur local, sans
 * aucun appel IA, et le signaler clairement.
 */
vi.hoisted(() => {
  process.env.AI_PROVIDER = 'none';
  process.env.AI_PAID_CALLS_ENABLED = 'false';
  process.env.AI_DAILY_TOKEN_BUDGET = '0';
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

// Les modules des fournisseurs payants ne doivent jamais être chargés dans ce mode.
const loaded = vi.hoisted(() => ({ openai: 0, gemini: 0, fake: 0 }));
vi.mock('../src/ai/providers/openai.provider.js', () => {
  loaded.openai++;
  return {};
});
vi.mock('../src/ai/providers/gemini.provider.js', () => {
  loaded.gemini++;
  return {};
});
vi.mock('../src/ai/providers/fake.provider.js', () => {
  loaded.fake++;
  return {};
});

// Nombre d'exécutions du moteur de règles (reprise sans relancer le moteur local).
const rules = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/engine/rules/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/rules/rules.js')>();
  return {
    ...actual,
    runRules: (...args: Parameters<typeof actual.runRules>) => {
      rules.calls++;
      return actual.runRules(...args);
    },
  };
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Cas ambigu de l'étape C : sans IA, il garde sa forme déterministe (« À vérifier »).
const PERIS = 'Je dispose également du peris de conduire de catégorie B.';
const AI_HOSTS = /openai\.com|googleapis\.com|generativelanguage/i;

describe('Mode sans IA (AI_PROVIDER=none) : analyse complète avec le moteur local seul', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await createTestWorker();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(app);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  const aiRequests = () =>
    fetchSpy.mock.calls.filter(([url]) =>
      AI_HOSTS.test(url instanceof Request ? url.url : String(url)),
    );

  async function analyze() {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([...reviewDocumentNodes(), { p: PERIS }]);
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
      .expect(201);
    // Budget IA à 0 : l'analyse locale n'est pas refusée pour autant.
    const start = await agent
      .post(`/api/documents/${upload.body.id as string}/analyze`)
      .expect(202);
    const analysisId = start.body.analysisId as string;
    const analysis = await waitFor(
      async () => (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto,
      (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
      30_000,
    );
    const issues = (await agent.get(`/api/analyses/${analysisId}/issues`).expect(200))
      .body as IssueListDto;
    return { agent, analysisId, analysis, issues };
  }

  it('le service annonce le mode sans IA, et le worker n’a aucun fournisseur payant', async () => {
    await request(app.getHttpServer()).get('/api/ai-mode').expect(200, { mode: 'none' });
    expect(worker.get<AiProvider>(AI_PROVIDER).name).toBe('none');
    expect(loaded).toEqual({ openai: 0, gemini: 0, fake: 0 });
  });

  it('analyse terminée sans aucun appel IA, clairement signalée « sans IA »', async () => {
    const { agent, analysisId, analysis, issues } = await analyze();

    // Terminée, avec un score, mais explicitement « sans IA ».
    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.score).not.toBeNull();
    expect(analysis.warnings).toContain('AI_DISABLED');
    expect(analysis.warnings).not.toContain('AI_CHECKS_SKIPPED');
    expect(analysis.warnings).not.toContain('PARTIAL_ANALYSIS');
    // Les étapes faites par l'IA sont « sautées », jamais « terminées ».
    expect(Object.fromEntries(analysis.steps.map((step) => [step.key, step.state]))).toMatchObject({
      extract: 'done',
      local: 'skipped',
      context: 'skipped',
      global: 'skipped',
      finalize: 'done',
    });
    // L'historique le signale aussi.
    const documents = (await agent.get('/api/documents').expect(200)).body as DocumentDto[];
    expect(documents[0]?.latestAnalysis?.aiDisabled).toBe(true);

    // Résultats du moteur local seulement ; le cas ambigu garde sa forme sans IA.
    expect(issues.items.length).toBeGreaterThan(0);
    expect(issues.items.every((issue) => issue.source === 'rules')).toBe(true);
    expect(issues.items.find((issue) => issue.original === 'Le le')).toMatchObject({
      nature: 'error',
    });
    expect(issues.items.find((issue) => issue.original === 'peris')).toMatchObject({
      nature: 'verify',
      suggestion: null,
    });

    // Aucun appel IA : aucun morceau IA, aucun modèle, aucun jeton, aucune requête.
    const prisma = worker.get(PrismaService);
    expect(await prisma.analysisChunk.count({ where: { analysisId } })).toBe(0);
    const stored = await prisma.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(stored).toMatchObject({
      chunksTotal: 0,
      modelFast: null,
      modelSmart: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(aiRequests()).toEqual([]);
    expect(loaded).toEqual({ openai: 0, gemini: 0, fake: 0 });
  }, 60_000);

  it('reprise d’une analyse sans IA : le moteur local n’est pas relancé, rien n’est dupliqué', async () => {
    const { agent, analysisId } = await analyze();
    const prisma = worker.get(PrismaService);
    const issuesBefore = await prisma.issue.count({ where: { analysisId } });

    // Simule un worker arrêté après la planification, pendant l'analyse.
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'ANALYZING_LOCAL', completedAt: null },
    });
    const rulesBefore = rules.calls;
    await worker.get(AnalysisRunner).run(analysisId);

    expect(rules.calls).toBe(rulesBefore);
    expect(await prisma.issue.count({ where: { analysisId } })).toBe(issuesBefore);
    const resumed = (await agent.get(`/api/analyses/${analysisId}`).expect(200))
      .body as AnalysisDto;
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.warnings).toContain('AI_DISABLED');
    expect(aiRequests()).toEqual([]);
  }, 60_000);
});
