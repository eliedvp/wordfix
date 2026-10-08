import { ThinkingLevel } from '@google/genai';
import type { DocumentModel } from '@wordfix/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDocx, type FixtureNode } from '../../../../test/fixtures/builders.js';
import { GeminiAiProvider } from '../../../ai/providers/gemini.provider.js';
import { parseDocx } from '../../../docx/parser/docx-parser.js';
import { LocationResolver } from '../../postprocess/location.js';
import { materialize } from '../../postprocess/materialize.js';
import type { CandidateIssue } from '../../types.js';
import { AccentConfusionAnalyzer } from '../analyzers/accent-confusion.analyzer.js';
import { SpellingAnalyzer } from '../analyzers/spelling.analyzer.js';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';
import { LanguageEngine } from '../language-engine.js';
import { loadSpellingDictionaries } from '../spelling/dictionaries.js';
import { collectAmbiguities, fallbackIssues, planBatches } from './cases.js';
import { resolveAmbiguities } from './resolve.js';

/**
 * Étape C avec GeminiAiProvider (SDK réel, `fetch` simulé : aucun appel réseau).
 * Les règles de sécurité sont celles du moteur, identiques pour tous les fournisseurs :
 * correction obligatoirement parmi les options, jamais d'« Erreur », repli sans IA.
 */
const CONFIG = LANGUAGE_ENGINE_CONFIG.ambiguity;
const engine = new LanguageEngine([new SpellingAnalyzer(), new AccentConfusionAnalyzer()]);

type Decision = {
  caseId: string;
  decision: 'correct' | 'keep' | 'verify';
  correction: string | null;
  justification: string;
  confidence: 'high' | 'medium' | 'low';
};

function geminiAnswering(answer: Response | ((input: string) => Decision[])) {
  const sent: string[] = [];
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      contents: { parts: { text: string }[] }[];
    };
    const input = body.contents[0]!.parts[0]!.text;
    sent.push(input);
    if (answer instanceof Response) return Promise.resolve(answer.clone());
    const text = JSON.stringify({ decisions: answer(input) });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  const ai = new GeminiAiProvider({
    apiKey: 'cle-de-test',
    timeoutMs: 5000,
    maxRetries: 0,
    thinkingLevel: ThinkingLevel.LOW,
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { ai, sent };
}

async function modelOf(paragraphs: string[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(paragraphs.map((p): FixtureNode => ({ p }))));
}

async function pipeline(ai: GeminiAiProvider, paragraphs: string[]) {
  const model = await modelOf(paragraphs);
  const { direct, cases } = collectAmbiguities(engine.analyze(model), model, CONFIG);
  const { batches, overflow } = planBatches(cases, CONFIG.ai);
  const resolved: CandidateIssue[] = [];
  const stats = [];
  for (const batch of batches) {
    const result = await resolveAmbiguities(ai, 'gemini-test', batch, CONFIG.ai.maxOutputTokens);
    resolved.push(...result.issues);
    stats.push(result.stats);
  }
  const resolver = new LocationResolver(model);
  const issues = [...direct, ...overflow.flatMap(fallbackIssues), ...resolved].map((candidate) => {
    const result = materialize(candidate, resolver, 'ana_test');
    if (!result.ok) throw new Error(result.reason);
    return { ...result.data, confidence: candidate.confidence };
  });
  return { cases, issues, stats };
}

const summary = (issues: Awaited<ReturnType<typeof pipeline>>['issues']) =>
  issues.map((i) => [i.original, i.suggestion, i.nature, i.source]);
const PERIS = 'Je dispose également du peris de conduire de catégorie B.';

describe('Étape C avec Gemini (réponses simulées)', () => {
  beforeAll(() => loadSpellingDictionaries(), 60_000);

  it('choix parmi les options, « sûr de lui » : Suggestion de confiance moyenne, jamais Erreur', async () => {
    const { ai, sent } = geminiAnswering(() => [
      {
        caseId: 'c1',
        decision: 'correct',
        correction: 'permis',
        justification: 'Permis de conduire.',
        confidence: 'high',
      },
    ]);
    const { issues } = await pipeline(ai, [PERIS]);
    expect(summary(issues)).toEqual([['peris', 'permis', 'suggestion', 'verify']]);
    expect(issues[0]?.confidence).toBe('medium');
    expect(issues.every((i) => i.nature !== 'error')).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('correction hors des options (inventée) : refusée, le cas garde son repli', async () => {
    const { ai } = geminiAnswering(() => [
      {
        caseId: 'c1',
        decision: 'correct',
        correction: 'pépites',
        justification: 'x',
        confidence: 'high',
      },
    ]);
    const { issues, stats } = await pipeline(ai, [PERIS]);
    expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
    expect(stats[0]).toMatchObject({ invalid: 1, corrected: 0 });
  });

  it('cas inconnu ou en double : seule la première décision valide d’un cas connu compte', async () => {
    const { ai } = geminiAnswering(() => [
      {
        caseId: 'c9',
        decision: 'correct',
        correction: 'cadre',
        justification: 'x',
        confidence: 'high',
      },
      {
        caseId: 'c1',
        decision: 'verify',
        correction: null,
        justification: 'Doute.',
        confidence: 'low',
      },
      {
        caseId: 'c1',
        decision: 'correct',
        correction: 'permis',
        justification: 'x',
        confidence: 'high',
      },
    ]);
    const { issues } = await pipeline(ai, [PERIS]);
    expect(summary(issues)).toEqual([['peris', null, 'verify', 'verify']]);
  });

  it('cas sûrs (fautes certaines, noms, termes techniques) : aucun appel à Gemini', async () => {
    const { ai, sent } = geminiAnswering(() => []);
    const { cases, issues } = await pipeline(ai, [
      'Ce systeme est egalement utilisé par l’equipe.',
      'Kouassi utilise Docker et une tâche cron sur le serveur Nginx.',
    ]);
    expect(cases).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(issues.every((i) => i.source === 'rules')).toBe(true);
  });

  it('seule la phrase du mot est envoyée, jamais le document', async () => {
    const { ai, sent } = geminiAnswering(() => []);
    await pipeline(ai, ['Premier paragraphe confidentiel sans aucune faute.', PERIS]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('peris de conduire');
    expect(sent[0]).not.toContain('confidentiel');
  });

  it('quota Gemini épuisé : repli sans IA, aucune erreur propagée', async () => {
    const quota = new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'You exceeded your current quota.',
          details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }],
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
    const { ai } = geminiAnswering(quota);
    const { issues, stats } = await pipeline(ai, [PERIS]);
    expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
    expect(stats[0]?.failed).toBe('quota');
  });

  it('réponse hors schéma : tout le lot garde son repli', async () => {
    const bad = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: '{"decisions":"n’importe quoi"}' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const { ai } = geminiAnswering(bad);
    const { issues, stats } = await pipeline(ai, [PERIS]);
    expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
    expect(stats[0]?.failed).toBe('invalid_output');
  });
});
