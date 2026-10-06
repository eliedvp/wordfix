import { gzipSync } from 'node:zlib';
import type { Block } from '@wordfix/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';
import { documentCaps } from '../language-engine.js';
import { followsTitleOrInitial, isSentenceStart } from '../text.js';
import { accentedVariant } from './accents.js';
import { getSpellingDictionaries, loadSpellingDictionaries } from './dictionaries.js';
import { parseFrequencies } from './frequency.js';
import { isRectifiedSpelling } from './rectifications.js';

function blockOf(text: string, sentences: [number, number][]): Block {
  return {
    id: 'b',
    kind: 'paragraph',
    part: 'body',
    order: 0,
    sectionId: null,
    text,
    wordCount: 0,
    sentences: sentences.map(([start, end]) => ({ start, end })),
    style: { id: null, name: null },
    page: 1,
    anchor: { xmlPart: 'word/document.xml', paragraphIndex: 0, runs: [] },
  };
}

describe('Calibration du moteur (étape A)', () => {
  beforeAll(() => loadSpellingDictionaries(), 60_000);

  describe('fréquences', () => {
    it('lit la liste « mot<TAB>centibels » en échelle Zipf', () => {
      const frequency = parseFrequencies(gzipSync(Buffer.from("de\t132\naujourd'hui\t300\n")));
      expect(frequency.of('de')).toBeCloseTo(7.68);
      expect(frequency.of('De')).toBeCloseTo(7.68);
      expect(frequency.of('aujourd’hui')).toBeCloseTo(6);
      expect(frequency.of('inconnu')).toBeNull();
    });

    it('la liste installée couvre le vocabulaire courant, pas les fautes du web', () => {
      const { frequency } = getSpellingDictionaries();
      expect(frequency.of('développement')).toBeGreaterThan(4);
      expect(frequency.of('developpement')).toBeNull();
      expect(frequency.of('connaitre')).toBeNull();
    });
  });

  describe('orthographe rectifiée de 1990', () => {
    it('reconnaît les graphies rectifiées à partir de la forme classique', () => {
      const { french } = getSpellingDictionaries();
      for (const word of [
        'connaitre',
        'maitrise',
        'paraitre',
        'entrainement',
        'boite',
        'chaine',
        'évènement',
        'règlementaire',
        'ambigüe',
        'Maitrise',
      ]) {
        expect(isRectifiedSpelling(word, french), word).toBe(true);
      }
    });

    it('refuse les fautes et le passé simple sans circonflexe', () => {
      const { french } = getSpellingDictionaries();
      for (const word of ['mèthode', 'vinmes', 'futes', 'connaitrre', 'probème']) {
        expect(isRectifiedSpelling(word, french), word).toBe(false);
      }
    });
  });

  describe('accents oubliés', () => {
    it('trouve le mot français accentué, une ou deux lettres', () => {
      const { french } = getSpellingDictionaries();
      expect(accentedVariant('evolution', french)).toBe('évolution');
      expect(accentedVariant('premiere', french)).toBe('première');
      expect(accentedVariant('electricite', french)).toBe('électricité');
      expect(accentedVariant('team', french)).toBeNull();
      expect(accentedVariant('déjà', french)).toBeNull();
    });
  });

  describe('noms après un titre ou des initiales', () => {
    it('reconnaît titres, initiales et noms composés', () => {
      const text =
        'Merci à M. Kouassi Yao, Mme Aya Koné, Pr. Assi, J.-P. Brou et Velasio de Paolis.';
      for (const name of ['Kouassi', 'Yao', 'Aya', 'Koné', 'Assi', 'Brou']) {
        expect(followsTitleOrInitial(text, text.indexOf(name)), name).toBe(true);
      }
      expect(followsTitleOrInitial(text, text.indexOf('Merci'))).toBe(false);
      expect(followsTitleOrInitial('Le rapport de Kouassi.', 'Le rapport de '.length)).toBe(false);
    });

    it('le point d’une abréviation n’ouvre pas une nouvelle phrase', () => {
      const text = 'Selon M. Moussavi, tout va bien. Ensuite, la réunion.';
      const block = blockOf(text, [
        [0, 9],
        [9, 33],
        [33, text.length],
      ]);
      expect(isSentenceStart(block, text.indexOf('Moussavi'))).toBe(false);
      expect(isSentenceStart(block, text.indexOf('Ensuite'))).toBe(true);
    });
  });

  describe('plafonds proportionnels', () => {
    it('garde le minimum pour un document court, grandit avec la longueur', () => {
      const short = documentCaps(LANGUAGE_ENGINE_CONFIG, 2_000);
      const long = documentCaps(LANGUAGE_ENGINE_CONFIG, 60_000);
      expect(short).toEqual(LANGUAGE_ENGINE_CONFIG.caps);
      expect(long.misspelling).toBe(300);
      expect(long.grammar).toBe(300);
      expect(long.long_sentence).toBe(30);
    });
  });
});
