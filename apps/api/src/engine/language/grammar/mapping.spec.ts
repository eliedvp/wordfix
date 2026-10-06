import type { Block } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';
import { findProtectedRanges } from '../text.js';
import type { AnalyzerContext } from '../types.js';
import type { GrammalecteError } from './grammalecte-client.js';
import { mapGrammarErrors } from './mapping.js';

/** Tests du filtrage seul, avec des erreurs Grammalecte simulées (sans Python). */

function blockOf(text: string): Block {
  return {
    id: 'b_000001',
    kind: 'paragraph',
    part: 'body',
    order: 0,
    sectionId: null,
    text,
    wordCount: text.split(/\s+/).length,
    sentences: [...text.matchAll(/[^.!?]+[.!?]?\s*/g)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    })),
    style: { id: null, name: null },
    page: 1,
    anchor: { xmlPart: 'word/document.xml', paragraphIndex: 0, runs: [] },
  };
}

function contextOf(text: string): AnalyzerContext {
  return {
    config: LANGUAGE_ENGINE_CONFIG,
    protectedRanges: findProtectedRanges(text),
    hasDroppedInlineContent: false,
    document: { wordCount: 100, wordCounts: new Map(), counters: new Map(), grammar: null },
  };
}

function error(
  text: string,
  fragment: string,
  type: string,
  suggestions: string[],
  ruleId = `g3__${type}_test__b1_a1_1`,
  from = 0,
): GrammalecteError {
  const start = text.indexOf(fragment, from);
  if (start < 0) throw new Error(`fragment absent : ${fragment}`);
  return { start, end: start + fragment.length, ruleId, type, message: 'Message.', suggestions };
}

function map(text: string, errors: GrammalecteError[]) {
  return mapGrammarErrors(blockOf(text), errors, contextOf(text)).map((i) => [
    i.original,
    i.suggestion,
    i.subtype,
    i.confidence,
  ]);
}

describe('Filtrage des erreurs Grammalecte', () => {
  it('ne garde que les types grammaticaux (jamais SPELL, typographie ni style)', () => {
    const text = "L'équipe a installé les serveur : c'est fait.";
    expect(
      map(text, [
        error(text, "L'", 'apos', ['L’']),
        error(text, ' :', 'nbsp', [' :']),
        error(text, 'serveur', 'SPELL', ['serveurs']),
        error(text, 'installé', 'notype', ['installés']),
        error(text, 'fait', 'bs', ['réalisé']),
        error(text, 'serveur', 'gn', ['serveurs']),
      ]),
    ).toEqual([['serveur', 'serveurs', 'gender_number', 'high']]);
  });

  it('écarte une « correction » qui ne change que les apostrophes ou les espaces', () => {
    const text = "Il s'est trompé d'adresse.";
    expect(map(text, [error(text, "s'est", 'conf', ['s’est'])])).toEqual([]);
    expect(map(text, [error(text, "d'adresse", 'conf', ['d’ adresse', 'de l’adresse'])])).toEqual([
      ["d'adresse", 'de l’adresse', 'syntax', 'medium'],
    ]);
  });

  it('ne signale jamais seul un nom propre, un sigle ou un terme technique', () => {
    const text = 'Le projet de Kouassi utilise React, GitHub, des VLAN, IPv6 et un backend.';
    const names = ['Kouassi', 'React', 'GitHub', 'VLAN', 'IPv6', 'backend'];
    expect(
      map(
        text,
        names.map((name) => error(text, name, 'gn', [`${name}s`])),
      ),
    ).toEqual([]);
  });

  it('garde un mot en majuscule en début de phrase', () => {
    const text = 'Belle projet. Le serveur est prêt.';
    expect(map(text, [error(text, 'Belle', 'gn', ['Beau'])])).toEqual([
      ['Belle', 'Beau', 'gender_number', 'high'],
    ]);
  });

  it('sans correction, écarte la remarque si elle touche un nom propre', () => {
    const text = 'Le rapport de Ouattara est validé.';
    expect(map(text, [error(text, 'rapport de Ouattara', 'gn', [])])).toEqual([]);
    expect(map(text, [error(text, 'rapport', 'gn', [])])).toEqual([
      ['rapport', null, 'gender_number', 'low'],
    ]);
  });

  it('ignore les zones protégées (URL, chemins)', () => {
    const text = 'Voir https://exemple.fr/les-serveur pour les détails.';
    expect(map(text, [error(text, 'serveur', 'gn', ['serveurs'])])).toEqual([]);
  });

  it('déduplique : même zone et même problème signalés une seule fois', () => {
    const text = 'Les serveur sont prêts.';
    expect(
      map(text, [
        error(text, 'serveur', 'gn', ['serveurs'], 'g3__gn_les_1m__b3_a1_1'),
        error(text, 'serveur', 'gn', ['serveurs'], 'g3__gn_autre__b1_a1_1'),
      ]),
    ).toEqual([['serveur', 'serveurs', 'gender_number', 'high']]);
  });

  it('regroupe les corrections alternatives d’une même règle et baisse la confiance', () => {
    const text = 'Elle se sont rendu compte du problème.';
    const issues = mapGrammarErrors(
      blockOf(text),
      [
        error(text, 'sont', 'conj', ['est'], 'gv2__conj_elle__b1_a1_1'),
        error(text, 'Elle', 'conj', ['Elles'], 'gv2__conj_elle__b1_a2_1'),
      ],
      contextOf(text),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ original: 'sont', suggestion: 'est', confidence: 'medium' });
    expect(issues[0]?.explanation).toContain('« Elle » → « Elles »');
    expect(issues[0]?.explanation).toContain('À confirmer');
  });

  it('une même règle dans deux phrases différentes donne deux remarques', () => {
    const text = 'Les serveur sont prêts. Les routeur aussi.';
    expect(
      map(text, [
        error(text, 'serveur', 'gn', ['serveurs'], 'g3__gn_les_1m__b3_a1_1'),
        error(text, 'routeur', 'gn', ['routeurs'], 'g3__gn_les_1m__b3_a1_1'),
      ]).map(([original]) => original),
    ).toEqual(['serveur', 'routeur']);
  });

  it('confiance : élevée seulement pour une correction unique d’accord ou de conjugaison', () => {
    const text = 'Il va a Paris. Les serveur répondent. On terminé le test.';
    expect(
      map(text, [
        error(text, 'a', 'conf', ['à'], 'g3__conf_a__b1_a1_1', 5),
        error(text, 'serveur', 'gn', ['serveurs']),
        error(text, 'terminé', 'conj', ['termine', 'terminait']),
      ]),
    ).toEqual([
      ['a', 'à', 'syntax', 'medium'],
      ['serveur', 'serveurs', 'gender_number', 'high'],
      ['terminé', 'termine', 'conjugation', 'medium'],
    ]);
  });

  it('ignore les positions invalides', () => {
    const text = 'Texte court.';
    const bad = { ...error(text, 'court', 'gn', ['courts']), end: 999 };
    expect(map(text, [bad, { ...bad, start: 5, end: 5 }])).toEqual([]);
  });

  it('accord juste après un nom propre, un sigle ou un nombre : jamais une certitude', () => {
    const text = 'Une exposition réalisée par le CNRS intitulée Images du ciel.';
    expect(map(text, [error(text, 'intitulée', 'gn', ['intitulé'])])).toEqual([
      ['intitulée', 'intitulé', 'gender_number', 'medium'],
    ]);
    const digits = 'La version Crown 602 fabriquée par Taito est ancienne.';
    expect(map(digits, [error(digits, 'fabriquée', 'gn', ['fabriquées'])])).toEqual([
      ['fabriquée', 'fabriquées', 'gender_number', 'medium'],
    ]);
  });

  it('un nom propre après un titre (« M. Moussavi ») n’est jamais signalé seul', () => {
    const text = 'Selon M. Moussavi, la situation évolue.';
    const block = blockOf(text);
    expect(block.sentences.length).toBeGreaterThan(1);
    expect(map(text, [error(text, 'Moussavi', 'gn', ['Moussavis'])])).toEqual([]);
  });
});
