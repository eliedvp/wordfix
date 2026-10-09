import type { WordList } from './word-lists.js';

/**
 * Mots anglais connus, pour reconnaître les anglicismes : un mot absent du
 * dictionnaire français mais présent en anglais (« team », « online », « install »)
 * n'est jamais signalé comme faute. Sans ce garde-fou, l'analyseur proposerait
 * des « corrections » absurdes (team → tram, online → ondine).
 *
 * Source : dictionnaire Hunspell anglais de `dictionary-en` (SCOWL, licence
 * MIT AND BSD). Les formes autorisées par le dictionnaire (base, préfixes,
 * suffixes) sont gardées dans un simple ensemble : pas de second moteur nspell.
 * `has` reconnaît en plus, par retrait des terminaisons usuelles, des formes
 * approchées (anglicismes) ; `hasExact` s'en tient aux formes du dictionnaire.
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

  /**
   * Forme exactement autorisée par le dictionnaire, sans retrait approximatif des
   * terminaisons (`has` accepte aussi « occured » ou « managment », assez pour
   * reconnaître un anglicisme, pas pour corriger une faute anglaise).
   */
  hasExact(word: string): boolean {
    return this.stems.has(word.toLowerCase());
  }

  /** Forme du dictionnaire, ou graphie britannique d'une forme du dictionnaire. */
  hasExactOrBritish(word: string): boolean {
    const lower = word.toLowerCase();
    return this.stems.has(lower) || americanVariants(lower).some((v) => this.stems.has(v));
  }
}

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'];

/**
 * Graphies britanniques (le dictionnaire est américain) : « organisation »,
 * « colour », « centre », « analysed », « travelled », « defence ». Chaque
 * variante remplace une seule terminaison ou syllabe par sa forme américaine.
 */
const BRITISH_TO_AMERICAN: readonly [RegExp, string][] = [
  [/is(?=(?:e|ed|es|er|ers|ing|ation|ations|able)$)/u, 'iz'],
  [/isation(s?)$/u, 'ization$1'],
  [/our(?=(?:s|ed|ing|ite|ites|able|er|ers|ful|less)?$)/u, 'or'],
  [/tre(s?)$/u, 'ter$1'],
  [/ence(s?)$/u, 'ense$1'],
  [/ys(?=(?:e|ed|es|ing|er|ers)$)/u, 'yz'],
  [/ll(?=(?:ed|ing|er|ers)$)/u, 'l'],
  [/ogue(s?)$/u, 'og$1'],
  [/mme(s?)$/u, 'm$1'],
  [/ae/u, 'e'],
  [/oe/u, 'e'],
];

export function americanVariants(word: string): string[] {
  const out = new Set<string>();
  for (const [pattern, replacement] of BRITISH_TO_AMERICAN) {
    const variant = word.replace(pattern, replacement);
    if (variant !== word) out.add(variant);
  }
  return [...out];
}

/**
 * Mots anglais connus à une seule modification (lettre supprimée, ajoutée,
 * remplacée ou deux lettres inversées) d'un mot inconnu en minuscules.
 */
export function englishCorrections(
  word: string,
  list: Pick<EnglishWordList, 'hasExact'>,
): string[] {
  const found = new Set<string>();
  const a = [...word];
  const consider = (candidate: string) => {
    if (candidate !== word && candidate.length >= 2 && list.hasExact(candidate))
      found.add(candidate);
  };
  for (let i = 0; i <= a.length; i++) {
    const head = a.slice(0, i).join('');
    if (i < a.length) {
      const tail = a.slice(i + 1).join('');
      consider(head + tail);
      if (i < a.length - 1)
        consider(head + (a[i + 1] ?? '') + (a[i] ?? '') + a.slice(i + 2).join(''));
      for (const letter of LETTERS) if (letter !== a[i]) consider(head + letter + tail);
    }
    const rest = a.slice(i).join('');
    for (const letter of LETTERS) consider(head + letter + rest);
  }
  return [...found];
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

/** Règle d'affixe Hunspell : `SFX D 0 ed [^ey]` (lettres retirées, ajoutées, condition). */
interface AffixRule {
  strip: string;
  add: string;
  condition: RegExp;
}

interface AffixGroup {
  /** « Y » : combinable avec un affixe de l'autre type (re + view + ed). */
  cross: boolean;
  rules: AffixRule[];
}

export interface Affixes {
  prefixes: ReadonlyMap<string, AffixGroup>;
  suffixes: ReadonlyMap<string, AffixGroup>;
}

/** Lit les préfixes (PFX) et suffixes (SFX) d'un fichier .aff Hunspell. */
export function parseAffixes(aff: Uint8Array): Affixes {
  const prefixes = new Map<string, AffixGroup>();
  const suffixes = new Map<string, AffixGroup>();
  const text = Buffer.from(aff.buffer, aff.byteOffset, aff.byteLength).toString('utf8');
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const kind = parts[0];
    if ((kind !== 'PFX' && kind !== 'SFX') || !parts[1]) continue;
    const groups = kind === 'PFX' ? prefixes : suffixes;
    const flag = parts[1];
    // En-tête « SFX D Y 4 » : combinable ou non, nombre de règles.
    if (parts.length === 4) {
      groups.set(flag, { cross: parts[2] === 'Y', rules: [] });
      continue;
    }
    const [, , strip = '0', add = '0', condition = '.'] = parts;
    const group = groups.get(flag) ?? { cross: false, rules: [] };
    group.rules.push({
      strip: strip === '0' ? '' : strip,
      add: add === '0' ? '' : (add.split('/')[0] ?? ''),
      condition: new RegExp(kind === 'PFX' ? `^${condition}` : `${condition}$`, 'u'),
    });
    groups.set(flag, group);
  }
  return { prefixes, suffixes };
}

function applyPrefix(stem: string, rule: AffixRule): string | null {
  if (!rule.condition.test(stem) || !stem.startsWith(rule.strip)) return null;
  return rule.add + stem.slice(rule.strip.length);
}

function applySuffix(stem: string, rule: AffixRule): string | null {
  if (!rule.condition.test(stem) || !stem.endsWith(rule.strip)) return null;
  return stem.slice(0, stem.length - rule.strip.length) + rule.add;
}

const NO_AFFIXES: Affixes = { prefixes: new Map(), suffixes: new Map() };

/**
 * Lit un fichier .dic Hunspell (« word/FLAGS » par ligne) et, avec les affixes du
 * fichier .aff, toutes les formes qu'il autorise : « review » (« view » + préfixe
 * « re »), « proposed » (« pose » + « pro » + « ed »), « receives »… Sans affixes,
 * seules les formes de base sont gardées.
 */
export function parseDicStems(dic: Uint8Array, affixes: Affixes = NO_AFFIXES): Set<string> {
  const words = new Set<string>();
  const lines = Buffer.from(dic.buffer, dic.byteOffset, dic.byteLength)
    .toString('utf8')
    .split('\n');
  const add = (word: string | null) => {
    if (word && /^\p{L}{2,}$/u.test(word)) words.add(word);
  };
  // La première ligne donne le nombre d'entrées.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const slash = line.indexOf('/');
    const stem = (slash >= 0 ? line.slice(0, slash) : line).trim().toLowerCase();
    if (!/^\p{L}{2,}$/u.test(stem)) continue;
    words.add(stem);
    if (slash < 0) continue;
    const flags = [...line.slice(slash + 1).trim()];
    // Formes préfixées (« review »), puis suffixées, sur la base et sur les formes
    // préfixées combinables (« reviewed »).
    const bases: { word: string; cross: boolean }[] = [{ word: stem, cross: true }];
    for (const flag of flags) {
      const group = affixes.prefixes.get(flag);
      for (const rule of group?.rules ?? []) {
        const prefixed = applyPrefix(stem, rule);
        add(prefixed);
        if (prefixed) bases.push({ word: prefixed, cross: group?.cross ?? false });
      }
    }
    for (const flag of flags) {
      const group = affixes.suffixes.get(flag);
      if (!group) continue;
      for (const base of bases) {
        if (base.word !== stem && !(base.cross && group.cross)) continue;
        for (const rule of group.rules) add(applySuffix(base.word, rule));
      }
    }
  }
  return words;
}
