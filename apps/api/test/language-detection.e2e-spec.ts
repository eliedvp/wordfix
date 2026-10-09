import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDocx } from './fixtures/builders.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Chaîne complète sur un document bilingue : fichier Word → extraction →
 * Grammalecte (vrai processus du worker) → moteur de langue → remarques servies par
 * l'API. Les passages anglais ne reçoivent aucune remarque d'orthographe ou de
 * grammaire française ; les fautes françaises restent signalées.
 */
describe('Document bilingue (DOCX → Grammalecte → moteur de langue → API)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await createTestWorker();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  it('aucune remarque de langue sur l’anglais, fautes françaises conservées', async () => {
    const english = [
      'The project focuses on the dissemination of research results across European universities and the wider scientific community.',
      'This dissertation examines how organisations evaluate their performance, and the methodology relies on qualitative interviews.',
    ];
    const french = [
      'Le systeme de suivi permet de mesurer la dissemination des résultats auprès des partenaires.',
      'Elle a soutenu sa thèse à l’Université de Versailles Saint-Quentin-en-Yvelines, où elle est chercheure.',
    ];
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([
      { h: 1, text: '1. Introduction' },
      { p: french[0] ?? '' },
      { h: 2, text: 'Abstract' },
      ...english.map((p) => ({ p })),
      { p: french[1] ?? '' },
    ]);
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'These.docx', contentType: DOCX_MIME })
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

    const language = list.items.filter(
      (issue) =>
        issue.source === 'rules' && (issue.category === 'spelling' || issue.category === 'grammar'),
    );
    const blockText = (id: string) => list.blocks[id]?.text ?? '';
    // Rien sur les paragraphes anglais (orthographe française, Grammalecte, accents).
    expect(language.filter((issue) => english.includes(blockText(issue.location.blockId)))).toEqual(
      [],
    );
    // Les fautes françaises restent signalées ; le féminin n'est jamais corrigé au masculin.
    expect(language.map((i) => [i.original, i.suggestion, i.nature])).toEqual(
      expect.arrayContaining([
        ['systeme', 'système', 'error'],
        ['dissemination', 'dissémination', 'suggestion'],
        ['chercheure', 'chercheuse', 'suggestion'],
      ]),
    );
    expect(language.some((i) => i.original.includes('Yvelines'))).toBe(false);
    expect(language.every((i) => i.suggestion !== 'chercheurs')).toBe(true);
  }, 60_000);
});
