import { describe, expect, it } from 'vitest';
import {
  americanVariants,
  EnglishWordList,
  englishCorrections,
  parseAffixes,
  parseDicStems,
} from './english-words.js';

/** Lecture des affixes Hunspell et corrections anglaises, sur un mini-dictionnaire. */
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const AFF = bytes(
  [
    'PFX A Y 1',
    'PFX A   0     re         .',
    'PFX K Y 1',
    'PFX K   0     pro        .',
    'SFX D Y 2',
    'SFX D   0     d          e',
    'SFX D   0     ed         [^ey]',
    'SFX S Y 2',
    'SFX S   0     s          [^sxzhy]',
    'SFX S   0     es         [sxzh]',
  ].join('\n'),
);
const DIC = bytes(['4', 'view/ADS', 'pose/KDS', 'separate/DS', 'occur/S', 'occurred'].join('\n'));

describe('Liste de mots anglais (formes Hunspell)', () => {
  const words = parseDicStems(DIC, parseAffixes(AFF));
  const list = new EnglishWordList(words);

  it('développe préfixes et suffixes, y compris combinés', () => {
    for (const word of [
      'view',
      'review',
      'viewed',
      'reviewed',
      'reviews',
      'pose',
      'propose',
      'proposed',
    ]) {
      expect(list.hasExact(word), word).toBe(true);
    }
    expect(list.hasExact('occured')).toBe(false);
  });

  it('sans affixes : formes de base seulement (comportement historique)', () => {
    expect(parseDicStems(DIC).has('review')).toBe(false);
  });

  it('corrections exactes à une modification près', () => {
    expect(englishCorrections('seperate', list)).toEqual(['separate']);
    expect(englishCorrections('occured', list)).toEqual(['occurred']);
    expect(englishCorrections('xyzzy', list)).toEqual([]);
  });

  it('graphies britanniques ramenées à leur forme américaine', () => {
    expect(americanVariants('organisation')).toContain('organization');
    expect(americanVariants('colour')).toContain('color');
    expect(americanVariants('centre')).toContain('center');
    expect(americanVariants('analysed')).toContain('analyzed');
    expect(americanVariants('travelled')).toContain('traveled');
    expect(americanVariants('programme')).toContain('program');
    const withBritish = new EnglishWordList(new Set(['organization', 'color']));
    expect(withBritish.hasExactOrBritish('organisation')).toBe(true);
    expect(withBritish.hasExactOrBritish('colour')).toBe(true);
    expect(withBritish.hasExactOrBritish('colur')).toBe(false);
  });
});
