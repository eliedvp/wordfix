import type { DocumentModel } from '@wordfix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocx, type FixtureNode } from '../../../../test/fixtures/builders.js';
import { CLEAN_PARAGRAPHS } from '../../../../test/fixtures/prose.js';
import { parseDocx } from '../../../docx/parser/docx-parser.js';
import { LocationResolver } from '../../postprocess/location.js';
import { materialize } from '../../postprocess/materialize.js';
import { checkDocumentGrammar } from '../grammar/check-document.js';
import { GrammalecteClient } from '../grammar/grammalecte-client.js';
import { createLanguageEngine, LanguageEngine } from '../language-engine.js';
import { loadSpellingDictionaries } from '../spelling/dictionaries.js';
import { GrammarAnalyzer } from './grammar.analyzer.js';

/**
 * Tests avec le vrai Grammalecte (processus Python lancé une fois pour le fichier).
 * Aucune faute n'est connue du code : tout vient des règles de Grammalecte.
 */
const client = new GrammalecteClient();
const grammarOnly = new LanguageEngine([new GrammarAnalyzer()]);

async function modelOf(nodes: FixtureNode[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(nodes));
}

async function analyzeModel(model: DocumentModel, engine: LanguageEngine = grammarOnly) {
  const grammar = await checkDocumentGrammar(client, model);
  return engine.analyze({ blocks: model.blocks, meta: model.meta, grammar });
}

async function grammar(...paragraphs: string[]) {
  return analyzeModel(await modelOf(paragraphs.map((p) => ({ p }))));
}

const summary = (issues: Awaited<ReturnType<typeof grammar>>) =>
  issues.map((i) => [i.original, i.suggestion, i.subtype, i.confidence]);

describe('GrammarAnalyzer (Grammalecte)', () => {
  beforeAll(async () => {
    await Promise.all([client.start(), loadSpellingDictionaries()]);
  }, 60_000);
  afterAll(() => client.stop());

  describe('fautes détectées', () => {
    it('« Les serveur » : accord en nombre, correction sûre (Erreur)', async () => {
      const issues = await grammar('Les serveur sont configurés correctement.');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        rule: 'grammar',
        category: 'grammar',
        subtype: 'gender_number',
        original: 'serveur',
        suggestion: 'serveurs',
        confidence: 'high',
        severity: 'major',
        source: 'rules',
      });
    });

    it('« on terminé » : conjugaison, plusieurs corrections possibles (Suggestion)', async () => {
      const issues = await grammar('Hier, on terminé le déploiement du réseau.');
      expect(summary(issues)).toEqual([['terminé', 'termine', 'conjugation', 'medium']]);
      expect(issues[0]?.explanation).toContain('« terminait »');
    });

    it('a / à : confusion signalée dans les deux sens, jamais comme une certitude', async () => {
      expect(summary(await grammar('Il va a Paris demain pour la réunion.'))).toEqual([
        ['a', 'à', 'syntax', 'medium'],
      ]);
      expect(summary(await grammar('Le serveur est à jour et il à répondu.'))).toEqual([
        ['à', 'a', 'syntax', 'medium'],
      ]);
    });

    it('« belle projet » : désaccord en genre sans correction sûre (À vérifier)', async () => {
      const issues = await grammar('C’est une belle projet pour l’équipe.');
      expect(summary(issues)).toEqual([['projet', null, 'gender_number', 'low']]);
    });

    it('participes passés et infinitifs', async () => {
      expect(summary(await grammar('Nous avons installer le logiciel hier.'))).toEqual([
        ['installer', 'installé', 'agreement', 'high'],
      ]);
      expect(summary(await grammar('Les données sont stocké sur le serveur.'))).toEqual([
        // « sont » est un homophone (son/sont) : la correction reste une suggestion.
        ['stocké', 'stockées', 'agreement', 'medium'],
      ]);
    });

    it('accord sujet-verbe', async () => {
      expect(summary(await grammar('Ces règles s’applique à tous les utilisateurs.'))).toEqual([
        ['applique', 'appliquent', 'conjugation', 'high'],
      ]);
      expect(summary(await grammar('Il faut que tu vienne demain.'))).toEqual([
        ['vienne', 'viennes', 'conjugation', 'high'],
      ]);
    });

    it('« Ils a » : corrections alternatives d’une même règle regroupées en une remarque', async () => {
      const issues = await grammar('Ils a validé la configuration du serveur.');
      expect(summary(issues)).toEqual([['a', 'ont', 'conjugation', 'medium']]);
      expect(issues[0]?.explanation).toContain('« Ils » → « Il »');
    });

    it('homophone en cause (« son satisfaisants ») : suggestion seulement', async () => {
      const issues = await grammar('Les résultats obtenus son satisfaisants.');
      expect(issues.map((i) => i.confidence)).toEqual(['medium']);
    });

    it('trouve plusieurs fautes d’un paragraphe, à leur position exacte (y compris après un emoji)', async () => {
      const model = await modelOf([
        {
          p: 'Les données 😀 sont prêtes, mais les serveur ne répondent pas. Nous avons installer le correctif.',
        },
      ]);
      const issues = await analyzeModel(model);
      expect(issues.map((i) => i.original)).toEqual(['serveur', 'installer']);
      const block = model.blocks.find((b) => b.id === issues[0]?.blockId);
      for (const issue of issues) {
        expect(block?.text.slice(issue.range.start, issue.range.end)).toBe(issue.original);
      }
    });
  });

  describe('aucun faux positif', () => {
    it('noms propres et termes techniques', async () => {
      const issues = await grammar(
        'Kouassi, Guessan et Ouattara travaillent ensemble. J’ai rencontré Kouassi N’Guessan et M. Ouattara à Abidjan.',
        'Les API REST et RESTful exposées par le backend React et TypeScript tournent sous Docker et Kubernetes, avec GitHub, MongoDB, des VLAN, un serveur DHCP et un VPN.',
        'REST est simple. React et TypeScript sont utilisés. MongoDB stocke les données. GitHub héberge le code.',
        'Docker et Kubernetes sont déployés. VLAN et DHCP sont configurés. VPN obligatoire pour les accès distants.',
        'Kouassi a présenté le projet. Guessan l’a validé. Ouattara est d’accord.',
      );
      expect(issues).toEqual([]);
    });

    it('les apostrophes droites et les espaces avant « : » ne sont jamais des fautes de grammaire', async () => {
      expect(
        await grammar(
          "L'équipe s'est réunie : c'est l'heure ; d'accord, on y va. Qu'en pensez-vous ?",
        ),
      ).toEqual([]);
    });

    it('document propre : aucune remarque, avec tout le moteur de langue', async () => {
      const model = await modelOf([
        { h: 1, text: '1. Introduction' },
        ...CLEAN_PARAGRAPHS.map((p) => ({ p })),
        { bullet: 'Analyse des besoins, rédaction des spécifications et validation.' },
        { p: 'Le budget, estimé à 12 500 €, a été respecté. Est-ce suffisant ? Oui !' },
      ]);
      expect(await analyzeModel(model, createLanguageEngine())).toEqual([]);
    });

    it('ignore les URL, adresses e-mail et chemins', async () => {
      expect(
        await grammar(
          'Voir https://exemple.fr/les-serveur/index.html et le fichier /srv/les_serveur.',
        ),
      ).toEqual([]);
    });
  });

  describe('pipeline', () => {
    it('produit des remarques compatibles (nature décidée par la politique centrale)', async () => {
      const model = await modelOf([
        { p: 'Les serveur sont configurés correctement.' },
        { p: 'Hier, on terminé le déploiement du réseau.' },
        { p: 'C’est une belle projet pour l’équipe.' },
      ]);
      const resolver = new LocationResolver(model);
      const natures = (await analyzeModel(model)).map((candidate) => {
        const result = materialize(candidate, resolver, 'ana_test');
        if (!result.ok) throw new Error(result.reason);
        return [result.data.original, result.data.nature, result.data.category];
      });
      expect(natures).toEqual([
        ['serveur', 'error', 'grammar'],
        ['terminé', 'suggestion', 'grammar'],
        ['projet', 'verify', 'grammar'],
      ]);
    });

    it('ne double pas une faute d’orthographe déjà signalée au même endroit', async () => {
      const model = await modelOf([{ p: 'Les developpeur travaillent ici.' }]);
      const issues = await analyzeModel(model, createLanguageEngine());
      expect(issues).toHaveLength(1);
    });

    it('sans vérification grammaticale (moteur indisponible), ne renvoie rien', async () => {
      const model = await modelOf([{ p: 'Les serveur sont configurés.' }]);
      expect(grammarOnly.analyze(model)).toEqual([]);
      expect(grammarOnly.analyze({ ...model, grammar: null })).toEqual([]);
    });

    it('reste rapide sur 60 000 mots, avec un seul processus, en trouvant les fautes isolées', async () => {
      const injected = [
        'Les serveur sont configurés correctement.',
        'Nous avons installer le logiciel hier.',
        'Ces règles s’applique à tous les utilisateurs.',
      ];
      const nodes: FixtureNode[] = Array.from({ length: 1500 }, (_, i) => ({
        p:
          i % 500 === 7
            ? `${CLEAN_PARAGRAPHS[i % CLEAN_PARAGRAPHS.length] ?? ''} ${injected[Math.floor(i / 500)] ?? ''}`
            : (CLEAN_PARAGRAPHS[i % CLEAN_PARAGRAPHS.length] ?? ''),
      }));
      const model = await modelOf(nodes);
      expect(model.meta.wordCount).toBeGreaterThan(59_000);
      const before = client.getStats();
      const started = performance.now();
      const issues = await analyzeModel(model);
      const elapsed = performance.now() - started;
      expect(issues.map((i) => i.original)).toEqual(['serveur', 'installer', 'applique']);
      const after = client.getStats();
      expect(after.starts).toBe(1);
      // Lots de plusieurs paragraphes : une dizaine de requêtes, jamais une par phrase.
      expect(after.requests - before.requests).toBeLessThan(15);
      expect(elapsed).toBeLessThan(90_000);
    }, 180_000);
  });
});
