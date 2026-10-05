import type { Block, DocumentModel } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import { buildDocx, filler, type FixtureNode } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../../docx/parser/docx-parser.js';
import { LocationResolver } from '../postprocess/location.js';
import { materialize } from '../postprocess/materialize.js';
import { LANGUAGE_ENGINE_CONFIG } from './config.js';
import { createLanguageEngine } from './language-engine.js';

const engine = createLanguageEngine();

async function modelOf(nodes: FixtureNode[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(nodes));
}

async function analyze(nodes: FixtureNode[]) {
  return engine.analyze(await modelOf(nodes));
}

/** Paragraphe construit à la main, pour contrôler les runs Word et les métadonnées. */
function manualModel(
  text: string,
  runs: { runIndex: number; start: number; end: number }[] = [
    { runIndex: 0, start: 0, end: text.length },
  ],
  equations = 0,
): Pick<DocumentModel, 'blocks' | 'meta'> {
  const block: Block = {
    id: 'b_000001',
    kind: 'paragraph',
    part: 'body',
    order: 0,
    sectionId: null,
    text,
    wordCount: text.split(/\s+/).length,
    sentences: [{ start: 0, end: text.length }],
    style: { id: null, name: null },
    page: 1,
    anchor: { xmlPart: 'word/document.xml', paragraphIndex: 0, runs },
  };
  return {
    blocks: [block],
    meta: {
      wordCount: block.wordCount,
      declaredPages: null,
      estimatedPages: 1,
      pageMethod: 'word_count',
      producer: null,
      headingsInferred: false,
      tableCount: 0,
      skipped: { images: 0, equations, textBoxes: 0 },
    },
  };
}

describe('WordFix Language Engine', () => {
  describe('répétitions', () => {
    it('signale un mot écrit deux fois de suite, avec sa correction', async () => {
      const issues = await analyze([
        { p: 'Cette solution permet permet de gérer les utilisateurs.' },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        rule: 'repeated_word',
        category: 'spelling',
        subtype: 'typo',
        original: 'permet permet',
        suggestion: 'permet',
        confidence: 'high',
        source: 'rules',
      });
    });

    it('ne signale pas deux mots d’une même famille (« permet de permettre »)', async () => {
      expect(await analyze([{ p: 'Il permet de permettre un accès plus simple.' }])).toEqual([]);
    });

    it('ignore les répétitions légitimes et celles séparées par une ponctuation', async () => {
      const issues = await analyze([
        { p: 'Nous nous sommes réunis lundi. Vous vous êtes engagés à répondre.' },
        { p: 'Oui, oui, le projet avance. Le suivi du projet. Projet terminé.' },
        { p: 'Il est peut-être être en retard selon le planning initial.' },
      ]);
      expect(issues).toEqual([]);
    });

    it('reconnaît une répétition séparée par une espace insécable, sans tenir compte de la casse', async () => {
      const issues = await analyze([{ p: 'Le\u00a0le rapport est prêt.' }]);
      expect(issues.map((i) => i.original)).toEqual(['Le\u00a0le']);
    });

    it('n’analyse ni les titres ni les URL', async () => {
      const issues = await analyze([
        { h: 1, text: 'Test test de charge' },
        { p: 'La documentation est sur https://exemple.fr/guide/guide/index.html pour tous.' },
      ]);
      expect(issues).toEqual([]);
    });
  });

  describe('phrases longues', () => {
    it('signale une phrase qui dépasse le seuil, et seulement celle-là', async () => {
      const issues = await analyze([{ p: filler(60) }, { p: filler(45, 2) }]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        rule: 'long_sentence',
        category: 'style',
        subtype: 'too_long',
        confidence: 'medium',
        suggestion: null,
      });
      expect(issues[0]?.explanation).toContain('60 mots');
    });

    it('ignore les énumérations et les phrases faites surtout de chiffres', async () => {
      const enumeration = `Le matériel comprend : ${filler(20)}; ${filler(20, 3)}; ${filler(20, 5)}`;
      const numbers = Array.from({ length: 60 }, (_, i) => String(1990 + i)).join(' ');
      expect(await analyze([{ p: enumeration }, { p: `Années ${numbers}.` }])).toEqual([]);
    });
  });

  describe('typographie', () => {
    it('signale les espaces doubles, l’espace avant la virgule, la ponctuation doublée et la virgule collée', async () => {
      const issues = await analyze([
        { p: 'Un texte  avec deux espaces.' },
        { p: 'Le serveur , installé hier, fonctionne.' },
        { p: 'Le test est terminé,, sans erreur.' },
        { p: 'Les couleurs rouge,vert et bleu sont retenues.' },
      ]);
      expect(issues.map((i) => [i.rule, i.original, i.suggestion])).toEqual([
        ['double_space', '  ', ' '],
        ['space_before_punctuation', 'serveur ,', 'serveur,'],
        ['doubled_punctuation', ',,', ','],
        ['missing_space_after_comma', 'rouge,vert', 'rouge, vert'],
      ]);
    });

    it('ne touche ni aux nombres, ni aux variables, ni au code, ni aux fichiers', async () => {
      const issues = await analyze([
        {
          p: 'Le taux atteint 3,5 % en 2024, soit x,y dans f(a,b). Voir Node.js, le fichier config.json et le dossier src/app, puis l’adresse contact@exemple.fr.',
        },
        { p: 'Il est 10:30 ; le budget est de 1 200 € . Fin…' },
      ]);
      expect(issues).toEqual([]);
    });

    it('ne signale pas l’espace avant la ponctuation si un élément invisible (note, image, champ) la sépare du mot', () => {
      const text = 'Comme le montre la figure , le débit augmente.';
      const comma = text.indexOf(',');
      const continuous = engine.analyze(manualModel(text));
      expect(continuous.map((i) => i.rule)).toEqual(['space_before_punctuation']);

      const withGap = engine.analyze(
        manualModel(text, [
          { runIndex: 0, start: 0, end: comma - 1 },
          { runIndex: 2, start: comma - 1, end: text.length },
        ]),
      );
      expect(withGap).toEqual([]);
      expect(engine.analyze(manualModel(text, undefined, 1))).toEqual([]);
    });
  });

  describe('moteur', () => {
    it('ne renvoie rien pour un document vide ou blanc', () => {
      expect(engine.analyze({ blocks: [], meta: manualModel('').meta })).toEqual([]);
      expect(engine.analyze(manualModel('   '))).toEqual([]);
    });

    it('ne produit aucune remarque sur un texte normal', async () => {
      const issues = await analyze([
        { h: 1, text: '1. Introduction' },
        {
          p: 'Ce rapport présente le stage réalisé au sein de l’entreprise. L’équipe compte douze personnes : six développeurs, trois testeurs et trois chefs de projet.',
        },
        {
          p: 'Nous nous sommes appuyés sur la méthode Scrum ; chaque sprint durait deux semaines.',
        },
        { bullet: 'Analyse des besoins, rédaction des spécifications et validation.' },
        {
          table: [
            ['Indicateur', 'Valeur'],
            ['Disponibilité', '99,9 %'],
          ],
        },
        { p: 'Le budget, estimé à 12 500 €, a été respecté. Est-ce suffisant ? Oui !' },
      ]);
      expect(issues).toEqual([]);
    });

    it('localise les remarques dans le bon paragraphe parmi plusieurs', async () => {
      const model = await modelOf([
        { p: 'Premier paragraphe sans problème.' },
        { p: 'Le le deuxième paragraphe contient une faute.' },
        { p: 'Troisième paragraphe correct.' },
        { p: 'Quatrième paragraphe avec une une faute.' },
      ]);
      const issues = engine.analyze(model);
      const paragraphs = model.blocks.filter((b) => b.kind === 'paragraph');
      expect(issues.map((i) => i.blockId)).toEqual([paragraphs[1]?.id, paragraphs[3]?.id]);
      for (const issue of issues) {
        const block = model.blocks.find((b) => b.id === issue.blockId);
        expect(block?.text.slice(issue.range.start, issue.range.end)).toBe(issue.original);
      }
    });

    it('trouve plusieurs problèmes différents dans un même document', async () => {
      const issues = await analyze([
        { p: 'Cette solution permet permet de gérer les utilisateurs.' },
        { p: filler(60) },
        { p: 'Le serveur , installé hier, fonctionne.' },
      ]);
      expect(issues.map((i) => i.rule)).toEqual([
        'repeated_word',
        'long_sentence',
        'space_before_punctuation',
      ]);
    });

    it('ne signale qu’une fois un même endroit (double espace dans un mot doublé)', async () => {
      const issues = await analyze([{ p: 'Cette solution permet  permet de tout gérer.' }]);
      expect(issues.map((i) => i.rule)).toEqual(['repeated_word']);
    });

    it('applique les plafonds de la configuration', async () => {
      const capped = createLanguageEngine({
        ...LANGUAGE_ENGINE_CONFIG,
        caps: { ...LANGUAGE_ENGINE_CONFIG.caps, repeated_word: 2 },
      });
      const model = await modelOf([{ p: 'Le le chat, la la souris, un un chien, de de plus.' }]);
      expect(capped.analyze(model)).toHaveLength(2);
      expect(engine.analyze(model)).toHaveLength(4);
    });

    it('produit des remarques compatibles avec le pipeline (nature décidée par le backend)', async () => {
      const model = await modelOf([
        { p: 'Cette solution permet permet de gérer les utilisateurs.' },
        { p: filler(60) },
        { p: 'Le serveur , installé hier, fonctionne.' },
      ]);
      const resolver = new LocationResolver(model);
      const natures = engine.analyze(model).map((candidate) => {
        const result = materialize(candidate, resolver, 'ana_test');
        if (!result.ok) throw new Error(result.reason);
        return [result.data.subtype, result.data.nature, result.data.source];
      });
      expect(natures).toEqual([
        ['typo', 'error', 'rules'],
        ['too_long', 'suggestion', 'rules'],
        ['spacing', 'error', 'rules'],
      ]);
    });

    it('traite un document à la limite du MVP (60 000 mots) rapidement', async () => {
      const nodes: FixtureNode[] = Array.from({ length: 2000 }, (_, i) => ({
        p: `${filler(14, i)} ${filler(15, i + 1)}`,
      }));
      const model = await modelOf(nodes);
      const started = performance.now();
      engine.analyze(model);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });
});
