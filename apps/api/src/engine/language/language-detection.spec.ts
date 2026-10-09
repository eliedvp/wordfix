import type { DocumentModel } from '@wordfix/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDocx, type FixtureNode } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../../docx/parser/docx-parser.js';
import { LocationResolver } from '../postprocess/location.js';
import { materialize } from '../postprocess/materialize.js';
import type { GrammalecteError } from './grammar/grammalecte-client.js';
import { createLanguageEngine } from './language-engine.js';
import { loadSpellingDictionaries } from './spelling/dictionaries.js';
import type { GrammarFindings } from './types.js';

/**
 * Faux positifs linguistiques (documents multilingues, noms propres, formes
 * féminines) : moteur complet avec les vrais dictionnaires, nature décidée par la
 * politique centrale. Aucune faute ni aucun nom n'est inscrit dans le code.
 */
const engine = createLanguageEngine();

async function modelOf(paragraphs: string[]): Promise<DocumentModel> {
  return parseDocx(await buildDocx(paragraphs.map((p): FixtureNode => ({ p }))));
}

async function analyze(paragraphs: string[], grammar: GrammarFindings | null = null) {
  const model = await modelOf(paragraphs);
  const resolver = new LocationResolver(model);
  return engine.analyze({ blocks: model.blocks, meta: model.meta, grammar }).map((issue) => {
    const result = materialize(issue, resolver, 'ana_test');
    if (!result.ok) throw new Error(result.reason);
    return {
      original: result.data.original,
      suggestion: result.data.suggestion,
      nature: result.data.nature,
      category: result.data.category,
      block: model.blocks.findIndex((block) => block.id === issue.blockId),
    };
  });
}

const spellingOf = (issues: Awaited<ReturnType<typeof analyze>>) =>
  issues.filter((i) => i.category === 'spelling').map((i) => [i.original, i.suggestion, i.nature]);

describe('Langue des passages : orthographe et grammaire adaptées', () => {
  beforeAll(() => loadSpellingDictionaries(), 60_000);

  it('1. paragraphe français avec de vraies fautes : toujours signalées', async () => {
    const issues = await analyze([
      'Le systeme de suivi est egalement utilisé pour la dissemination des résultats et l’evolution des pratiques.',
    ]);
    expect(spellingOf(issues)).toEqual([
      ['systeme', 'système', 'error'],
      ['egalement', 'également', 'error'],
      ['dissemination', 'dissémination', 'suggestion'],
      ['evolution', 'évolution', 'suggestion'],
    ]);
  });

  it('2. paragraphe anglais correct : aucune remarque (américain ou britannique)', async () => {
    const issues = await analyze([
      'The project focuses on the dissemination of research results across European universities and the wider scientific community.',
      'The regulation of financial markets depends on cooperation between federal agencies, and these debates have lasted a decade.',
      'Researchers analysed the behaviour of organisations and summarised their findings in the final programme review.',
    ]);
    expect(issues).toEqual([]);
  });

  it('2 bis. Grammalecte n’est pas appliqué à une phrase anglaise', async () => {
    const english = 'This dissertation examines how organisations evaluate their performance.';
    const french = 'Les serveur sont configurés correctement par l’équipe.';
    const model = await modelOf([english, french]);
    const at = (text: string, fragment: string, suggestions: string[]): GrammalecteError => {
      const start = text.indexOf(fragment);
      return {
        start,
        end: start + fragment.length,
        ruleId: 'g3__conj_test__b1_a1_1',
        type: fragment === 'serveur' ? 'gn' : 'conj',
        message: 'Message.',
        suggestions,
      };
    };
    const grammar: GrammarFindings = new Map([
      [model.blocks[0]?.id ?? '', [at(english, 'examines', ['examine'])]],
      [model.blocks[1]?.id ?? '', [at(french, 'serveur', ['serveurs'])]],
    ]);
    const issues = await analyze([english, french], grammar);
    expect(issues.map((i) => [i.block, i.original, i.suggestion, i.category])).toEqual([
      [1, 'serveur', 'serveurs', 'grammar'],
    ]);
  });

  it('3. document qui alterne français et anglais : chaque passage selon sa langue', async () => {
    const issues = await analyze([
      'Le comité a examiné les résultats de l’enquête et la dissemination des données.',
      'The project focuses on the dissemination of research results across European universities.',
      'Les résultats montrent une amélioration notable du systeme de suivi.',
      'Our analysis relies on interviews conducted with twenty managers between 2021 and 2023.',
      'Abstract',
      'Comme l’écrit Smith, « the integration of new technologies is a long and uneven process », ce qui nuance notre propos.',
    ]);
    expect(issues.map((i) => [i.block, i.original, i.suggestion, i.nature])).toEqual([
      [0, 'dissemination', 'dissémination', 'suggestion'],
      [2, 'systeme', 'système', 'error'],
    ]);
  });

  it('4. villes, établissements et sigles : aucune remarque d’orthographe', async () => {
    const issues = await analyze([
      'Elle a soutenu sa thèse à l’Université de Versailles Saint-Quentin-en-Yvelines en 2021.',
      'Il a étudié à l’Institut Supérieur de Gestion avant de rejoindre l’Institut Supérieur du Commerce.',
      'Les entretiens ont été menés à Abidjan, Gagnoa, Assinie et Grand-Bassam entre janvier et mars.',
      'Le CNRS, l’INSERM, l’UVSQ et l’Université Paris-Saclay ont cofinancé ce programme.',
      'Selon M. Kouassi et Mme N’Guessan, la coopération avec l’OMS s’est renforcée.',
    ]);
    expect(spellingOf(issues)).toEqual([]);
  });

  it('4 bis. sans masquer les vraies fautes dans un nom en majuscule', async () => {
    const issues = await analyze([
      'Elle a été diplômée de l’Institut Superieur de Technologie.',
      'Titulaire d’un BTS en Informatiue, je postule au poste de technicien support.',
    ]);
    expect(spellingOf(issues)).toEqual([
      ['Superieur', 'Supérieur', 'suggestion'],
      ['Informatiue', 'Informatique', 'suggestion'],
    ]);
  });

  it('5. formes féminines légitimes : aucune remarque ; « chercheure » → féminin, jamais masculin', async () => {
    const legitimate = await analyze([
      'Elle est professeure associée et autrice de plusieurs ouvrages de référence.',
      'La docteure et l’ingénieure ont présenté leurs travaux devant la procureure.',
    ]);
    expect(legitimate).toEqual([]);
    const variants = await analyze([
      'Elle est chercheure en sociologie au CNRS.',
      'Plusieurs chercheures ont contribué à cet ouvrage collectif.',
    ]);
    expect(spellingOf(variants)).toEqual([
      ['chercheure', 'chercheuse', 'suggestion'],
      ['chercheures', 'chercheuses', 'suggestion'],
    ]);
  });

  it('6. fautes anglaises évidentes : suggestion (jamais Erreur) ; correction incertaine : rien', async () => {
    const issues = await analyze([
      'Each group was placed in a seperate room during the experiment.',
      'The working enviroment has a direct effect on employee satisfaction.',
      'The main incident occured during the second phase of the project.',
      'The participants recieved a questionnaire before the interview.',
    ]);
    expect(spellingOf(issues)).toEqual([
      ['seperate', 'separate', 'suggestion'],
      ['enviroment', 'environment', 'suggestion'],
      ['occured', 'occurred', 'suggestion'],
      // « received » ou « relieved » : deux corrections à une lettre près, aucune proposée.
    ]);
  });

  it('7. noms propres anglais et sigles : la phrase reste française, ses fautes restent des Erreurs', async () => {
    const issues = await analyze([
      'La compagnie, officiellemnt Ethiopian Airlines (code AITA : ET), dessert Addis-Abeba.',
      'On retiendra plus particulierement The Cranberries et The Corrs parmi les groupes invités.',
    ]);
    expect(spellingOf(issues)).toEqual([
      ['officiellemnt', 'officiellement', 'error'],
      ['particulierement', 'particulièrement', 'error'],
    ]);
  });

  it('7 bis. mots sans accent proches de l’anglais dans une phrase française : Erreur maintenue', async () => {
    const issues = await analyze([
      'La resolution du problème a pris plusieurs semaines.',
      'Ce phénomène recurrent inquiète les riverains.',
      'La décoration interieure a été entièrement refaite.',
    ]);
    expect(spellingOf(issues)).toEqual([
      ['resolution', 'résolution', 'error'],
      ['recurrent', 'récurrent', 'error'],
      ['interieure', 'intérieure', 'error'],
    ]);
  });

  it('confusion d’accents : jamais dans une phrase anglaise', async () => {
    const french = await analyze(['Les taches qui m’ont été confiées étaient variées.']);
    expect(french.map((i) => i.original)).toContain('taches');
    const english = await analyze([
      'The patients described the taches on their skin during the interview.',
    ]);
    expect(english).toEqual([]);
  });
});
