import type { Block, TextRange } from '@wordfix/shared';

/**
 * Outils de texte partagés par les analyseurs : découpage en mots Unicode,
 * zones techniques à ne pas analyser, continuité du texte dans le fichier Word.
 * Tous les traitements sont linéaires sur la longueur du paragraphe.
 */

/** Un mot : lettres et chiffres, avec apostrophes ou traits d'union internes (« l’équipe », « peut-être »). */
export const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD_PATTERN)?.length ?? 0;
}

/** Proportion de mots qui sont des nombres (« 2024 », « 3,5 », « 12 »). */
export function numericShare(text: string): number {
  const words = text.match(WORD_PATTERN) ?? [];
  if (words.length === 0) return 0;
  return words.filter((word) => /^\p{N}+$/u.test(word)).length / words.length;
}

/**
 * Zones techniques qu'aucune règle de langue ne doit toucher : URL, adresses
 * e-mail, chemins, noms de fichiers ou de domaines, identifiants de code.
 * Une suite de caractères sans espace est protégée si elle contient un
 * caractère technique ou un point entre deux caractères alphanumériques.
 */
const PROTECTED_PATTERNS = [
  /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>«»"]+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu,
  /[^\s]*(?:[\\/_=<>{}`#@|~^]|[\p{L}\p{N}]\.[\p{L}\p{N}])[^\s]*/gu,
];

export function findProtectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

/** La plage [start, end[ touche-t-elle une zone protégée ? */
export function overlapsAny(ranges: readonly TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start < end && start < range.end);
}

/**
 * Le texte de [start, end[ provient-il de runs Word consécutifs ? Un run sans
 * texte entre les deux (image, appel de note, champ, objet) laisse un « trou »
 * invisible dans le texte extrait : « voir la figure , » peut alors être
 * parfaitement correct dans Word. Sans information de runs, on répond non.
 */
export function isContinuousText(block: Block, start: number, end: number): boolean {
  const runs = block.anchor.runs.filter((run) => run.start < end && start < run.end);
  if (runs.length === 0) return false;
  const first = runs[0];
  const last = runs.at(-1);
  if (!first || !last || first.start > start || last.end < end) return false;
  for (let i = 1; i < runs.length; i++) {
    const previous = runs[i - 1];
    const current = runs[i];
    if (!previous || !current) return false;
    if (current.runIndex !== previous.runIndex + 1 || current.start !== previous.end) return false;
  }
  return true;
}

/**
 * Titres et abréviations qui précèdent un nom propre : « M. », « Mme », « Mlle »,
 * « Me », « Mgr », « Dr », « Pr. », « St », ainsi que les initiales (« J. »,
 * « J.-P. »). Le point d'une abréviation n'est pas une fin de phrase.
 */
const TITLE = /(?:^|[\s(«"'’])(?:M|MM|Mme|Mmes|Mlle|Mlles|Me|Mgr|Dr|Drs|Pr|Prs|St|Ste|Sr)\.?\s+$/u;
const INITIALS = /(?:^|[\s(«"'’])\p{Lu}\.(?:-?\p{Lu}\.)*\s+$/u;
/** Mot en majuscule, ou particule d'un nom (« Velasio de Paolis », « van Gogh »). */
const NAME_PART =
  /(?:\p{Lu}[\p{L}'’-]*|de|du|des|d['’]|van|von|der|da|di|del|della|dos|le|la|ben|ibn|el|al)\s*$/u;

/**
 * Le mot qui commence en `position` suit-il un titre ou des initiales, directement
 * ou après d'autres mots en majuscule (« M. Kouassi Yao », « Mme Aya Koné ») ?
 */
export function followsTitleOrInitial(text: string, position: number): boolean {
  let before = text.slice(Math.max(0, position - 80), position);
  for (let i = 0; i < 5; i++) {
    if (TITLE.test(before) || INITIALS.test(before)) return true;
    const word = NAME_PART.exec(before.trimEnd());
    if (!word) return false;
    before = before.slice(0, word.index);
  }
  return false;
}

/**
 * Le mot commence-t-il une phrase (aucune lettre avant lui dans la phrase) ?
 * Une « phrase » qui commence juste après un titre ou des initiales (« M. »,
 * « J.-P. ») n'en est pas une : le découpage a pris l'abréviation pour une fin.
 */
export function isSentenceStart(block: Block, position: number): boolean {
  const sentence = block.sentences.find((s) => s.start <= position && position < s.end);
  const from = sentence?.start ?? 0;
  if (/[\p{L}\p{N}]/u.test(block.text.slice(from, position))) return false;
  return !followsTitleOrInitial(block.text, from);
}
