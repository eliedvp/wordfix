import type { SpellChecker } from './dictionaries.js';

/**
 * Accents oubliés : le mot écrit sans accent (« evolution », « premiere »,
 * « problemes ») correspond-il à un mot français accentué ? Les fautes d'accent
 * sont les plus fréquentes en français ; elles passent avant la reconnaissance des
 * anglicismes, sans quoi « evolution » ou « region » seraient pris pour de l'anglais.
 *
 * Variantes essayées : une ou deux lettres accentuées (é, è, ê, à, â, î, ï, ô, ù,
 * û, ü, ç). Le mot n'est retenu que si le dictionnaire le connaît.
 */
const ACCENTS: Record<string, readonly string[]> = {
  e: ['é', 'è', 'ê'],
  a: ['à', 'â'],
  i: ['î', 'ï'],
  o: ['ô'],
  u: ['ù', 'û', 'ü'],
  c: ['ç'],
};

export function accentedVariant(word: string, dictionary: SpellChecker): string | null {
  const lower = word.toLocaleLowerCase('fr');
  if (/[^a-z'’-]/.test(lower)) return null; // déjà accentué, ou caractère inattendu
  const letters = [...lower];
  const positions = letters.flatMap((letter, index) => (ACCENTS[letter] ? [index] : []));
  const variant = (changes: [number, string][]) => {
    const copy = [...letters];
    for (const [index, letter] of changes) copy[index] = letter;
    return copy.join('');
  };
  for (const i of positions) {
    for (const a of ACCENTS[letters[i] ?? ''] ?? []) {
      const one = variant([[i, a]]);
      if (dictionary.isCorrect(one)) return one;
    }
  }
  for (const i of positions) {
    for (const j of positions) {
      if (j <= i) continue;
      for (const a of ACCENTS[letters[i] ?? ''] ?? []) {
        for (const b of ACCENTS[letters[j] ?? ''] ?? []) {
          const two = variant([
            [i, a],
            [j, b],
          ]);
          if (dictionary.isCorrect(two)) return two;
        }
      }
    }
  }
  return null;
}
