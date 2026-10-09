import { describe, expect, it } from 'vitest';
import { FEMININE_EURE, feminineVariant } from './feminine.js';

/** Formes féminines en « -eure » : jamais corrigées vers le masculin. */
const DICTIONARY = new Set([
  'chercheur',
  'chercheurs',
  'chercheuse',
  'chercheuses',
  'directeur',
  'directrice',
  'vainqueur',
  'honneur',
]);
const known = (word: string) => DICTIONARY.has(word);

describe('Féminins en « -eure »', () => {
  it('féminin régulier connu : forme recommandée (chercheure → chercheuse)', () => {
    expect(feminineVariant('chercheure', known)).toEqual({
      kind: 'variant',
      recommended: 'chercheuse',
      masculine: 'chercheur',
    });
    expect(feminineVariant('chercheures', known)).toMatchObject({ recommended: 'chercheuses' });
    expect(feminineVariant('directeure', known)).toMatchObject({ recommended: 'directrice' });
  });

  it('sans féminin régulier connu : analyse ordinaire (vainqueure, honneure)', () => {
    expect(feminineVariant('vainqueure', known)).toEqual({ kind: 'none' });
    expect(feminineVariant('honneure', known)).toEqual({ kind: 'none' });
    expect(FEMININE_EURE.test('vainqueure')).toBe(true);
  });

  it('mot sans rapport avec un nom en « -eur »', () => {
    expect(feminineVariant('demeure', known)).toEqual({ kind: 'none' });
    expect(feminineVariant('recherche', known)).toEqual({ kind: 'none' });
  });
});
