import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueDto, IssueListDto } from '@wordfix/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGrammalecte } from '../src/engine/language/grammar/grammalecte-client.js';
import { buildDocx } from './fixtures/builders.js';
import { CLEAN_PARAGRAPHS } from './fixtures/prose.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Chaîne complète : fichier Word → extraction → Grammalecte (processus du
 * worker) → GrammarAnalyzer → remarques enregistrées et servies par l'API.
 */
describe('Vérification grammaticale (DOCX → extraction → Grammalecte → remarques)', () => {
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

  async function analyze(paragraphs: string[]): Promise<IssueListDto> {
    const agent = request.agent(app.getHttpServer());
    const docx = await buildDocx([
      { h: 1, text: '1. Introduction' },
      ...paragraphs.map((p) => ({ p })),
    ]);
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
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
    return (await agent.get(`/api/analyses/${analysisId}/issues`).expect(200)).body as IssueListDto;
  }

  const grammarIssues = (list: IssueListDto): IssueDto[] =>
    list.items.filter(
      (issue) =>
        issue.category === 'grammar' && (issue.source === 'rules' || issue.source === 'verify'),
    );

  it('signale les fautes de grammaire à leur place, avec la nature décidée par WordFix', async () => {
    const list = await analyze([
      ...CLEAN_PARAGRAPHS.slice(0, 4),
      'Les serveur sont configurés correctement par l’équipe.',
      'Hier, on terminé le déploiement du réseau.',
      'Kouassi N’Guessan et Ouattara utilisent React, TypeScript, MongoDB, GitHub, Docker et Kubernetes, avec des VLAN, un DHCP et un VPN.',
      'C’est une belle projet pour l’équipe.',
    ]);
    const issues = grammarIssues(list);
    expect(issues.map((i) => [i.original, i.suggestion, i.nature, i.subtype])).toEqual([
      ['serveur', 'serveurs', 'error', 'gender_number'],
      // Plusieurs corrections possibles (termine, terminait, termina) : cas ambigu
      // soumis à l'IA ; le faux fournisseur ne tranche pas → « À vérifier », sans correction.
      ['terminé', null, 'verify', 'conjugation'],
      ['projet', null, 'verify', 'gender_number'],
    ]);
    for (const issue of issues) {
      const block = list.blocks[issue.location.blockId];
      expect(block?.text).toContain(issue.original);
      expect(issue.location.sectionPath).toBe('1. Introduction');
    }
  }, 60_000);

  it('document propre : aucune remarque de grammaire ; Grammalecte reste lancé une seule fois', async () => {
    const list = await analyze(CLEAN_PARAGRAPHS);
    expect(grammarIssues(list)).toEqual([]);
    expect(getGrammalecte().getStats()).toMatchObject({ starts: 1, failures: 0 });
  }, 60_000);
});
