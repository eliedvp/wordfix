import type { DocumentModel } from '@wordfix/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDocx, filler, type FixtureNode } from '../../../../test/fixtures/builders.js';
import { parseDocx } from '../../../docx/parser/docx-parser.js';
import { LocationResolver } from '../../postprocess/location.js';
import { materialize } from '../../postprocess/materialize.js';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';
import { createLanguageEngine, LanguageEngine } from '../language-engine.js';
import {
  dictionaryLoadStats,
  getSpellingDictionaries,
  loadSpellingDictionaries,
} from '../spelling/dictionaries.js';
import { assessConfidence, rankCandidates, weightedDistance } from '../spelling/ranking.js';
import { NO_FREQUENCY } from '../spelling/frequency.js';
import { SpellingAnalyzer } from './spelling.analyzer.js';

/**
 * Les fautes testées ici ne sont connues de l'analyseur que par le dictionnaire
 * général : aucune n'est inscrite dans le code.
 */
const engine = createLanguageEngine();
const spellingOnly = new LanguageEngine([new SpellingAnalyzer()]);

async function modelOf(nodes: FixtureNode[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(nodes));
}

async function spelling(...paragraphs: string[]) {
  const model = await modelOf(paragraphs.map((p) => ({ p })));
  return spellingOnly.analyze(model);
}

describe('SpellingAnalyzer (orthographe française)', () => {
  beforeAll(() => loadSpellingDictionaries(), 60_000);

  it('1. ne signale pas un mot correct', async () => {
    expect(await spelling('Le service informatique est ouvert du lundi au vendredi.')).toEqual([]);
  });

  it('2. détecte « Informatiue » et propose « Informatique » (suggestion)', async () => {
    const issues = await spelling('Titulaire d’un BTS en Informatiue, je postule à ce poste.');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule: 'misspelling',
      category: 'spelling',
      subtype: 'misspelling',
      original: 'Informatiue',
      suggestion: 'Informatique',
      confidence: 'medium',
      source: 'rules',
    });
  });

  it('3. « peris » : aucune correction hasardeuse quand les candidats sont trop nombreux', async () => {
    const issues = await spelling('Il a enfin obtenu son peris de conduire cette année.');
    // permis, paris, péris, perdis… sont aussi proches : sans contexte, on ne tranche pas.
    expect(issues.every((issue) => issue.suggestion === 'permis')).toBe(true);
    expect(issues).toEqual([]);
  });

  it('4. ne signale pas les noms propres absents du dictionnaire', async () => {
    expect(
      await spelling('J’ai rencontré Kouassi Yao et Mme Dubreuilh à Abidjan, chez Tchoumba.'),
    ).toEqual([]);
  });

  it('5. ne signale pas les sigles', async () => {
    expect(
      await spelling('Le projet SATI expose une API derrière un VPN, avec DHCP, VLAN et NAT.'),
    ).toEqual([]);
  });

  it('6. ignore les URL', async () => {
    expect(
      await spelling('Voir https://www.exemplle.fr/informatiue/pagge pour le détail.'),
    ).toEqual([]);
  });

  it('7. ignore les adresses e-mail', async () => {
    expect(await spelling('Écrivez à jean.dupnt@entreprse.fr pour toute question.')).toEqual([]);
  });

  it('8. ignore les chemins de fichiers', async () => {
    expect(
      await spelling(
        'Le fichier C:\\Utilisateurs\\Documnts\\rapport.docx et le dossier /usr/locl/bin.',
      ),
    ).toEqual([]);
  });

  it('9. ne signale pas les termes techniques courants', async () => {
    expect(
      await spelling(
        'Le backend en Node.js expose une API RESTful hébergée sur GitHub, avec MongoDB, React, Kubernetes, Docker et un workflow frontend.',
      ),
    ).toEqual([]);
  });

  it('10. respecte la casse du mot d’origine', async () => {
    expect(await spelling('INFORMATIQUE et Informatique sont corrects.')).toEqual([]);
    const issues = await spelling('Infomatique et réseaux. Le service gère l’infomation.');
    expect(issues.map((i) => [i.original, i.suggestion])).toEqual([
      ['Infomatique', 'Informatique'],
      ['infomation', 'information'],
    ]);
  });

  it('11. gère les accents', async () => {
    expect(await spelling('La côte, la Côte et la CÔTE sont bien écrites.')).toEqual([]);
    const issues = await spelling('Ce systeme est egalement utilisé.');
    expect(issues.map((i) => [i.original, i.suggestion, i.confidence])).toEqual([
      ['systeme', 'système', 'high'],
      ['egalement', 'également', 'high'],
    ]);
  });

  it('12. trouve plusieurs fautes dans un même paragraphe, à leur place exacte', async () => {
    const model = await modelOf([
      { p: 'Le developpeur a fait un travail professionel dans un environement difficile.' },
    ]);
    const issues = spellingOnly.analyze(model);
    expect(issues.map((i) => [i.original, i.suggestion])).toEqual([
      ['developpeur', 'développeur'],
      ['professionel', 'professionnel'],
      ['environement', 'environnement'],
    ]);
    const block = model.blocks.find((b) => b.id === issues[0]?.blockId);
    for (const issue of issues) {
      expect(block?.text.slice(issue.range.start, issue.range.end)).toBe(issue.original);
    }
  });

  it('13. ne double pas un signalement d’un autre analyseur', async () => {
    const model = await modelOf([{ p: 'Le developpeur developpeur travaille ici.' }]);
    const issues = engine.analyze(model);
    expect(issues.map((i) => [i.rule, i.original])).toEqual([
      ['repeated_word', 'developpeur developpeur'],
    ]);
  });

  it('14. reste rapide sur un document de 60 000 mots, en trouvant les fautes isolées', async () => {
    const typos = [
      'developpeur',
      'professionel',
      'environement',
      'acceuil',
      'necessaire',
      'systeme',
      'egalement',
      'bientot',
      'gestionaire',
      'fonctionalité',
    ];
    const nodes: FixtureNode[] = Array.from({ length: 2000 }, (_, i) => ({
      p:
        i % 200 === 0
          ? `${filler(14, i)} Un ${typos[i / 200] ?? ''} ${filler(14, i + 1)}`
          : `${filler(14, i)} ${filler(15, i + 1)}`,
    }));
    const model = await modelOf(nodes);
    expect(model.meta.wordCount).toBeGreaterThan(58_000);
    const started = performance.now();
    const issues = spellingOnly.analyze(model);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(issues.map((i) => i.original)).toEqual(typos);
  }, 120_000);

  describe('confiance et garde-fous', () => {
    it('heureus : suggestion « heureux », en citant « heureuse »', async () => {
      const issues = await spelling('Je serais heureus de vous rencontrer.');
      expect(issues[0]).toMatchObject({ suggestion: 'heureux', confidence: 'medium' });
      expect(issues[0]?.explanation).toContain('heureuse');
    });

    it('cadr : trop de candidats proches, aucune correction', async () => {
      expect(await spelling('Dans le cadr de mon stage, je travaille beaucoup.')).toEqual([]);
    });

    it('l’occasions : le mot est bien orthographié (accord à traiter par la grammaire)', async () => {
      expect(await spelling('Je saisis l’occasions de vous écrire.')).toEqual([]);
    });

    it('corrige le mot après une élision, sans toucher à l’article', async () => {
      const issues = await spelling('Je découvre l’infomatique avec plaisir.');
      expect(issues.map((i) => [i.original, i.suggestion])).toEqual([
        ['infomatique', 'informatique'],
      ]);
    });

    it('un mot inconnu répété au moins 3 fois est considéré comme voulu', async () => {
      expect(
        await spelling('Le kouglof est prêt.', 'Un kouglof maison.', 'Encore du kouglof.'),
      ).toEqual([]);
    });

    it('respecte le budget de recherches de suggestions par document', async () => {
      const limited = new LanguageEngine([new SpellingAnalyzer()], {
        ...LANGUAGE_ENGINE_CONFIG,
        spelling: { ...LANGUAGE_ENGINE_CONFIG.spelling, maxSuggestionLookups: 1 },
      });
      const model = await modelOf([{ p: 'Ce systeme est egalement utilisé.' }]);
      expect(limited.analyze(model).map((i) => i.original)).toEqual(['systeme']);
    });

    it('ne propose jamais un nom propre pour un mot en minuscules', async () => {
      expect(await spelling('Le casque helmet est fourni.')).toEqual([]);
    });

    it('produit des remarques compatibles avec le pipeline (Erreur / Suggestion)', async () => {
      const model = await modelOf([
        { p: 'Ce systeme est utilisé.' },
        { p: 'Titulaire d’un BTS en Informatiue.' },
      ]);
      const resolver = new LocationResolver(model);
      const natures = spellingOnly.analyze(model).map((candidate) => {
        const result = materialize(candidate, resolver, 'ana_test');
        if (!result.ok) throw new Error(result.reason);
        return [result.data.original, result.data.nature, result.data.suggestion];
      });
      expect(natures).toEqual([
        ['systeme', 'error', 'système'],
        ['Informatiue', 'suggestion', 'Informatique'],
      ]);
    });
  });

  describe('classement', () => {
    it('pèse les fautes courantes du français', () => {
      expect(weightedDistance('systeme', 'système')).toBeCloseTo(0.3);
      expect(weightedDistance('professionel', 'professionnel')).toBeCloseTo(0.5);
      expect(weightedDistance('recevior', 'recevoir')).toBeCloseTo(0.7);
      expect(weightedDistance('infomation', 'information')).toBeCloseTo(1);
    });

    it('n’accorde aucune confiance si nspell et le classement divergent', () => {
      const ranked = rankCandidates('peris', ['paris', 'péris', 'permis'], NO_FREQUENCY);
      expect(ranked[0]?.word).toBe('péris');
      const verdict = assessConfidence('peris', ranked, 'paris', LANGUAGE_ENGINE_CONFIG.spelling);
      expect(verdict.confidence).toBe('low');
    });
  });

  describe('chargement du dictionnaire', () => {
    it('une seule instance par processus, même pour plusieurs documents', async () => {
      const [a, b] = await Promise.all([loadSpellingDictionaries(), loadSpellingDictionaries()]);
      expect(a).toBe(b);
      expect(getSpellingDictionaries()).toBe(a);
      await spelling('Premier document avec un systeme.');
      await spelling('Deuxième document avec un environement.');
      expect(await loadSpellingDictionaries()).toBe(a);
      expect(dictionaryLoadStats().loads).toBe(1);
    });
  });
});
