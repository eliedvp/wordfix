import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildDocx, type FixtureNode } from './fixtures/builders.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

/**
 * Structure du document (présence d'un sommaire, de titres, de titres numérotés)
 * renvoyée avec la liste des points : calculée à partir du contenu déjà extrait, sans
 * IA ; `null` si ce contenu n'est plus disponible (documents existants, expiration).
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Agent = ReturnType<typeof request.agent>;

let app: INestApplication;
let worker: INestApplicationContext;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  worker = await createTestWorker();
  prisma = app.get(PrismaService);
}, 60_000);

afterAll(async () => {
  await worker.close();
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(app);
});

async function analyzed(agent: Agent, nodes: FixtureNode[]) {
  const upload = await agent
    .post('/api/documents')
    .attach('file', await buildDocx(nodes), { filename: 'Rapport.docx', contentType: DOCX_MIME })
    .expect(201);
  const documentId = upload.body.id as string;
  const start = await agent.post(`/api/documents/${documentId}/analyze`).expect(202);
  const analysisId = start.body.analysisId as string;
  const done = await waitFor(
    async () => (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto,
    (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
    30_000,
  );
  expect(done.status).toBe('COMPLETED');
  return { documentId, analysisId };
}

const listIssues = async (agent: Agent, analysisId: string, query = '') =>
  (await agent.get(`/api/analyses/${analysisId}/issues${query}`).expect(200)).body as IssueListDto;

describe('Structure du document dans la liste des points', () => {
  it('sommaire, titres et titres numérotés : présence comptée, conformité donnée par les points', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await analyzed(agent, [
      { toc: 'Sommaire' },
      { toc: '1. Introduction\t3' },
      { toc: '2. Partie supprimée\t7' },
      { h: 1, text: '1. Introduction' },
      { p: 'Le contexte du stage est présenté ici.' },
      { h: 2, text: '1.1 Contexte' },
      { h: 2, text: '1.3 Objectifs' },
      { h: 1, text: 'Conclusion' },
    ]);
    const list = await listIssues(agent, analysisId);
    expect(list.structure).toMatchObject({
      headings: 4,
      inferredHeadings: 0,
      numberedHeadings: 3,
      // 1.3 comparé à 1.1 ; « 1. » et « 1.1 » ouvrent leur niveau.
      comparedNumberedHeadings: 1,
      tocEntries: 3,
      comparableTocEntries: 2,
    });
    expect(['rendered_break', 'word_count']).toContain(list.structure?.pageMethod);
    // Conformité : un écart de sommaire et un saut de numérotation relevés par les règles.
    const subtypes = list.items.map((issue) => issue.subtype);
    expect(subtypes.filter((s) => s === 'toc_mismatch')).toHaveLength(1);
    expect(subtypes.filter((s) => s === 'heading_numbering')).toHaveLength(1);
    // Filtrer les points ne change pas la structure du document.
    const filtered = await listIssues(agent, analysisId, '?category=spelling');
    expect(filtered.structure).toEqual(list.structure);
  }, 90_000);

  it('document sans sommaire ni titre : présence à zéro (jamais « conforme » par défaut)', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await analyzed(agent, [{ p: 'Un simple paragraphe de texte.' }]);
    const list = await listIssues(agent, analysisId);
    expect(list.structure).toMatchObject({
      headings: 0,
      numberedHeadings: 0,
      comparedNumberedHeadings: 0,
      tocEntries: 0,
      comparableTocEntries: 0,
    });
  }, 90_000);

  it('contenu extrait supprimé (expiration, document ancien) : structure inconnue (null), points toujours listés', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzed(agent, [
      { h: 1, text: '1. Introduction' },
      { p: 'Une fote ici.' },
    ]);
    const before = await listIssues(agent, analysisId);
    await prisma.documentContent.delete({ where: { documentId } });
    const after = await listIssues(agent, analysisId);
    expect(after.structure).toBeNull();
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id));
  }, 90_000);

  it('droits : la structure n’est jamais renvoyée pour l’analyse d’une autre session', async () => {
    const owner = request.agent(app.getHttpServer());
    const { analysisId } = await analyzed(owner, [{ toc: '1. Introduction\t3' }]);
    const other = request.agent(app.getHttpServer());
    await other.get(`/api/analyses/${analysisId}/issues`).expect(404);
  }, 90_000);
});
