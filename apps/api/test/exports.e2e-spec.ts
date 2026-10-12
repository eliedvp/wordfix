import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { AnalysisDto, DocumentModel, ExportDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../src/common/ids.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { parseDocx } from '../src/docx/parser/docx-parser.js';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EXPORT_LIMITS, ExportChildRunner } from '../src/exports/export-child-runner.js';
import { ExportRecoveryService } from '../src/exports/export-recovery.service.js';
import { ExportRunner } from '../src/exports/export-runner.js';
import { CleanupService } from '../src/maintenance/cleanup.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { EXPORT_QUEUE } from '../src/queue/queue.constants.js';
import {
  exportKey,
  FILE_STORAGE,
  type FileStorage,
  sourceKey,
} from '../src/storage/file-storage.js';
import { buildDocx } from './fixtures/builders.js';
import {
  createTestApp,
  createTestExportWorker,
  createTestWorker,
  resetDatabase,
  waitFor,
} from './helpers.js';

/**
 * Documents corrigés (T3a) : demande, file `export` (service séparé, une tâche à la
 * fois, processus enfant par export), téléchargement, droits, quotas, limites,
 * récupération des exports bloqués et purge.
 */

/**
 * Contrôles de la mémoire de l'enfant par WordFix : seulement là où le pic est lisible
 * (Linux, /proc), comme dans le superviseur. Ailleurs (Windows, macOS), les tests qui
 * en dépendent sont signalés « ignorés », jamais comptés comme réussis.
 */
const MEMORY_CHECKS = existsSync('/proc/self/status');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const STORAGE = process.env.STORAGE_LOCAL_DIR ?? '';
type Agent = ReturnType<typeof request.agent>;

/** Phrases du document de test : aucune ne doit apparaître dans les journaux. */
const SENTENCES = [
  'Une phrase avec une fote dans le rapport.',
  'Le rapport contient une erreurr importante.',
  'Ce paragraphe reste strictement inchangé.',
];

let app: INestApplication;
let worker: INestApplicationContext;
let prisma: PrismaService;
const logged: unknown[] = [];

beforeAll(async () => {
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  app = await createTestApp();
  worker = await createTestWorker();
  prisma = app.get(PrismaService);
}, 60_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDatabase(app);
});

/** Importe le document de test, lance l'analyse et attend qu'elle soit terminée. */
async function analyzedDocument(agent: Agent, name = 'Rapport.docx') {
  const docx = await buildDocx([...SENTENCES.map((p) => ({ p })), { table: [['Cellule']] }]);
  const upload = await agent
    .post('/api/documents')
    .attach('file', docx, { filename: name, contentType: DOCX_MIME })
    .expect(201);
  const documentId = upload.body.id as string;
  const start = await agent.post(`/api/documents/${documentId}/analyze`).expect(202);
  const analysisId = start.body.analysisId as string;
  await waitFor(
    async () => (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto,
    (a) => a.status === 'COMPLETED' || a.status === 'FAILED',
    30_000,
  );
  // Les points de l'analyse restent « open » : seuls ceux ajoutés par les tests sont exportés.
  return { documentId, analysisId, docx };
}

/** Ajoute un point au statut donné, positionné sur `original` dans le bloc `where`. */
async function addIssue(
  analysisId: string,
  documentId: string,
  where: string,
  original: string,
  decision: { status: 'accepted'; suggestion: string } | { status: 'edited'; userText: string },
): Promise<string> {
  const content = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
  const block = (content.model as unknown as DocumentModel).blocks.find((b) =>
    b.text.includes(where),
  );
  if (!block) throw new Error(`bloc introuvable : ${where}`);
  const start = block.text.indexOf(original);
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
      charEnd: start + original.length,
      docOrder: block.order * 10_000 + start,
      original,
      suggestion: decision.status === 'accepted' ? decision.suggestion : 'x',
      userText: decision.status === 'edited' ? decision.userText : null,
      explanation: 'Point de test.',
      status: decision.status,
      fingerprint: id,
    },
  });
  return id;
}

async function waitExport(agent: Agent, id: string): Promise<ExportDto> {
  return waitFor(
    async () => (await agent.get(`/api/exports/${id}`).expect(200)).body as ExportDto,
    (e) => e.status === 'READY' || e.status === 'FAILED',
    60_000,
  );
}

function download(agent: Agent, id: string) {
  return agent
    .get(`/api/exports/${id}/download`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

const sourcePath = (documentId: string) => resolve(STORAGE, `documents/${documentId}/source.docx`);
const exportPath = (documentId: string, exportId: string) =>
  resolve(STORAGE, `documents/${documentId}/exports/${exportId}.docx`);

describe('Document corrigé : parcours complet', () => {
  let exportWorker: INestApplicationContext;
  beforeAll(async () => {
    exportWorker = await createTestExportWorker();
  });
  afterAll(async () => {
    await exportWorker.close();
  });

  it('applique les points acceptés et modifiés ; original intact ; fichier téléchargeable', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent, 'Rapport été.docx');
    const accepted = await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    const edited = await addIssue(analysisId, documentId, 'Le rapport', 'erreurr', {
      status: 'edited',
      userText: 'erreur',
    });

    const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
    expect(created.body).toMatchObject({ status: 'QUEUED', requestedCount: 2, analysisId });
    const done = await waitExport(agent, created.body.id as string);
    expect(done).toMatchObject({ status: 'READY', appliedCount: 2, skipped: [], errorCode: null });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(done.expiresAt).toBe(document.fileExpiresAt.toISOString());

    const file = await download(agent, done.id).expect(200);
    expect(file.headers['content-type']).toBe(DOCX_MIME);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="Rapport ete (corrige).docx"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9%20%28corrig%C3%A9%29.docx`,
    );
    const texts = (await parseDocx(file.body as Buffer)).blocks.map((b) => b.text);
    expect(texts).toEqual([
      'Une phrase avec une faute dans le rapport.',
      'Le rapport contient une erreur importante.',
      'Ce paragraphe reste strictement inchangé.',
      'Cellule',
    ]);

    // L'original n'est jamais modifié.
    const original = readFileSync(sourcePath(documentId));
    expect(createHash('sha256').update(original).digest('hex')).toBe(document.sha256);
    expect(existsSync(exportPath(documentId, done.id))).toBe(true);
    expect([accepted, edited]).toHaveLength(2);
  }, 90_000);

  it('aucun point accepté ni modifié : refus explicite, aucun export ni fichier', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await analyzedDocument(agent);
    const res = await agent.post(`/api/analyses/${analysisId}/exports`).expect(422);
    expect(res.body.error.code).toBe('EXPORT_NOTHING_TO_APPLY');
    expect(await prisma.export.count()).toBe(0);
  }, 60_000);

  it('aucune correction applicable : échec explicite, aucun fichier, motifs enregistrés', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    const issueId = await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    // Analyse devenue incohérente avec le fichier (texte enregistré différent).
    const content = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    const model = content.model as unknown as DocumentModel;
    model.blocks = model.blocks.map((b) =>
      b.text.startsWith('Une phrase') ? { ...b, text: `${b.text} (modifié)` } : b,
    );
    await prisma.documentContent.update({
      where: { documentId },
      data: { model: model as unknown as Prisma.InputJsonValue },
    });

    const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
    const done = await waitExport(agent, created.body.id as string);
    expect(done).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPORT_NO_APPLICABLE',
      appliedCount: 0,
      skipped: [{ issueId, reason: 'block_changed' }],
    });
    expect(existsSync(resolve(STORAGE, `documents/${documentId}/exports`))).toBe(false);
    const res = await download(agent, done.id).expect(409);
    expect(JSON.parse(String(res.body)).error.code).toBe('EXPORT_NOT_READY');
  }, 60_000);

  it('corrections figées à la demande : un changement de décision ensuite ne compte pas', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    const issueId = await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    await exportWorker.close();
    try {
      const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
      await agent.patch(`/api/issues/${issueId}`).send({ status: 'ignored' }).expect(200);
      exportWorker = await createTestExportWorker();
      const done = await waitExport(agent, created.body.id as string);
      expect(done).toMatchObject({ status: 'READY', appliedCount: 1 });
      const texts = (
        await parseDocx((await download(agent, done.id).expect(200)).body as Buffer)
      ).blocks.map((b) => b.text);
      expect(texts[0]).toBe('Une phrase avec une faute dans le rapport.');
    } finally {
      if (!exportWorker) exportWorker = await createTestExportWorker();
    }
  }, 90_000);

  it('une seule tâche d’export à la fois', async () => {
    const agent = request.agent(app.getHttpServer());
    const first = await analyzedDocument(agent, 'Un.docx');
    const second = await analyzedDocument(agent, 'Deux.docx');
    for (const { documentId, analysisId } of [first, second]) {
      await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
        status: 'accepted',
        suggestion: 'faute',
      });
    }
    const ids = [];
    for (const { analysisId } of [first, second]) {
      ids.push((await agent.post(`/api/analyses/${analysisId}/exports`).expect(202)).body.id);
    }
    for (const id of ids) await waitExport(agent, id as string);
    const rows = await prisma.export.findMany({ orderBy: { startedAt: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['READY', 'READY']);
    expect(rows[1]!.startedAt!.getTime()).toBeGreaterThanOrEqual(rows[0]!.completedAt!.getTime());
  }, 120_000);
});

describe('Document corrigé : droits, quotas, expiration', () => {
  let exportWorker: INestApplicationContext;
  beforeAll(async () => {
    exportWorker = await createTestExportWorker();
  });
  afterAll(async () => {
    await exportWorker.close();
  });

  it('autre session : 404 partout (demande, état, téléchargement)', async () => {
    const owner = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(owner);
    await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    const created = await owner.post(`/api/analyses/${analysisId}/exports`).expect(202);
    await waitExport(owner, created.body.id as string);

    const other = request.agent(app.getHttpServer());
    await other.post('/api/documents').attach('file', await buildDocx([{ p: 'Autre.' }]), {
      filename: 'autre.docx',
      contentType: DOCX_MIME,
    });
    await other.post(`/api/analyses/${analysisId}/exports`).expect(404);
    await other.get(`/api/exports/${created.body.id as string}`).expect(404);
    await other.get(`/api/exports/${created.body.id as string}/download`).expect(404);
    await request(app.getHttpServer())
      .get(`/api/exports/${created.body.id as string}`)
      .expect(404);
    await owner.get('/api/exports/exp_inexistant/download').expect(404);
  }, 60_000);

  it('quota : 10 demandes par heure et par session, puis refus (429)', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    for (let i = 0; i < 10; i++) {
      await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
    }
    // Mêmes corrections : le même export est renvoyé, sans nouveau traitement.
    expect(await prisma.export.count()).toBe(1);
    const res = await agent.post(`/api/analyses/${analysisId}/exports`).expect(429);
    expect(res.body.error.code).toBe('EXPORT_RATE_LIMITED');
  }, 60_000);

  it('fichier d’origine expiré : refus (410) ; document corrigé expiré : téléchargement refusé (410)', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
    const done = await waitExport(agent, created.body.id as string);
    await prisma.export.update({
      where: { id: done.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await download(agent, done.id).expect(410);
    expect(JSON.parse(String(expired.body)).error.code).toBe('EXPORT_EXPIRED');

    await prisma.document.update({
      where: { id: documentId },
      data: { fileDeletedAt: new Date() },
    });
    await prisma.export.deleteMany();
    const res = await agent.post(`/api/analyses/${analysisId}/exports`).expect(410);
    expect(res.body.error.code).toBe('FILE_EXPIRED');
    expect(await prisma.export.count()).toBe(0);
  }, 60_000);

  it('analyse non terminée : refus (409)', async () => {
    const agent = request.agent(app.getHttpServer());
    const { analysisId } = await analyzedDocument(agent);
    await prisma.analysis.update({ where: { id: analysisId }, data: { status: 'FINALIZING' } });
    const res = await agent.post(`/api/analyses/${analysisId}/exports`).expect(409);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_READY');
  }, 60_000);
});

describe('Document corrigé : limites du processus enfant', () => {
  afterEach(async () => {
    // Le worker d'analyse, séparé, reste disponible : une nouvelle analyse aboutit.
    const agent = request.agent(app.getHttpServer());
    await analyzedDocument(agent, 'Après.docx');
  });

  async function exportWithLimits(limits: { memoryLimitMb: number; timeoutMs: number }) {
    const exportWorker = await createTestExportWorker([{ token: EXPORT_LIMITS, value: limits }]);
    try {
      const agent = request.agent(app.getHttpServer());
      const { documentId, analysisId } = await analyzedDocument(agent);
      await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
        status: 'accepted',
        suggestion: 'faute',
      });
      const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
      const done = await waitExport(agent, created.body.id as string);
      return { done, documentId, exportWorker };
    } finally {
      await exportWorker.close();
    }
  }

  it.runIf(MEMORY_CHECKS)(
    'mémoire dépassée : processus enfant arrêté, export en échec, aucun fichier',
    async () => {
      const { done, documentId } = await exportWithLimits({
        memoryLimitMb: 40,
        timeoutMs: 120_000,
      });
      expect(done).toMatchObject({
        status: 'FAILED',
        errorCode: 'EXPORT_TOO_LARGE',
        appliedCount: 0,
      });
      expect(existsSync(resolve(STORAGE, `documents/${documentId}/exports`))).toBe(false);
    },
    120_000,
  );

  it('délai dépassé : processus enfant arrêté, export en échec', async () => {
    // 1 ms : aucun enfant ne peut terminer dans ce délai, quelle que soit la machine.
    const { done } = await exportWithLimits({ memoryLimitMb: 4096, timeoutMs: 1 });
    expect(done).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_TIMEOUT', appliedCount: 0 });
  }, 120_000);
});

describe('Document corrigé : exports bloqués et purge', () => {
  async function insertExport(
    documentId: string,
    analysisId: string,
    fields: Partial<{ status: 'QUEUED' | 'RUNNING' | 'READY'; createdAt: Date; startedAt: Date }>,
  ): Promise<string> {
    const id = newId('exp');
    await prisma.export.create({
      data: {
        id,
        analysisId,
        documentId,
        edits: [],
        editsHash: id,
        requestedCount: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...fields,
      },
    });
    return id;
  }

  it('bloqués depuis plus de 15 min : marqués en échec, au démarrage du service et ensuite', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    const old = new Date(Date.now() - 20 * 60_000);
    const recent = new Date(Date.now() - 60_000);
    const stuckRunning = await insertExport(documentId, analysisId, {
      status: 'RUNNING',
      createdAt: old,
      startedAt: old,
    });
    const stuckQueued = await insertExport(documentId, analysisId, {
      status: 'QUEUED',
      createdAt: old,
    });
    const running = await insertExport(documentId, analysisId, {
      status: 'RUNNING',
      createdAt: recent,
      startedAt: recent,
    });

    // Démarrage (ou redémarrage) du service d'export : récupération immédiate.
    const exportWorker = await createTestExportWorker();
    try {
      const statuses = async () =>
        Object.fromEntries(
          (await prisma.export.findMany()).map((e) => [e.id, `${e.status}:${e.errorCode ?? ''}`]),
        );
      expect(await statuses()).toMatchObject({
        [stuckRunning]: 'FAILED:EXPORT_FAILED',
        [stuckQueued]: 'FAILED:EXPORT_FAILED',
        [running]: 'RUNNING:',
      });
      // Plus tard, l'export récent devient bloqué à son tour.
      const later = new Date(Date.now() + 16 * 60_000);
      expect(await exportWorker.get(ExportRecoveryService).recover(later)).toBe(1);
      expect((await statuses())[running]).toBe('FAILED:EXPORT_FAILED');
    } finally {
      await exportWorker.close();
    }
  }, 60_000);

  it('purge : document corrigé expiré supprimé (fichier et export) ; suppression du document aussi', async () => {
    const exportWorker = await createTestExportWorker();
    try {
      const agent = request.agent(app.getHttpServer());
      const first = await analyzedDocument(agent, 'Un.docx');
      const second = await analyzedDocument(agent, 'Deux.docx');
      const ids: string[] = [];
      for (const { documentId, analysisId } of [first, second]) {
        await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
          status: 'accepted',
          suggestion: 'faute',
        });
        const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
        ids.push((await waitExport(agent, created.body.id as string)).id);
      }
      expect(existsSync(exportPath(first.documentId, ids[0]!))).toBe(true);

      await prisma.export.update({
        where: { id: ids[0] },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const report = await worker.get(CleanupService).run();
      expect(report.exportsDeleted).toBe(1);
      expect(existsSync(exportPath(first.documentId, ids[0]!))).toBe(false);
      expect(await prisma.export.findUnique({ where: { id: ids[0] } })).toBeNull();
      expect(existsSync(sourcePath(first.documentId))).toBe(true);

      await agent.delete(`/api/documents/${second.documentId}`).expect(204);
      expect(existsSync(exportPath(second.documentId, ids[1]!))).toBe(false);
    } finally {
      await exportWorker.close();
    }
  }, 120_000);
});

describe('Document corrigé : reprise sans doublon ni fichier orphelin', () => {
  /** Export demandé sans service d'export démarré, puis retiré de la file : exécution manuelle. */
  async function pendingExport(agent: Agent) {
    const { documentId, analysisId } = await analyzedDocument(agent);
    await addIssue(analysisId, documentId, 'Une phrase', 'fote', {
      status: 'accepted',
      suggestion: 'faute',
    });
    const created = await agent.post(`/api/analyses/${analysisId}/exports`).expect(202);
    const id = created.body.id as string;
    await app.get<Queue>(getQueueToken(EXPORT_QUEUE), { strict: false }).remove(id);
    return { documentId, analysisId, id };
  }

  it('deux exécutions simultanées du même export : un seul export, fichier conservé', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId, id } = await pendingExport(agent);
    const exportWorker = await createTestExportWorker();
    try {
      const runner = exportWorker.get(ExportRunner);
      await Promise.all([runner.run(id), runner.run(id)]);
      const rows = await prisma.export.findMany({ where: { analysisId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'READY', appliedCount: 1 });
      expect(existsSync(exportPath(documentId, id))).toBe(true);
      const file = await download(agent, id).expect(200);
      const text = (await parseDocx(file.body as Buffer)).blocks.map((b) => b.text).join('\n');
      expect(text).toContain('une faute dans le rapport');
    } finally {
      await exportWorker.close();
    }
  }, 120_000);

  it('export abandonné pendant son exécution : son fichier seul est supprimé, pas ceux des autres', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId, id: first } = await pendingExport(agent);
    const exportWorker = await createTestExportWorker();
    try {
      const runner = exportWorker.get(ExportRunner);
      await runner.run(first);
      expect(existsSync(exportPath(documentId, first))).toBe(true);

      // Second export du même document, déclaré en échec (récupération) pendant son calcul.
      const row = await prisma.export.findUniqueOrThrow({ where: { id: first } });
      const second = newId('exp');
      await prisma.export.create({
        data: {
          id: second,
          analysisId,
          documentId,
          edits: row.edits as Prisma.InputJsonValue,
          editsHash: second,
          requestedCount: 1,
          expiresAt: row.expiresAt,
        },
      });
      const child = exportWorker.get(ExportChildRunner);
      const realRun = child.run.bind(child);
      vi.spyOn(child, 'run').mockImplementationOnce(async (...args) => {
        const outcome = await realRun(...args);
        await prisma.export.update({ where: { id: second }, data: { status: 'FAILED' } });
        return outcome;
      });
      await runner.run(second);

      expect(existsSync(exportPath(documentId, second))).toBe(false);
      expect(existsSync(exportPath(documentId, first))).toBe(true);
      await download(agent, first).expect(200);
    } finally {
      await exportWorker.close();
    }
  }, 120_000);

  it('fichier produit sans export publié (arrêt avant READY) : supprimé par la purge et avec le document', async () => {
    const agent = request.agent(app.getHttpServer());
    const { documentId, analysisId } = await analyzedDocument(agent);
    const storage = app.get<FileStorage>(FILE_STORAGE, { strict: false });
    const orphan = async () => {
      const id = newId('exp');
      await prisma.export.create({
        data: {
          id,
          analysisId,
          documentId,
          edits: [],
          editsHash: id,
          requestedCount: 1,
          status: 'FAILED',
          errorCode: 'EXPORT_FAILED',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await storage.put(exportKey(documentId, id), Buffer.from('fichier non publié'));
      return id;
    };

    const expired = await orphan();
    await prisma.export.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await worker.get(CleanupService).run()).exportsDeleted).toBe(1);
    expect(existsSync(exportPath(documentId, expired))).toBe(false);

    // Fichier d'origine déjà purgé (24 h) : la suppression du document emporte l'orphelin.
    const kept = await orphan();
    await storage.delete(sourceKey(documentId));
    await prisma.document.update({
      where: { id: documentId },
      data: { storageKey: null, fileDeletedAt: new Date() },
    });
    await storage.put(exportKey(documentId, kept), Buffer.from('fichier non publié'));
    await agent.delete(`/api/documents/${documentId}`).expect(204);
    expect(existsSync(exportPath(documentId, kept))).toBe(false);
  }, 60_000);
});

describe('Journaux', () => {
  it('aucun texte du document n’apparaît dans les journaux', () => {
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const sentence of SENTENCES) {
      expect(text).not.toContain(sentence);
      for (const word of ['fote', 'erreurr', 'strictement inchangé'])
        expect(text).not.toContain(word);
    }
  });
});
