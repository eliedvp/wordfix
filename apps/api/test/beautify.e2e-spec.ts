import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, DocumentModel, ExportDto } from '@wordfix/shared';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/common/ids.js';
import { parseDocx } from '../src/docx/parser/docx-parser.js';
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
 * « Embellir mon document » dans l'export : typographie française et mise en page
 * harmonisée, seules ou avec les corrections ; le sens du texte ne change pas, rien
 * n'est produit si le document est déjà conforme, et l'original reste intact.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const NB = '\u00a0';
type Agent = ReturnType<typeof request.agent>;

let app: INestApplication;
let worker: INestApplicationContext;
let exportWorker: INestApplicationContext;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  worker = await createTestWorker();
  exportWorker = await createTestExportWorker();
  prisma = app.get(PrismaService);
}, 60_000);

afterAll(async () => {
  await exportWorker.close();
  await worker.close();
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(app);
});

/** Document analysé, sans aucun point (chaque test pose les siens). */
async function analyzedDocument(agent: Agent, docx: Buffer) {
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
  return { documentId, analysisId };
}

async function exportWith(agent: Agent, analysisId: string, body: object) {
  const created = await agent.post(`/api/analyses/${analysisId}/exports`).send(body).expect(202);
  return waitFor(
    async () =>
      (await agent.get(`/api/exports/${created.body.id as string}`).expect(200)).body as ExportDto,
    (e) => e.status === 'READY' || e.status === 'FAILED',
    60_000,
  );
}

async function download(agent: Agent, id: string): Promise<Buffer> {
  const res = await agent
    .get(`/api/exports/${id}/download`)
    .buffer(true)
    .parse((r, callback) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  return res.body as Buffer;
}

const texts = async (file: Buffer) => (await parseDocx(file)).blocks.map((b) => b.text);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('Embellir mon document', () => {
  it('seul (sans correction) : typographie et mise en page, sens du texte inchangé, original intact', async () => {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([
      { h: 1, text: 'Bilan' },
      { p: 'Attention! Le projet est «terminé» ; reste la note: rien.' },
    ]);
    const { documentId, analysisId } = await analyzedDocument(agent, docx);
    const sourcePath = `${process.env.STORAGE_LOCAL_DIR ?? ''}/documents/${documentId}/source.docx`;
    const sourceBefore = sha(await readFile(sourcePath));

    const done = await exportWith(agent, analysisId, { typography: true, layout: true });
    expect(done).toMatchObject({
      status: 'READY',
      requestedCount: 0,
      appliedCount: 0,
      options: { typography: true, layout: true },
    });
    expect(done.beautified).toEqual({ typography: 5, layout: 1 });

    const file = await download(agent, done.id);
    expect(await texts(file)).toEqual([
      'Bilan',
      `Attention${NB}! Le projet est «${NB}terminé${NB}»${NB}; reste la note${NB}: rien.`,
    ]);
    const xml = await (await JSZip.loadAsync(file)).file('word/document.xml')!.async('string');
    expect(xml).toContain('w:line="276"');
    // L'original n'est jamais modifié.
    const after = await readFile(sourcePath);
    expect(sha(after)).toBe(sourceBefore);
  }, 90_000);

  it('avec les corrections : corrections puis embellissement dans le même document', async () => {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([{ p: 'Une fote ici ; et  là.' }]);
    const { analysisId } = await analyzedDocument(agent, docx);
    const content = await prisma.documentContent.findFirstOrThrow({});
    const block = (content.model as unknown as DocumentModel).blocks[0];
    if (!block) throw new Error('bloc attendu');
    const id = newId('iss');
    const start = block.text.indexOf('fote');
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
        charEnd: start + 4,
        docOrder: start,
        original: 'fote',
        suggestion: 'faute',
        explanation: 'Point de test.',
        status: 'accepted',
        fingerprint: id,
      },
    });

    const done = await exportWith(agent, analysisId, { typography: true });
    expect(done).toMatchObject({ status: 'READY', requestedCount: 1, appliedCount: 1 });
    expect(done.beautified).toEqual({ typography: 2, layout: 0 });
    expect(await texts(await download(agent, done.id))).toEqual([`Une faute ici${NB}; et là.`]);
  }, 90_000);

  it('document déjà conforme : aucun fichier, code explicite (jamais l’original à la place)', async () => {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([{ h: 1, text: 'Titre' }]);
    const { analysisId } = await analyzedDocument(agent, docx);
    const done = await exportWith(agent, analysisId, { typography: true, layout: true });
    expect(done).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_UNCHANGED' });
    await agent.get(`/api/exports/${done.id}/download`).expect(409);
    const row = await prisma.export.findUniqueOrThrow({ where: { id: done.id } });
    expect(row.storageKey).toBeNull();
  }, 90_000);

  it('validation : rien à appliquer (422), option invalide (400), options différentes = nouvel export', async () => {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([{ p: 'Pourquoi?  Parce que.' }]);
    const { analysisId } = await analyzedDocument(agent, docx);

    const none = await agent.post(`/api/analyses/${analysisId}/exports`).send({}).expect(422);
    expect(none.body.error.code).toBe('EXPORT_NOTHING_TO_APPLY');
    await agent.post(`/api/analyses/${analysisId}/exports`).send({ typography: 'oui' }).expect(400);
    await agent.post(`/api/analyses/${analysisId}/exports`).send({ embellir: true }).expect(400);

    const typo = await exportWith(agent, analysisId, { typography: true });
    const again = await agent
      .post(`/api/analyses/${analysisId}/exports`)
      .send({ typography: true })
      .expect(202);
    expect(again.body.id).toBe(typo.id);
    const both = await agent
      .post(`/api/analyses/${analysisId}/exports`)
      .send({ typography: true, layout: true })
      .expect(202);
    expect(both.body.id).not.toBe(typo.id);
  }, 90_000);
});
