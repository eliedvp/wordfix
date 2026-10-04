import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDocx, buildFakePdf, filler } from './fixtures/builders.js';
import { createTestApp, resetDatabase } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Documents (import, historique, suppression)', () => {
  let app: INestApplication;
  let docx: Buffer;

  beforeAll(async () => {
    app = await createTestApp();
    docx = await buildDocx([{ h: 1, text: 'Introduction' }, { p: filler(300) }]);
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const upload = (agent: ReturnType<typeof request.agent>, buffer: Buffer, name: string) =>
    agent.post('/api/documents').attach('file', buffer, { filename: name, contentType: DOCX_MIME });

  it('importe un .docx, crée une session et renvoie les statistiques', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await upload(agent, docx, 'Rapport de stage é.docx').expect(201);

    expect(res.body).toMatchObject({
      originalName: 'Rapport de stage é.docx',
      wordCount: 301,
      fileAvailable: true,
      latestAnalysis: null,
    });
    expect(res.body.id).toMatch(/^doc_[0-9a-z]{20}$/);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/wf_sid=[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const stored = resolve(
      process.env.STORAGE_LOCAL_DIR ?? '',
      `documents/${res.body.id as string}/source.docx`,
    );
    expect(existsSync(stored)).toBe(true);

    const list = await agent.get('/api/documents').expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('refuse un faux .docx avec un message clair, sans rien stocker', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await upload(agent, buildFakePdf(), 'faux.docx').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuse un fichier de plus de 20 Mo pendant l’envoi', async () => {
    const agent = request.agent(app.getHttpServer());
    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    const res = await upload(agent, big, 'gros.docx');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('signale l’absence de fichier', async () => {
    const res = await request(app.getHttpServer()).post('/api/documents').expect(400);
    expect(res.body.error.code).toBe('FILE_MISSING');
  });

  it('isole les documents : une autre session reçoit 404', async () => {
    const owner = request.agent(app.getHttpServer());
    const { body } = await upload(owner, docx, 'a.docx').expect(201);

    const other = request.agent(app.getHttpServer());
    await upload(other, docx, 'b.docx').expect(201);

    await other.get(`/api/documents/${body.id as string}`).expect(404);
    await other.delete(`/api/documents/${body.id as string}`).expect(404);
    const otherList = await other.get('/api/documents').expect(200);
    expect(otherList.body.map((d: { originalName: string }) => d.originalName)).toEqual(['b.docx']);

    // Sans cookie : rien n'est visible.
    await request(app.getHttpServer())
      .get(`/api/documents/${body.id as string}`)
      .expect(404);
    const anonymous = await request(app.getHttpServer()).get('/api/documents').expect(200);
    expect(anonymous.body).toEqual([]);
  });

  it('répond 404 à un identifiant mal formé', async () => {
    const agent = request.agent(app.getHttpServer());
    await upload(agent, docx, 'a.docx').expect(201);
    await agent.get('/api/documents/..%2F..%2Fetc').expect(404);
    await agent.get('/api/documents/doc_INVALID').expect(404);
  });

  it('supprime définitivement le document et son fichier', async () => {
    const agent = request.agent(app.getHttpServer());
    const { body } = await upload(agent, docx, 'a.docx').expect(201);
    const stored = resolve(
      process.env.STORAGE_LOCAL_DIR ?? '',
      `documents/${body.id as string}/source.docx`,
    );
    expect(existsSync(stored)).toBe(true);

    await agent.delete(`/api/documents/${body.id as string}`).expect(204);
    expect(existsSync(stored)).toBe(false);
    await agent.get(`/api/documents/${body.id as string}`).expect(404);
  });
});
