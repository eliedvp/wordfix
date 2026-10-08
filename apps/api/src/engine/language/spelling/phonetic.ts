import type { ZipfFrequency } from './frequency.js';

/**
 * Clé phonétique française simplifiée : deux mots qui se prononcent de la même
 * façon ont la même clé (« akeuil » / accueil, « sistème » / système,
 * « comunikation » / communication). Elle sert uniquement à proposer des
 * corrections pour les mots très déformés, que la recherche par petites fautes
 * ne trouve pas ; ces corrections ne sont jamais présentées comme sûres.
 *
 * Règles (dans l'ordre) : accents retirés ; ç, ss, -tion → s ; cc devant e/i → ks ;
 * lettres doublées réduites ; ch → ʃ ; ph → f ; qu → k ; c → s ou k ; g → j devant
 * e/i ; x → ks ; eau, au → o ; ou → u ; ai, ei → e ; -er, -ez, -et → e ; ill → y ;
 * h muet ; voyelles nasales (an/en, on, in/ain/un) ; s entre voyelles → z ;
 * lettres finales muettes (e, s, t, d, x, z) retirées.
 */
const RULES: [RegExp, string][] = [
  [/cc(?=[eiy])/g, 'kS'],
  [/ction/g, 'kSion'],
  [/tion/g, 'Sion'],
  [/ss/g, 'S'],
  [/c+ueil/g, 'Keuil'],
  [/gueil/g, 'Geuil'],
  [/([a-z])\1+/g, '$1'],
  [/sch/g, '$'],
  [/ch/g, '$'],
  [/ph/g, 'f'],
  [/th/g, 't'],
  [/qu/g, 'k'],
  [/gu(?=[eiy])/g, 'g'],
  [/ck/g, 'k'],
  [/c(?=[eiy])/g, 'S'],
  [/c/g, 'k'],
  [/x/g, 'kS'],
  [/g(?=[eiy])/g, 'j'],
  [/eau/g, 'o'],
  [/au/g, 'o'],
  [/ou/g, 'U'],
  [/oi/g, 'wa'],
  [/(?:ai|ei|ay|ey)/g, 'e'],
  [/(?:er|ez|et)$/g, 'e'],
  [/ill/g, 'y'],
  [/y/g, 'i'],
  [/h/g, ''],
  [/w/g, 'v'],
  [/(?:ain|ein|aim|in|im|un|um)(?![aeiouU])/g, 'I'],
  [/(?:an|am|en|em)(?![aeiouU])/g, 'A'],
  [/(?:on|om)(?![aeiouU])/g, 'O'],
  [/(?<=[aeiouU])s(?=[aeiouU])/g, 'z'],
  [/S/g, 's'],
  [/K/g, 'k'],
  [/G/g, 'g'],
  [/(.)\1+/g, '$1'],
];

export function phoneticKey(word: string): string {
  let key = word
    .toLocaleLowerCase('fr')
    .replace(/[œæ]/g, 'e')
    .replace(/ç/g, 'S')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zS]/g, '');
  for (const [pattern, replacement] of RULES) key = key.replace(pattern, replacement);
  while (key.length > 3 && /[estdxz]$/.test(key)) key = key.slice(0, -1);
  return key;
}

const indexes = new WeakMap<ZipfFrequency, Map<string, { word: string; zipf: number }[]>>();

/** Mots du dictionnaire (liste de fréquences) qui ont la même clé phonétique. */
export function soundsLike(
  word: string,
  frequency: ZipfFrequency,
): readonly { word: string; zipf: number }[] {
  let index = indexes.get(frequency);
  if (!index) {
    // Construit une fois par processus, au premier mot très déformé (≈ 120 000 mots).
    index = new Map();
    for (const [entry, zipf] of frequency.entries()) {
      const key = phoneticKey(entry);
      const list = index.get(key) ?? [];
      list.push({ word: entry, zipf });
      index.set(key, list);
    }
    indexes.set(frequency, index);
  }
  const lower = word.toLocaleLowerCase('fr');
  return (index.get(phoneticKey(lower)) ?? []).filter((candidate) => candidate.word !== lower);
}
