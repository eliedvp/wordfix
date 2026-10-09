import { ThinkingLevel } from '@google/genai';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { AnalysisDto, IssueDto, IssueListDto } from '@wordfix/shared';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER, AiError, type AiProvider } from '../src/ai/ai-provider.js';
import type { FakeAiProvider } from '../src/ai/providers/fake.provider.js';
import { AI_CIRCUIT_BREAKER_THRESHOLD } from '../src/engine/ai-guard.js';
import { GeminiAiProvider } from '../src/ai/providers/gemini.provider.js';
import { RequestRateLimiter } from '../src/ai/rate-limiter.js';
import { AnalysisRunner } from '../src/engine/analysis-runner.js';
import { AnalysisProcessor } from '../src/processors/analysis.processor.js';
import type { AnalysisJobData } from '../src/queue/queue.constants.js';
import { buildDocx, filler } from './fixtures/builders.js';
import { reviewDocumentNodes } from './fixtures/review-document.js';
import { createTestApp, createTestWorker, resetDatabase, waitFor } from './helpers.js';

/**
 * Règle produit : l'IA est un enrichissement facultatif. Son indisponibilité
 * (quota, délai, panne du fournisseur) ne fait jamais échouer une analyse que le
 * moteur déterministe a pu mener ; une vraie erreur du moteur, elle, la fait échouer.
 *
 * Les pannes Gemini sont simulées avec le vrai GeminiAiProvider et un `fetch` qui
 * répond comme l'API Google (aucun appel réseau).
 */

// Panne du moteur déterministe, activable par test (tout le reste du module est réel).
const rulesFailure = vi.hoisted(() => ({ active: false, calls: 0 }));
vi.mock('../src/engine/rules/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/rules/rules.js')>();
  return {
    ...actual,
    runRules: (...args: Parameters<typeof actual.runRules>) => {
      if (rulesFailure.active) {
        rulesFailure.calls++;
        throw new Error('panne simulée du moteur déterministe');
      }
      return actual.runRules(...args);
    },
  };
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Document de test : fautes déterministes (mot doublé, numérotation), faute vue par
// l'IA locale, et un cas ambigu de l'étape C (« peris de conduire »).
const PERIS = 'Je dispose également du peris de conduire de catégorie B.';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Réponse 429 de l'API Gemini (quota par minute ou par jour). */
function gemini429(quotaId: string): Response {
  return json(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota, please check your plan and billing details.',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
      ],
    },
  });
}

function geminiWith(fetchImpl: typeof fetch, timeoutMs = 5_000): GeminiAiProvider {
  return new GeminiAiProvider({
    apiKey: 'cle-de-test',
    timeoutMs,
    maxRetries: 0,
    thinkingLevel: ThinkingLevel.LOW,
    fetch: fetchImpl,
    // Pas d'espacement, attentes instantanées : le test porte sur le repli, pas sur le débit.
    rateLimiter: new RequestRateLimiter({
      requestsPerMinute: null,
      sleep: () => Promise.resolve(),
    }),
  });
}

/** Fournisseur qui échoue toujours (panne générique du fournisseur), en comptant ses appels. */
const alwaysFailing = (error: AiError): AiProvider & { calls: number } => {
  const provider = {
    name: 'en-panne',
    calls: 0,
    generateStructured: () => {
      provider.calls++;
      return Promise.reject(error);
    },
  };
  return provider;
};

/** `fetch` simulé qui compte les requêtes envoyées à Gemini. */
function countingFetch(respond: () => Promise<Response>) {
  const counter = { calls: 0 };
  const fetchImpl = (() => {
    counter.calls++;
    return respond();
  }) as typeof fetch;
  return { counter, fetchImpl };
}

/**
 * Appels IA au plus avec le coupe-circuit : le seuil, plus les appels déjà partis en
 * parallèle quand il se déclenche (AI_CONCURRENCY = 4 par défaut).
 */
const MAX_CALLS_WITH_BREAKER = AI_CIRCUIT_BREAKER_THRESHOLD + 4 - 1;

const deterministic = (list: IssueListDto) =>
  list.items
    .filter((i) => i.source === 'rules')
    .map((i) => `${i.original} → ${i.suggestion ?? '—'} [${i.nature}]`)
    .sort();

describe('IA indisponible : l’analyse se termine avec le moteur déterministe', () => {
  let app: INestApplication;
  let worker: INestApplicationContext | null = null;
  let docx: Buffer;
  /** Remarques déterministes d'une analyse avec l'IA disponible (référence). */
  let baseline: IssueListDto;
  /** Nombre d'appels IA d'une analyse complète avec l'IA disponible. */
  let callsWhenAvailable = 0;
  /** Remarques déterministes de la première analyse sans IA (identiques pour toute panne). */
  let withoutAi: string[] | undefined;

  beforeAll(async () => {
    app = await createTestApp();
    // Sections supplémentaires : assez de morceaux IA pour que le coupe-circuit se voie.
    const extra = Array.from({ length: 8 }, (_, i) => [
      { h: 1 as const, text: `${i + 4}. Partie ${i + 4}` },
      { p: filler(600, 10 + i) },
    ]).flat();
    docx = await buildDocx([...reviewDocumentNodes(), ...extra, { p: PERIS }]);
  });

  beforeEach(async () => {
    await resetDatabase(app);
    rulesFailure.active = false;
    rulesFailure.calls = 0;
  });

  afterAll(async () => {
    await worker?.close();
    await app.close();
  });

  /** Démarre un worker avec le fournisseur IA donné (le faux fournisseur par défaut). */
  async function useWorker(provider?: AiProvider): Promise<INestApplicationContext> {
    await worker?.close();
    worker = await createTestWorker(provider ? [{ token: AI_PROVIDER, value: provider }] : []);
    return worker;
  }

  async function analyze() {
    const agent = request.agent(app.getHttpServer());
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
    const issues = (await agent.get(`/api/analyses/${analysisId}/issues`).expect(200))
      .body as IssueListDto;
    return { agent, analysisId, analysis, issues };
  }

  const peris = (list: IssueListDto): IssueDto | undefined =>
    list.items.find((i) => i.original === 'peris');

  /** Vérifications communes à toute analyse terminée sans IA. */
  function expectDeterministicCompletion(run: Awaited<ReturnType<typeof analyze>>): void {
    expect(run.analysis.status).toBe('COMPLETED');
    expect(run.analysis.errorCode).toBeNull();
    expect(run.analysis.score).not.toBeNull();
    expect(run.analysis.warnings).toContain('AI_CHECKS_SKIPPED');
    // Les vérifications non effectuées sont détaillées : relecture locale comprise, et
    // jamais plus d'éléments sautés que prévus.
    const skipped = run.analysis.skippedAiChecks;
    expect(skipped.map((c) => c.check)).toContain('local');
    expect(skipped.every((c) => c.skipped > 0 && c.skipped <= c.total)).toBe(true);
    expect(run.analysis.warnings).not.toContain('PARTIAL_ANALYSIS');
    // Aucune remarque d'IA, toutes les remarques déterministes conservées.
    expect(run.issues.items.every((i) => i.source === 'rules')).toBe(true);
    // Toutes les remarques déterministes de l'analyse avec IA sont conservées…
    const found = deterministic(run.issues);
    const extras = [...found];
    for (const item of deterministic(baseline)) {
      const index = extras.indexOf(item);
      expect(index, `remarque déterministe perdue : ${item}`).toBeGreaterThanOrEqual(0);
      extras.splice(index, 1);
    }
    // …et les cas ambigus gardent leur forme déterministe initiale (repli de l'étape C),
    // jamais une « Erreur ».
    expect(extras).toContain('peris → — [verify]');
    expect(extras.every((item) => !item.endsWith('[error]'))).toBe(true);
    // Le résultat sans IA est le même quelle que soit la panne (quota, délai, indisponibilité).
    withoutAi ??= found;
    expect(found).toEqual(withoutAi);
    expect(peris(run.issues)).toMatchObject({
      nature: 'verify',
      suggestion: null,
      source: 'rules',
    });
    expect(run.issues.items.some((i) => i.nature === 'error' && i.source !== 'rules')).toBe(false);
  }

  it('a. IA disponible : analyse complète avec l’enrichissement IA', async () => {
    const current = await useWorker();
    const fake = current.get<FakeAiProvider>(AI_PROVIDER);
    fake.calls = [];
    const run = await analyze();
    baseline = run.issues;
    callsWhenAvailable = fake.calls.length;
    // Assez d'appels pour que la limite du coupe-circuit (tests c, d) soit significative.
    expect(callsWhenAvailable).toBeGreaterThan(MAX_CALLS_WITH_BREAKER);
    expect(run.analysis.status).toBe('COMPLETED');
    expect(run.analysis.warnings).not.toContain('AI_CHECKS_SKIPPED');
    expect(run.analysis.skippedAiChecks).toEqual([]);
    expect(run.issues.items.some((i) => i.source === 'local')).toBe(true);
    expect(deterministic(run.issues).length).toBeGreaterThan(0);
    // Cas ambigu tranché par l'IA : Suggestion, jamais Erreur.
    expect(peris(run.issues)).toMatchObject({
      suggestion: 'permis',
      nature: 'suggestion',
      source: 'verify',
    });
  }, 60_000);

  it('b. quota IA épuisé (Gemini 429 quotidien) : COMPLETED, plus aucun appel après le quota', async () => {
    let calls = 0;
    await useWorker(
      geminiWith(() => {
        calls++;
        return Promise.resolve(gemini429('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
      }),
    );
    const run = await analyze();
    expectDeterministicCompletion(run);
    // Seuls les appels déjà lancés en parallèle (AI_CONCURRENCY = 4) partent ; ensuite, aucun.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(4);
  }, 60_000);

  it('c. délai IA dépassé (Gemini) : COMPLETED avec les résultats déterministes', async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as typeof fetch;
    let calls = 0;
    await useWorker(
      geminiWith((url: string | URL | Request, init?: RequestInit) => {
        calls++;
        return hanging(url, init);
      }, 50),
    );
    expectDeterministicCompletion(await analyze());
    // Coupe-circuit : l'analyse n'attend pas un délai dépassé par morceau.
    expect(calls).toBeLessThanOrEqual(MAX_CALLS_WITH_BREAKER);
  }, 60_000);

  it('d. limite gratuite Gemini (429, 5 requêtes/minute) : COMPLETED, coupe-circuit — cas réel signalé', async () => {
    const { counter, fetchImpl } = countingFetch(() =>
      Promise.resolve(gemini429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')),
    );
    await useWorker(geminiWith(fetchImpl));
    expectDeterministicCompletion(await analyze());
    // Sans coupe-circuit, chaque appel IA de l'analyse aurait envoyé sa requête.
    expect(counter.calls).toBeGreaterThanOrEqual(AI_CIRCUIT_BREAKER_THRESHOLD);
    expect(counter.calls).toBeLessThanOrEqual(MAX_CALLS_WITH_BREAKER);
    expect(counter.calls).toBeLessThan(callsWhenAvailable);
  }, 60_000);

  it('d bis. fournisseur IA indisponible (toutes les requêtes en échec) : COMPLETED', async () => {
    const failing = alwaysFailing(new AiError('unavailable', 'fournisseur indisponible (503)'));
    await useWorker(failing);
    expectDeterministicCompletion(await analyze());
    expect(failing.calls).toBeLessThanOrEqual(MAX_CALLS_WITH_BREAKER);
  }, 60_000);

  it('f. requête refusée par Gemini (400 systématique, bug WordFix) : jamais masquée', async () => {
    const { counter, fetchImpl } = countingFetch(() =>
      Promise.resolve(
        json(400, {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Invalid JSON payload received.',
            details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest' }],
          },
        }),
      ),
    );
    await useWorker(geminiWith(fetchImpl));
    const run = await analyze();
    // Ni « IA indisponible » ni coupe-circuit : l'échec est visible comme un vrai bug.
    expect(run.analysis.status).toBe('FAILED');
    expect(run.analysis.errorCode).toBe('ANALYSIS_FAILED');
    // Le coupe-circuit ne s'applique pas : chaque morceau a tenté sa requête.
    expect(counter.calls).toBeGreaterThan(AI_CIRCUIT_BREAKER_THRESHOLD);
  }, 60_000);

  it('e. erreur réelle du moteur déterministe : l’analyse échoue (FAILED)', async () => {
    const current = await useWorker();
    rulesFailure.active = true;
    const agent = request.agent(app.getHttpServer());
    const upload = await agent
      .post('/api/documents')
      .attach('file', docx, { filename: 'Rapport.docx', contentType: DOCX_MIME })
      .expect(201);
    const start = await agent
      .post(`/api/documents/${upload.body.id as string}/analyze`)
      .expect(202);
    const analysisId = start.body.analysisId as string;

    // Premier essai du worker : l'erreur n'est pas masquée, l'analyse ne se termine pas.
    await waitFor(
      () => Promise.resolve(rulesFailure.calls),
      (calls) => calls >= 1,
    );
    const during = (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto;
    expect(during.status).not.toBe('COMPLETED');

    // Chaque essai échoue à nouveau ; après le dernier essai BullMQ, l'analyse est en échec.
    const runner = current.get(AnalysisRunner);
    await expect(runner.run(analysisId)).rejects.toThrow('panne simulée du moteur déterministe');
    const job = {
      data: { analysisId },
      opts: { attempts: 3 },
      attemptsMade: 3,
    } as unknown as Job<AnalysisJobData>;
    await current
      .get(AnalysisProcessor)
      .onFailed(job, new Error('panne simulée du moteur déterministe'));

    const failed = (await agent.get(`/api/analyses/${analysisId}`).expect(200)).body as AnalysisDto;
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('ANALYSIS_FAILED');
  }, 60_000);
});
