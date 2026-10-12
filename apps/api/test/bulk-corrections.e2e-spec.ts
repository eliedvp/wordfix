import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type {
  AcceptReliableResultDto,
  AnalysisDto,
  DocumentModel,
  ExportDto,
  IssueListDto,
  UndoAcceptResultDto,
} from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/common/ids.js';
import { parseDocx } from '../src/docx/parser/docx-parser.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildDocx } from './fixtures/builders.js';
import {
  createTestApp,
  createTestExportWorker,
  createTestWorker,
  resetDatabase,
  waitFor,
} from './helpers.js';

/**
 * « Tout corriger » : acceptation groupée des seules corrections fiables, décisions
 * de l'utilisateur préservées, annulation, droits, et document corrigé produit
 * avec ces corrections.
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

const TEXT = 'Une fote et une erreurr dans ce raport, avec un detail de style.';

/** Document analysé, sans aucun point : chaque test pose ses propres points. */
async function analyzedDocument(agent: Agent) {
  const docx = await buildDocx([{ p: TEXT }]);
  const upload = await agent
    .post('/api/documents')
    .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
    .expect(201);
  const documentId = upload.body.id as string;
  const start = await agent.post(`/api/documents/${documentId}/analyze`).expect(202);
  const analysisId = start.body.analysisId as string;
  await waitFor(
    async () => (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto,
    (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
    30_000,
  );
  await prisma.issue.deleteMany({ where: { analysisId } });
  const content = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
  const block = (content.model as unknown as DocumentModel).blocks[0];
  if (!block) throw new Error('bloc attendu');
  return { documentId, analysisId, block };
}

type IssueFields = Partial<Prisma.IssueUncheckedCreateInput> & { original: string };

async function addIssue(
  analysisId: string,
  block: { id: string; text: string; order: number },
  fields: IssueFields,
): Promise<string> {
  const start = block.text.indexOf(fields.original);
  if (start < 0) throw new Error(`passage introuvable : ${fields.original}`);
  const id = newId('iss');
  await prisma.issue.create({
    data: {
      id,
      analysisId,
      category: 'spelling',
      subtype: 'test',
      nature: 'error',
      severity: 'minor',
      confidence: 'high',
      source: 'rules',
      blockId: block.id,
      sectionPath: '',
      charStart: start,
      charEnd: start + fields.original.length,
      docOrder: block.order * 10_000 + start,
      suggestion: null,
      explanation: 'Point de test.',
      status: 'open',
      fingerprint: id,
      ...fields,
    },
  });
  return id;
}

async function statuses(analysisId: string): Promise<Record<string, string>> {
  const issues = await prisma.issue.findMany({ where: { analysisId } });
  return Object.fromEntries(issues.map((i) => [i.id, `${i.status}:${i.userText ?? ''}`]));
}

describe('Tout corriger', () => {
  it('accepte seulement les corrections fiables encore à traiter ; les décisions de l’utilisateur restent', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId, block } = await analyzedDocument(agent);
    const reliable = await addIssue(analysisId, block, { original: 'fote', suggestion: 'faute' });
    const grammar = await addIssue(analysisId, block, {
      original: 'erreurr',
      suggestion: 'erreur',
      category: 'grammar',
    });
    const punctuation = await addIssue(analysisId, block, {
      original: 'raport,',
      suggestion: 'rapport,',
      category: 'punctuation',
    });
    // Jamais appliqués automatiquement :
    const excluded = {
      medium: await addIssue(analysisId, block, {
        original: 'Une',
        suggestion: 'Un',
        confidence: 'medium',
      }),
      verify: await addIssue(analysisId, block, {
        original: 'dans',
        suggestion: 'en',
        nature: 'verify',
      }),
      style: await addIssue(analysisId, block, {
        original: 'detail',
        suggestion: 'détail',
        category: 'style',
      }),
      noSuggestion: await addIssue(analysisId, block, { original: 'ce', suggestion: null }),
      sameText: await addIssue(analysisId, block, { original: 'avec', suggestion: 'avec' }),
      multiline: await addIssue(analysisId, block, { original: 'un', suggestion: 'un\nautre' }),
    };
    // Décisions de l'utilisateur (même sur des corrections fiables) : jamais remplacées.
    const edited = await addIssue(analysisId, block, {
      original: 'et',
      suggestion: 'est',
      status: 'edited',
      userText: 'et puis',
    });
    const ignored = await addIssue(analysisId, block, {
      original: 'de',
      suggestion: 'du',
      status: 'ignored',
    });

    const res = await agent.post(`/api/analyses/${analysisId}/issues/accept-reliable`).expect(200);
    const body = res.body as AcceptReliableResultDto;
    expect(body.acceptedIds.sort()).toEqual([reliable, grammar, punctuation].sort());
    expect(body.analysis).toEqual({ id: analysisId, reviewedCount: 5, issueCount: 11 });

    const after = await statuses(analysisId);
    expect(after[reliable]).toBe('accepted:');
    for (const id of Object.values(excluded)) expect(after[id]).toBe('open:');
    expect(after[edited]).toBe('edited:et puis');
    expect(after[ignored]).toBe('ignored:');

    // Deuxième demande : plus rien de fiable à traiter.
    const again = await agent
      .post(`/api/analyses/${analysisId}/issues/accept-reliable`)
      .expect(200);
    expect((again.body as AcceptReliableResultDto).acceptedIds).toEqual([]);

    // Le compteur de l'analyse suit.
    const analysis = (await agent.get(`/api/analyses/${analysisId}`).expect(200))
      .body as AnalysisDto;
    expect(analysis.reviewedCount).toBe(5);
  }, 60_000);

  it('annulation : les points acceptés redeviennent à traiter, sauf ceux modifiés depuis', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId, block } = await analyzedDocument(agent);
    const a = await addIssue(analysisId, block, { original: 'fote', suggestion: 'faute' });
    const b = await addIssue(analysisId, block, { original: 'erreurr', suggestion: 'erreur' });
    const accepted = (
      await agent.post(`/api/analyses/${analysisId}/issues/accept-reliable`).expect(200)
    ).body as AcceptReliableResultDto;
    expect(accepted.acceptedIds.sort()).toEqual([a, b].sort());

    // Entre-temps, l'utilisateur modifie l'un des deux : sa décision est conservée.
    await agent
      .patch(`/api/issues/${b}`)
      .send({ status: 'edited', userText: 'erreur' })
      .expect(200);

    const undo = await agent
      .post(`/api/analyses/${analysisId}/issues/undo-accept`)
      .send({ issueIds: accepted.acceptedIds })
      .expect(200);
    const body = undo.body as UndoAcceptResultDto;
    expect(body.reopenedIds).toEqual([a]);
    expect(body.analysis).toEqual({ id: analysisId, reviewedCount: 1, issueCount: 2 });
    expect(await statuses(analysisId)).toEqual({ [a]: 'open:', [b]: 'edited:erreur' });

    const list = (await agent.get(`/api/analyses/${analysisId}/issues?status=all`).expect(200))
      .body as IssueListDto;
    expect(list.items.find((i) => i.id === a)?.status).toBe('open');
  }, 60_000);

  it('droits et validation : autre session 404, analyse non terminée 409, identifiants invalides 400', async () => {
    const owner = request.agent(app.getHttpServer());
    const { analysisId, block } = await analyzedDocument(owner);
    const id = await addIssue(analysisId, block, { original: 'fote', suggestion: 'faute' });

    const other = request.agent(app.getHttpServer());
    await other.get('/api/documents').expect(200); // crée une autre session
    await other.post(`/api/analyses/${analysisId}/issues/accept-reliable`).expect(404);
    await other
      .post(`/api/analyses/${analysisId}/issues/undo-accept`)
      .send({ issueIds: [id] })
      .expect(404);
    expect((await statuses(analysisId))[id]).toBe('open:');

    await owner
      .post(`/api/analyses/${analysisId}/issues/undo-accept`)
      .send({ issueIds: ['pas-un-id'] })
      .expect(400);
    await owner.post(`/api/analyses/${analysisId}/issues/undo-accept`).send({}).expect(400);

    await prisma.analysis.update({ where: { id: analysisId }, data: { status: 'FINALIZING' } });
    const res = await owner.post(`/api/analyses/${analysisId}/issues/accept-reliable`).expect(409);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_READY');
  }, 60_000);

  it('le document corrigé contient les corrections acceptées par « Tout corriger »', async () => {
    const exportWorker = await createTestExportWorker();
    try {
      const agent = request.agent(app.getHttpServer());
      const { analysisId, block } = await analyzedDocument(agent);
      await addIssue(analysisId, block, { original: 'fote', suggestion: 'faute' });
      await addIssue(analysisId, block, { original: 'erreurr', suggestion: 'erreur' });
      await addIssue(analysisId, block, {
        original: 'detail',
        suggestion: 'détail',
        category: 'style',
      });
      await agent.post(`/api/analyses/${analysisId}/issues/accept-reliable`).expect(200);

      const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
      const done = await waitFor(
        async () =>
          (await agent.get(`/api/exports/${created.body.id as string}`).expect(200))
            .body as ExportDto,
        (e) => e.status === 'READY' || e.status === 'FAILED',
        60_000,
      );
      expect(done).toMatchObject({ status: 'READY', requestedCount: 2, appliedCount: 2 });
      const file = await agent
        .get(`/api/exports/${done.id}/download`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const text = (await parseDocx(file.body as Buffer)).blocks[0]?.text;
      // Corrections fiables appliquées ; la suggestion de style, non acceptée, ne l'est pas.
      expect(text).toBe('Une faute et une erreur dans ce raport, avec un detail de style.');
    } finally {
      await exportWorker.close();
    }
  }, 90_000);
});
