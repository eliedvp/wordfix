import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_PROVIDER, AiError } from '../src/ai/ai-provider.js';
import type { FakeAiProvider } from '../src/ai/providers/fake.provider.js';
import { AMBIGUITY_SCHEMA_NAME } from '../src/engine/language/ambiguity/resolve.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildDocx } from './fixtures/builders.js';
import { CLEAN_PARAGRAPHS } from './fixtures/prose.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Chaîne complète : DOCX → moteur déterministe → cas ambigus → IA (faux fournisseur) → remarques. */
describe('Cas ambigus : moteur déterministe puis IA (étape C)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let fake: FakeAiProvider;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await createTestWorker();
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(app);
    fake.calls = [];
    fake.failSchemas.clear();
    fake.responses.clear();
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  async function analyze(paragraphs: string[]) {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([
      { h: 1, text: '1. Introduction' },
      ...paragraphs.map((p) => ({ p })),
    ]);
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
      .expect(201);
    const start = await agent
      .post(`/api/documents/${upload.body.id as string}/analyze`)
      .expect(202);
    const analysisId = start.body.analysisId as string;
    const analysis = await waitFor(
      async () => (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto,
      (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
      30_000,
    );
    expect(analysis.status).toBe('COMPLETED');
    const list = (await agent.get(`/api/analyses/${analysisId}/issues`).expect(200))
      .body as IssueListDto;
    return { analysisId, list };
  }

  const find = (list: IssueListDto, original: string): IssueDto | undefined =>
    list.items.find((issue) => issue.original === original);

  const PARAGRAPHS = [
    ...CLEAN_PARAGRAPHS.slice(0, 3),
    'Je dispose également du peris de conduire de catégorie B.',
    'Dans le cadr de ma formation, j’ai réalisé un stage chez Kouassi à Gagnoa.',
  ];

  it('les cas ambigus sont départagés par l’IA, en un seul appel, sans jamais devenir des Erreurs', async () => {
    const { analysisId, list } = await analyze(PARAGRAPHS);
    expect(find(list, 'peris')).toMatchObject({
      suggestion: 'permis',
      nature: 'suggestion',
      source: 'verify',
    });
    expect(find(list, 'cadr')).toMatchObject({
      suggestion: 'cadre',
      nature: 'suggestion',
      source: 'verify',
    });
    expect(find(list, 'Kouassi')).toBeUndefined();
    expect(fake.calls.filter((name) => name === AMBIGUITY_SCHEMA_NAME)).toHaveLength(1);

    const chunks = await app.get(PrismaService).analysisChunk.findMany({
      where: { analysisId, stage: 'verify', index: { gte: 100 } },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ status: 'DONE' });
    expect(chunks[0]?.tokensIn).toBeGreaterThan(0);
    expect(chunks[0]?.result).toMatchObject({ cases: 2, corrected: 2, failed: null });
  }, 60_000);

  it('IA indisponible pour cette étape : l’analyse se termine, les cas restent « À vérifier »', async () => {
    fake.failSchemas.set(AMBIGUITY_SCHEMA_NAME, new AiError('unavailable', 'panne simulée'));
    const { list } = await analyze(PARAGRAPHS);
    expect(find(list, 'peris')).toMatchObject({ suggestion: null, nature: 'verify' });
    expect(list.items.every((issue) => issue.source !== 'verify' || issue.nature !== 'error')).toBe(
      true,
    );
  }, 60_000);

  it('fautes sûres pour le moteur déterministe : aucun appel à l’IA pour les cas ambigus', async () => {
    const { list } = await analyze([
      ...CLEAN_PARAGRAPHS.slice(0, 3),
      'Ce systeme est egalement utilisé par l’equipe technique.',
    ]);
    expect(find(list, 'systeme')).toMatchObject({
      suggestion: 'système',
      nature: 'error',
      source: 'rules',
    });
    expect(fake.calls).not.toContain(AMBIGUITY_SCHEMA_NAME);
  }, 60_000);
});
