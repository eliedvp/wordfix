import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, DocumentModel, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flattenSections } from '../src/docx/parser/sections.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CORPUS, type CorpusCase } from './fixtures/corpus.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Stratégie QA : chaque document du corpus passe par le vrai parcours
 * (import → file → worker → moteur → base → API), avec le fournisseur IA de test.
 */
describe('Corpus QA (13 types de documents)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await createTestWorker();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  async function analyze(item: CorpusCase) {
    const agent = request.agent(app.getHttpServer());
    const upload = await agent
      .post('/api/documents')
      .attach('file', await item.build(), { filename: item.filename, contentType: DOCX_MIME });
    expect(upload.status).toBe(item.uploadStatus);
    const start = await agent
      .post(`/api/documents/${upload.body.id as string}/analyze`)
      .expect(202);
    const analysisId = start.body.analysisId as string;
    const analysis = await waitFor(
      async () => (await agent.get(`/api/analyses/${analysisId}`)).body as AnalysisDto,
      (a) => ['COMPLETED', 'FAILED', 'CANCELED'].includes(a.status),
      60_000,
    );
    const issues = (await agent.get(`/api/analyses/${analysisId}/issues`)).body as IssueListDto;
    return { analysis, issues, documentId: upload.body.id as string };
  }

  const rejected = CORPUS.filter((item) => item.uploadError !== null);
  it.each(rejected.map((item) => [item.title, item] as const))(
    'refuse proprement : %s',
    async (_title, item) => {
      const res = await request(app.getHttpServer())
        .post('/api/documents')
        .attach('file', await item.build(), { filename: item.filename, contentType: DOCX_MIME });
      expect(res.status).toBe(item.uploadStatus);
      expect(res.body.error.code).toBe(item.uploadError);
      expect(res.body.error.message.length).toBeGreaterThan(10);
      expect(res.headers['set-cookie']).toBeUndefined();
    },
    30_000,
  );

  const byKey = (key: string) => CORPUS.find((item) => item.key === key) as CorpusCase;

  it('01 — petit document : analyse complète, aucune erreur inventée', async () => {
    const { analysis } = await analyze(byKey('01-petit'));
    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.natureCounts.error).toBe(0);
  });

  it('02 — rapport de 10 pages : pages et sections cohérentes', async () => {
    const { analysis } = await analyze(byKey('02-rapport-10p'));
    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.estimatedPages).toBeGreaterThanOrEqual(8);
    expect(analysis.estimatedPages).toBeLessThanOrEqual(12);
  });

  it('03 — rapport de 45 pages : découpage en morceaux et fin d’analyse', async () => {
    const started = Date.now();
    const { analysis } = await analyze(byKey('03-rapport-45p'));
    expect(analysis.status).toBe('COMPLETED');
    expect(analysis.estimatedPages).toBeGreaterThanOrEqual(40);
    expect(analysis.chunksTotal).toBeGreaterThan(10);
    expect(analysis.chunksDone).toBe(analysis.chunksTotal);
    // Sans IA réelle, le pipeline lui-même doit rester rapide.
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 60_000);

  it('04 — beaucoup de fautes : relevées, plafonnées, classées en erreurs', async () => {
    const { analysis, issues } = await analyze(byKey('04-beaucoup-fautes'));
    expect(analysis.natureCounts.error).toBeGreaterThanOrEqual(10);
    expect(issues.items.filter((i) => i.subtype === 'typo').length).toBeLessThanOrEqual(30);
    expect(analysis.score).toBeLessThan(90);
  });

  it('05 — presque sans faute : score élevé, aucune erreur', async () => {
    const { analysis } = await analyze(byKey('05-presque-sans-faute'));
    expect(analysis.natureCounts.error).toBe(0);
    expect(analysis.score).toBeGreaterThanOrEqual(90);
  });

  it('06 — répétitions : mots doublés et graphies concurrentes', async () => {
    const { issues } = await analyze(byKey('06-repetitions'));
    expect(issues.items.some((i) => i.subtype === 'typo' && i.original === 'Le le')).toBe(true);
    const variants = issues.items.filter((i) => i.subtype === 'terminology_variant');
    expect(variants.map((v) => v.original.toLowerCase()).sort()).toEqual(['e-mail', 'wi-fi']);
  });

  it('07 — contradictions : signalées « à examiner », jamais « erreur »', async () => {
    const { issues } = await analyze(byKey('07-contradictions'));
    const contradictions = issues.items.filter((i) => i.subtype === 'contradiction');
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.nature).toBe('potential');
    expect(contradictions[0]?.related).toHaveLength(1);
  });

  it('08 — tableaux : fautes localisées dans la bonne cellule', async () => {
    const { issues } = await analyze(byKey('08-tableaux'));
    const inTable = issues.items.filter((i) => i.location.label?.startsWith('Tableau 1'));
    expect(inTable.map((i) => i.location.label)).toEqual(
      expect.arrayContaining(['Tableau 1, ligne 2, colonne 3', 'Tableau 1, ligne 3, colonne 3']),
    );
  });

  it('09 — titres complexes : arbre à 4 niveaux et numérotation vérifiée', async () => {
    const { issues, documentId } = await analyze(byKey('09-titres-complexes'));
    const content = await worker
      .get(PrismaService)
      .documentContent.findUniqueOrThrow({ where: { documentId } });
    const paths = flattenSections((content.model as unknown as DocumentModel).sections).map(
      (s) => s.path,
    );
    expect(paths).toContain(
      '1. Introduction > 1.1 Contexte > 1.1.1 Historique > 1.1.1.1 Premières versions',
    );
    expect(issues.items.filter((i) => i.subtype === 'heading_numbering')).toHaveLength(1);
  });
});
