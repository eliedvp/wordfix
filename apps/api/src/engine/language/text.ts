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
