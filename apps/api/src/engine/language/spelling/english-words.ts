import type { WordList } from './word-lists.js';

/**
 * Mots anglais connus, pour reconnaître les anglicismes : un mot absent du
 * dictionnaire français mais présent en anglais (« team », « online », « install »)
 * n'est jamais signalé comme faute. Sans ce garde-fou, l'analyseur proposerait
 * des « corrections » absurdes (team → tram, online → ondine).
 *
 * Source : dictionnaire Hunspell anglais de `dictionary-en` (SCOWL, licence
 * MIT AND BSD). Seules les formes de base sont gardées, dans un simple ensemble
 * (quelques Mo) : pas de second moteur nspell. Les formes fléchies courantes
 * sont reconnues en retirant les terminaisons anglaises usuelles.
 */
export class EnglishWordList implements WordList {
  constructor(private readonly stems: ReadonlySet<string>) {}

  get size(): number {
    return this.stems.size;
  }

  has(word: string): boolean {
    const lower = word.toLowerCase();
    if (this.stems.has(lower)) return true;
    return englishBaseForms(lower).some((form) => this.stems.has(form));
  }
}

const SUFFIXES = ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'ers', 'able', 'ment', 'ments'];

/** Formes de base possibles d'un mot anglais fléchi (« queries » → query, « scalable » → scale). */
export function englishBaseForms(word: string): string[] {
  const forms: string[] = [];
  if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`);
  for (const suffix of SUFFIXES) {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3) continue;
    const stem = word.slice(0, -suffix.length);
    forms.push(stem, `${stem}e`);
    // Consonne doublée : « committed » → commit.
    if (stem.length > 3 && stem.at(-1) === stem.at(-2)) forms.push(stem.slice(0, -1));
  }
  return forms;
}

/** Lit les formes de base d'un fichier .dic Hunspell (« word/FLAGS » par ligne). */
export function parseDicStems(dic: Uint8Array): Set<string> {
  const stems = new Set<string>();
  const lines = Buffer.from(dic.buffer, dic.byteOffset, dic.byteLength)
    .toString('utf8')
    .split('\n');
  // La première ligne donne le nombre d'entrées.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const slash = line.indexOf('/');
    const stem = (slash >= 0 ? line.slice(0, slash) : line).trim().toLowerCase();
    if (/^\p{L}{2,}$/u.test(stem)) stems.add(stem);
  }
  return stems;
}
