/**
 * Construit `vendor/wordfreq-fr/fr-frequencies.tsv.gz` à partir de la liste
 * française de wordfreq 3.1.1 (voir vendor/wordfreq-fr/README.md).
 *
 * Seuls les mots reconnus par le dictionnaire français de WordFix sont gardés :
 * la fréquence sert uniquement à départager des corrections du dictionnaire,
 * jamais à accepter un mot (la liste brute contient des fautes courantes du web).
 *
 * Usage : tsx scripts/build-frequencies.ts <fr-raw.tsv produit par decode.py>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  getSpellingDictionaries,
  loadSpellingDictionaries,
} from '../src/engine/language/spelling/dictionaries.js';

const input = process.argv[2];
if (!input) throw new Error('usage: tsx scripts/build-frequencies.ts <fr-raw.tsv>');
await loadSpellingDictionaries();
const french = getSpellingDictionaries().french;
const kept: [string, number][] = [];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  const [word, value] = line.split('\t');
  if (!word || value === undefined) continue;
  if (!/^\p{Ll}[\p{Ll}'’-]*$/u.test(word)) continue;
  if (!french.isCorrect(word)) continue;
  kept.push([word, Number(value)]);
}
kept.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
const text = `${kept.map(([w, c]) => `${w}\t${c}`).join('\n')}\n`;
const out = new URL('../vendor/wordfreq-fr/fr-frequencies.tsv.gz', import.meta.url);
writeFileSync(out, gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
process.stdout.write(`${kept.length} mots écrits dans ${out.pathname}\n`);
