import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('indique que PostgreSQL et Redis sont disponibles', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'wordfix-api',
      dependencies: { database: 'up', redis: 'up' },
    });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('renvoie le format d’erreur unique pour une route inconnue', async () => {
    const res = await request(app.getHttpServer()).get('/api/inexistant').expect(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String), requestId: expect.any(String) },
    });
  });
});
