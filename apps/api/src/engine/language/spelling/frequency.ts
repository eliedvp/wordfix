import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * Fréquence d'usage des mots français, pour départager des corrections aussi
 * proches l'une que l'autre (« buget » → « budget » plutôt que « auget ») et
 * pour ne jamais présenter comme certaine une correction vers un mot rare.
 *
 * Source : liste française de wordfreq 3.1.1 (données CC BY-SA 4.0), réduite
 * aux mots du dictionnaire français (voir vendor/wordfreq-fr/README.md). Elle ne
 * sert qu'à classer des mots déjà reconnus par le dictionnaire : un mot fréquent
 * sur le web mais mal orthographié n'y figure pas.
 *
 * Échelle « Zipf » : log10 du nombre d'occurrences par milliard de mots
 * (« de » ≈ 7,7 ; « budget » ≈ 4,8 ; « auget » ≈ 1,6). null : mot absent de la liste.
 */
export interface WordFrequency {
  of(word: string): number | null;
  /**
   * Mots de la liste qui ne diffèrent de `word` que par les accents (« taches » →
   * tâches, tachés), avec leur fréquence. Vide si aucune liste n'est installée.
   */
  accentVariants(word: string): readonly { word: string; zipf: number }[];
}

export const NO_FREQUENCY: WordFrequency = { of: () => null, accentVariants: () => [] };

const stripAccents = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

export class ZipfFrequency implements WordFrequency {
  constructor(private readonly values: ReadonlyMap<string, number>) {}

  get size(): number {
    return this.values.size;
  }

  entries(): IterableIterator<[string, number]> {
    return this.values.entries();
  }

  private byBase: Map<string, { word: string; zipf: number }[]> | null = null;

  of(word: string): number | null {
    return this.values.get(word.toLocaleLowerCase('fr').replace(/’/g, "'")) ?? null;
  }

  accentVariants(word: string): readonly { word: string; zipf: number }[] {
    // Index construit au premier usage (≈ 120 000 mots, une fois par processus).
    if (!this.byBase) {
      this.byBase = new Map();
      for (const [entry, zipf] of this.values) {
        const base = stripAccents(entry);
        const list = this.byBase.get(base) ?? [];
        list.push({ word: entry, zipf });
        this.byBase.set(base, list);
      }
    }
    const lower = word.toLocaleLowerCase('fr');
    return (this.byBase.get(stripAccents(lower)) ?? []).filter((variant) => variant.word !== lower);
  }
}

const FILE = join('vendor', 'wordfreq-fr', 'fr-frequencies.tsv.gz');

/** Lit la liste « mot<TAB>centibels » ; Zipf = 9 − centibels / 100. */
export function parseFrequencies(data: Buffer): ZipfFrequency {
  const values = new Map<string, number>();
  for (const line of gunzipSync(data).toString('utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    values.set(line.slice(0, tab), 9 - Number(line.slice(tab + 1)) / 100);
  }
  return new ZipfFrequency(values);
}

/** Charge la liste installée avec l'API (dossier vendor, depuis src/ comme depuis dist/). */
export function loadFrequencies(): ZipfFrequency {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, FILE);
    if (existsSync(candidate)) return parseFrequencies(readFileSync(candidate));
    dir = dirname(dir);
  }
  throw new Error(`Liste de fréquences introuvable : ${FILE}`);
}
