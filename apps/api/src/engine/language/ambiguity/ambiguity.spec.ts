import type { DocumentModel } from '@wordfix/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDocx, type FixtureNode } from '../../../../test/fixtures/builders.js';
import { AiError } from '../../../ai/ai-provider.js';
import { FakeAiProvider } from '../../../ai/providers/fake.provider.js';
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
import { AMBIGUITY_SCHEMA_NAME, buildAmbiguityInput, resolveAmbiguities } from './resolve.js';

/**
 * Étape C : l'IA (ici le faux fournisseur, sans réseau) départage uniquement les
 * cas ambigus préparés par le moteur déterministe.
 */
const CONFIG = LANGUAGE_ENGINE_CONFIG.ambiguity;
const engine = new LanguageEngine([new SpellingAnalyzer(), new AccentConfusionAnalyzer()]);
let fake: FakeAiProvider;

async function modelOf(paragraphs: string[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(paragraphs.map((p): FixtureNode => ({ p }))));
}

/** Même enchaînement que l'analyse : règles → cas → budget → IA → remarques avec leur nature. */
async function pipeline(paragraphs: string[], budget = CONFIG.ai) {
  const model = await modelOf(paragraphs);
  const { direct, cases } = collectAmbiguities(engine.analyze(model), model, CONFIG);
  const { batches, overflow } = planBatches(cases, budget);
  const resolved: CandidateIssue[] = [];
  const stats = [];
  for (const batch of batches) {
    const result = await resolveAmbiguities(fake, 'modele-test', batch, CONFIG.ai.maxOutputTokens);
    resolved.push(...result.issues);
    stats.push(result.stats);
  }
  const resolver = new LocationResolver(model);
  const issues = [...direct, ...overflow.flatMap(fallbackIssues), ...resolved].map((candidate) => {
    const result = materialize(candidate, resolver, 'ana_test');
    if (!result.ok) throw new Error(result.reason);
    return { ...result.data, confidence: candidate.confidence };
  });
  return { model, cases, batches, overflow, issues, stats };
}

const summary = (issues: Awaited<ReturnType<typeof pipeline>>['issues']) =>
  issues.map((i) => [i.original, i.suggestion, i.nature, i.source]);
const aiCalls = () => fake.calls.filter((name) => name === AMBIGUITY_SCHEMA_NAME).length;

describe('Cas ambigus départagés par l’IA (étape C)', () => {
  beforeAll(() => loadSpellingDictionaries(), 60_000);
  beforeEach(() => {
    fake = new FakeAiProvider();
  });

  describe('l’IA choisit parmi les candidats du moteur', () => {
    it('« peris » dans « permis de conduire » → permis (Suggestion, jamais Erreur)', async () => {
      const { issues, cases } = await pipeline([
        'Je dispose également du peris de conduire de catégorie B.',
      ]);
      expect(cases[0]?.options.map((o) => o.replacement)).toContain('permis');
      expect(summary(issues)).toEqual([['peris', 'permis', 'suggestion', 'verify']]);
      expect(aiCalls()).toBe(1);
    });

    it('« cadr » dans « dans le cadre de » → cadre', async () => {
      const { issues } = await pipeline(['Dans le cadr de ma formation, j’ai réalisé un stage.']);
      expect(summary(issues)).toEqual([['cadr', 'cadre', 'suggestion', 'verify']]);
    });

    it('« taches » / « tâches » : mot existant, accent oublié selon la phrase', async () => {
      const { issues, cases } = await pipeline([
        'Les taches qui m’ont été confiées étaient variées et formatrices.',
      ]);
      expect(cases.map((c) => [c.kind, c.fallback])).toEqual([['confusion', 'drop']]);
      expect(summary(issues)).toEqual([['taches', 'tâches', 'suggestion', 'verify']]);
    });

    it('faute fortement déformée : « comunikation » → communication', async () => {
      const { issues, cases } = await pipeline(['La comunikation interne doit être renforcée.']);
      expect(cases.map((c) => c.kind)).toEqual(['distorted']);
      expect(summary(issues)).toEqual([['comunikation', 'communication', 'suggestion', 'verify']]);
    });

    it('aucun candidat convenable : « À vérifier », sans correction inventée', async () => {
      const { issues } = await pipeline(['Il a enfin obtenu son peris cette année.']);
      expect(summary(issues)).toEqual([['peris', null, 'verify', 'verify']]);
    });

    it('le mot est juste d’après l’IA (« keep ») : aucune remarque', async () => {
      fake.responses.set(AMBIGUITY_SCHEMA_NAME, {
        decisions: [
          {
            caseId: 'c1',
            decision: 'keep',
            correction: null,
            justification: 'Mot voulu.',
            confidence: 'high',
          },
        ],
      });
      const { issues } = await pipeline(['Il a enfin obtenu son peris cette année.']);
      expect(issues).toEqual([]);
    });
  });

  describe('protections et coûts', () => {
    it('noms propres et termes techniques : aucun cas, aucun appel', async () => {
      const { cases, issues } = await pipeline([
        'Nous avons rencontré Kouassi à Gagnoa, puis M. Ehui à Assinie.',
        'Le script s’exécute chaque nuit grâce à une tâche cron sur le serveur Nginx.',
      ]);
      expect(cases).toEqual([]);
      expect(aiCalls()).toBe(0);
      expect(issues.every((issue) => issue.source === 'rules')).toBe(true);
    });

    it('fautes que le moteur corrige seul avec certitude : aucun appel à l’IA', async () => {
      const { cases, issues } = await pipeline(['Ce systeme est egalement utilisé par l’equipe.']);
      expect(cases).toEqual([]);
      expect(aiCalls()).toBe(0);
      expect(summary(issues)).toEqual([
        ['systeme', 'système', 'error', 'rules'],
        ['egalement', 'également', 'error', 'rules'],
        ['equipe', 'équipe', 'error', 'rules'],
      ]);
    });

    it('n’envoie que le mot, sa phrase et les options (jamais le document)', async () => {
      const { cases } = await pipeline([
        'Premier paragraphe confidentiel sans aucune faute.',
        'Je dispose également du peris de conduire de catégorie B. Une autre phrase suit ici.',
      ]);
      const input = buildAmbiguityInput(cases);
      expect(input).toContain('peris de conduire');
      expect(input).not.toContain('confidentiel');
      expect(input).not.toContain('Une autre phrase');
      expect(cases[0]?.context.length).toBeLessThanOrEqual(CONFIG.ai.maxContextChars + 2);
    });

    it('ne pose jamais deux fois le même cas (paragraphe recopié)', async () => {
      const sentence = 'Je dispose également du peris de conduire de catégorie B.';
      const { cases, issues } = await pipeline([sentence, sentence]);
      expect(cases).toHaveLength(1);
      expect(cases[0]?.duplicates).toHaveLength(1);
      expect(summary(issues)).toEqual([
        ['peris', 'permis', 'suggestion', 'verify'],
        ['peris', 'permis', 'suggestion', 'verify'],
      ]);
    });

    it('budget dépassé : lots plafonnés, les cas restants restent « À vérifier »', async () => {
      const words = ['peris', 'cadr', 'sitme', 'bonr', 'dernr', 'gerr', 'tabe', 'livr'];
      const paragraphs = words.map(
        (word, i) => `Paragraphe ${i} avec le mot ${word} au milieu de la phrase.`,
      );
      const { batches, overflow, issues, cases } = await pipeline(paragraphs, {
        ...CONFIG.ai,
        maxBatches: 1,
        maxCasesPerBatch: 2,
      });
      expect(cases.length).toBeGreaterThan(2);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(overflow.length).toBe(cases.length - 2);
      expect(aiCalls()).toBe(1);
      const overflowWords = new Set(
        overflow.filter((c) => c.fallback === 'verify').map((c) => c.original),
      );
      const remaining = issues.filter((i) => overflowWords.has(i.original));
      expect(remaining.length).toBeGreaterThan(0);
      for (const issue of remaining) {
        expect(issue).toMatchObject({ nature: 'verify', suggestion: null, source: 'rules' });
      }
    });
  });

  describe('robustesse', () => {
    it('réponse IA invalide (correction inventée, cas inconnu) : repli du cas', async () => {
      fake.responses.set(AMBIGUITY_SCHEMA_NAME, {
        decisions: [
          {
            caseId: 'c1',
            decision: 'correct',
            correction: 'pépites',
            justification: 'x',
            confidence: 'high',
          },
          {
            caseId: 'c9',
            decision: 'correct',
            correction: 'cadre',
            justification: 'x',
            confidence: 'high',
          },
        ],
      });
      const { issues, stats } = await pipeline(['Je dispose également du peris de conduire.']);
      expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
      expect(stats[0]).toMatchObject({ invalid: 1, corrected: 0 });
    });

    it('réponse hors schéma : tout le lot garde son repli', async () => {
      fake.responses.set(AMBIGUITY_SCHEMA_NAME, { decisions: 'n’importe quoi' });
      const { issues, stats } = await pipeline(['Je dispose également du peris de conduire.']);
      expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
      expect(stats[0]?.failed).toBe('invalid_output');
    });

    it('API IA indisponible : repli sans IA, aucune erreur propagée', async () => {
      fake.failSchemas.set(AMBIGUITY_SCHEMA_NAME, new AiError('unavailable', 'panne simulée'));
      const { issues, stats } = await pipeline([
        'Je dispose également du peris de conduire.',
        'La comunikation interne doit être renforcée.',
      ]);
      // Mot inconnu à une faute près : « À vérifier » ; mot très déformé : rien sans l'IA.
      expect(summary(issues)).toEqual([['peris', null, 'verify', 'rules']]);
      expect(stats[0]?.failed).toBe('unavailable');
    });

    it('une IA « sûre d’elle » ne produit jamais une Erreur', async () => {
      const { issues } = await pipeline(['Je dispose également du peris de conduire.']);
      expect(issues.every((issue) => issue.nature !== 'error')).toBe(true);
    });
  });
});
