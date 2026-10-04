import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_PROVIDER, AiError } from '../src/ai/ai-provider.js';
import type { FakeAiProvider } from '../src/ai/providers/fake.provider.js';
import { AnalysisRunner } from '../src/engine/analysis-runner.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildReviewDocument } from './fixtures/review-document.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Analyse complète (API + file BullMQ + worker + moteur)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let fake: FakeAiProvider;
  let docx: Buffer;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await createTestWorker();
    fake = worker.get<FakeAiProvider>(AI_PROVIDER);
    docx = await buildReviewDocument();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    fake.calls = [];
    fake.failNext = null;
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  async function uploadAndAnalyze(agent: ReturnType<typeof request.agent>) {
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
      .expect(201);
    const start = await agent
      .post(`/api/documents/${upload.body.id as string}/analyze`)
      .expect(202);
    return { documentId: upload.body.id as string, analysisId: start.body.analysisId as string };
  }

  const getAnalysis = async (agent: ReturnType<typeof request.agent>, id: string) =>
    (await agent.get(`/api/analyses/${id}`).expect(200)).body as AnalysisDto;

  it('analyse le document de bout en bout et classe chaque problème', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await uploadAndAnalyze(agent);

    const analysis = await waitFor(
      () => getAnalysis(agent, analysisId),
      (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
    );
    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.progress).toBe(100);
    expect(analysis.score).toBeGreaterThan(0);
    expect(analysis.steps.every((step) => step.state === 'done')).toBe(true);
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        'local_review',
        'context_review',
        'global_review',
        'contradiction_check',
      ]),
    );

    const { body } = await agent.get(`/api/analyses/${analysisId}/issues`).expect(200);
    const list = body as IssueListDto;
    const find = (subtype: string) =>
      list.items.find((issue: IssueDto) => issue.subtype === subtype);

    // Analyse locale : erreur certaine, localisée précisément.
    const agreement = find('agreement');
    expect(agreement).toMatchObject({
      nature: 'error',
      original: 'serveurs informatique',
      suggestion: 'serveurs informatiques',
    });
    expect(agreement?.location.sectionPath).toBe('1. Introduction > 1.1 Contexte');
    expect(agreement?.location.paragraphInSection).toBe(1);
    expect(list.blocks[agreement?.location.blockId ?? '']?.text).toContain('serveurs informatique');

    // Règles déterministes.
    expect(find('typo')).toMatchObject({ nature: 'error', original: 'Le le' });
    expect(find('heading_numbering')).toMatchObject({ nature: 'potential' });

    // Analyse contextuelle : hypothèse, jamais une erreur.
    expect(find('weak_transition')?.nature).toBe('verify');

    // Analyse globale + vérification : contradiction « à examiner », deux passages liés.
    const contradiction = find('contradiction');
    expect(contradiction).toMatchObject({
      nature: 'potential',
      source: 'verify',
      original: '3 mois',
    });
    expect(contradiction?.related).toHaveLength(1);
    expect(contradiction?.related[0]?.sectionPath).toBe('2. Déroulement du stage');

    expect(analysis.natureCounts.error).toBeGreaterThanOrEqual(2);
    expect(analysis.issueCount).toBe(list.total);
  });

  it('enregistre les décisions de l’utilisateur et filtre la liste', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await uploadAndAnalyze(agent);
    await waitFor(
      () => getAnalysis(agent, analysisId),
      (a) => a.status === 'COMPLETED',
    );

    const { body } = await agent.get(`/api/analyses/${analysisId}/issues`).expect(200);
    const items = (body as IssueListDto).items;
    const first = items.find((i) => i.suggestion);
    const [second, third] = items.filter((i) => i.id !== first?.id);
    expect(first && second && third).toBeTruthy();

    await agent.patch(`/api/issues/${first!.id}`).send({ status: 'accepted' }).expect(200);
    await agent.patch(`/api/issues/${second!.id}`).send({ status: 'ignored' }).expect(200);
    const edited = await agent
      .patch(`/api/issues/${third!.id}`)
      .send({ status: 'edited', userText: 'Ma version.' })
      .expect(200);
    expect(edited.body).toMatchObject({ status: 'edited', userText: 'Ma version.' });

    await agent.patch(`/api/issues/${first!.id}`).send({ status: 'edited' }).expect(400);
    const withoutSuggestion = items.find((i) => !i.suggestion);
    await agent
      .patch(`/api/issues/${withoutSuggestion!.id}`)
      .send({ status: 'accepted' })
      .expect(400);
    await agent.patch(`/api/issues/${first!.id}`).send({ status: 'nimporte' }).expect(400);

    const done = await agent.get(`/api/analyses/${analysisId}/issues?status=done`).expect(200);
    expect(done.body.total).toBe(3);
    const errors = await agent.get(`/api/analyses/${analysisId}/issues?nature=error`).expect(200);
    expect(errors.body.items.every((i: IssueDto) => i.nature === 'error')).toBe(true);
    await agent.get(`/api/analyses/${analysisId}/issues?category=hack`).expect(400);

    const analysis = await getAnalysis(agent, analysisId);
    expect(analysis.reviewedCount).toBe(3);

    // Une autre session ne peut ni lire ni modifier.
    const other = request.agent(app.getHttpServer());
    await other.get(`/api/analyses/${analysisId}`).expect(404);
    await other.patch(`/api/issues/${first!.id}`).send({ status: 'open' }).expect(404);
  });

  it('refuse une deuxième analyse simultanée et permet d’annuler', async () => {
    await worker.close();
    try {
      const agent = request.agent(app.getHttpServer());
      const { documentId, analysisId } = await uploadAndAnalyze(agent);
      const again = await agent.post(`/api/documents/${documentId}/analyze`).expect(409);
      expect(again.body.error.code).toBe('ANALYSIS_IN_PROGRESS');

      const canceled = await agent.post(`/api/analyses/${analysisId}/cancel`).expect(200);
      expect(canceled.body.status).toBe('CANCELED');
      const twice = await agent.post(`/api/analyses/${analysisId}/cancel`).expect(409);
      expect(twice.body.error.code).toBe('ANALYSIS_NOT_CANCELABLE');

      // Après annulation, une nouvelle analyse peut être lancée.
      await agent.post(`/api/documents/${documentId}/analyze`).expect(202);
    } finally {
      worker = await createTestWorker();
      fake = worker.get<FakeAiProvider>(AI_PROVIDER);
    }
  });

  it('échoue proprement si le fournisseur IA est indisponible, puis permet de relancer', async () => {
    const agent = request.agent(app.getHttpServer());
    fake.failNext = new AiError('unavailable', 'panne simulée');
    const { documentId, analysisId } = await uploadAndAnalyze(agent);

    const failed = await waitFor(
      () => getAnalysis(agent, analysisId),
      (a) => a.status === 'FAILED' || a.status === 'COMPLETED',
    );
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('AI_UNAVAILABLE');

    const retry = await agent.post(`/api/documents/${documentId}/analyze`).expect(202);
    const done = await waitFor(
      () => getAnalysis(agent, retry.body.analysisId as string),
      (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
    );
    expect(done.status).toBe('COMPLETED');
  });

  it('reprend une analyse interrompue sans refaire les morceaux déjà traités', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await uploadAndAnalyze(agent);
    await waitFor(
      () => getAnalysis(agent, analysisId),
      (a) => a.status === 'COMPLETED',
    );

    // Simule un worker arrêté pendant l'analyse contextuelle.
    const prisma = worker.get(PrismaService);
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'ANALYZING_CONTEXT', completedAt: null },
    });
    const contextChunk = await prisma.analysisChunk.findFirstOrThrow({
      where: { analysisId, stage: 'context' },
    });
    await prisma.analysisChunk.update({
      where: { id: contextChunk.id },
      data: { status: 'PENDING' },
    });
    fake.calls = [];

    await worker.get(AnalysisRunner).run(analysisId);

    expect(fake.calls).not.toContain('local_review');
    expect(fake.calls.filter((call) => call === 'context_review')).toHaveLength(1);
    const resumed = await getAnalysis(agent, analysisId);
    expect(resumed.status).toBe('COMPLETED');
  });

  it('supprime le document pendant l’analyse sans laisser de trace', async () => {
    await worker.close();
    try {
      const agent = request.agent(app.getHttpServer());
      const { documentId, analysisId } = await uploadAndAnalyze(agent);
      await agent.delete(`/api/documents/${documentId}`).expect(204);
      await agent.get(`/api/analyses/${analysisId}`).expect(404);
      const prisma = app.get(PrismaService);
      expect(await prisma.issue.count()).toBe(0);
    } finally {
      worker = await createTestWorker();
      fake = worker.get<FakeAiProvider>(AI_PROVIDER);
    }
  });
});
