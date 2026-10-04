import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CleanupService } from '../src/maintenance/cleanup.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { QUOTA_LIMITS } from '../src/security/quota.service.js';
import { RedisThrottlerStorage } from '../src/security/redis-throttler.storage.js';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage.js';
import { buildDocx, filler } from './fixtures/builders.js';
import { createTestApp, resetDatabase } from './helpers.js';
import { TEST_REDIS_URL } from './test-env.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Sécurité', () => {
  let app: INestApplication;
  let redis: Redis;
  let docx: Buffer;

  beforeAll(async () => {
    app = await createTestApp([
      {
        token: QUOTA_LIMITS,
        value: { analysesPerUserPerHour: 1, analysesPerIpPerDay: 1000, uploadsPerIpPerHour: 3 },
      },
    ]);
    redis = new Redis(TEST_REDIS_URL);
    docx = await buildDocx([{ p: filler(80) }]);
  });

  beforeEach(async () => {
    await resetDatabase(app);
    await redis.flushdb();
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  const upload = (
    agent: ReturnType<typeof request.agent>,
    headers: Record<string, string> = {},
  ) => {
    let req = agent.post('/api/documents');
    for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
    return req.attach('file', docx, { filename: 'a.docx', contentType: DOCX_MIME });
  };

  it('ajoute les en-têtes de sécurité et interdit la mise en cache', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('refuse une requête qui modifie des données depuis un autre site (CSRF)', async () => {
    const agent = request.agent(app.getHttpServer());
    const evil = await upload(agent, { Origin: 'https://site-malveillant.example' }).expect(403);
    expect(evil.body.error.code).toBe('FORBIDDEN_ORIGIN');
    await upload(agent, { 'Sec-Fetch-Site': 'cross-site' }).expect(403);
    await upload(agent, {
      Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'same-origin',
    }).expect(201);
  });

  it('limite le nombre d’imports par adresse IP', async () => {
    const agent = request.agent(app.getHttpServer());
    for (let i = 0; i < 3; i++) await upload(agent).expect(201);
    const res = await upload(agent).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('limite le nombre d’analyses par session', async () => {
    const agent = request.agent(app.getHttpServer());
    const first = await upload(agent).expect(201);
    const second = await upload(agent).expect(201);
    await agent.post(`/api/documents/${first.body.id as string}/analyze`).expect(202);
    const res = await agent.post(`/api/documents/${second.body.id as string}/analyze`).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('refuse de nouvelles analyses quand le budget IA du jour est atteint', async () => {
    await redis.set(`wordfix:ai:tokens:${new Date().toISOString().slice(0, 10)}`, '999999999');
    const agent = request.agent(app.getHttpServer());
    const doc = await upload(agent).expect(201);
    const res = await agent.post(`/api/documents/${doc.body.id as string}/analyze`).expect(503);
    expect(res.body.error.code).toBe('AI_BUDGET_EXHAUSTED');
  });

  it('applique le limiteur de requêtes partagé dans Redis', async () => {
    const storage = new RedisThrottlerStorage(redis);
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push(await storage.increment('ip-test', 60_000, 2, 60_000, 'default'));
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, true]);
    expect(results[2]?.timeToBlockExpire).toBeGreaterThan(0);
  });
});

describe('Cycle de vie des documents', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('supprime le fichier après 24 h, puis tout le document après 7 jours', async () => {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([{ p: filler(50) }]);
    const { body } = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'a.docx', contentType: DOCX_MIME })
      .expect(201);
    const id = body.id as string;
    const stored = resolve(process.env.STORAGE_LOCAL_DIR ?? '', `documents/${id}/source.docx`);
    const cleanup = new CleanupService(app.get(PrismaService), app.get<FileStorage>(FILE_STORAGE));

    // Avant 24 h : rien ne bouge.
    await cleanup.run(new Date(Date.now() + 23 * 3600_000));
    expect(existsSync(stored)).toBe(true);

    // Après 24 h : le fichier disparaît, le document reste consultable.
    const day = await cleanup.run(new Date(Date.now() + 25 * 3600_000));
    expect(day.filesDeleted).toBe(1);
    expect(existsSync(stored)).toBe(false);
    const after = await agent.get(`/api/documents/${id}`).expect(200);
    expect(after.body.fileAvailable).toBe(false);
    const relaunch = await agent.post(`/api/documents/${id}/analyze`).expect(410);
    expect(relaunch.body.error.code).toBe('FILE_EXPIRED');

    // Après 7 jours : plus aucune trace.
    const week = await cleanup.run(new Date(Date.now() + 7 * 24 * 3600_000 + 60_000));
    expect(week.documentsDeleted).toBe(1);
    await agent.get(`/api/documents/${id}`).expect(404);
  });
});
