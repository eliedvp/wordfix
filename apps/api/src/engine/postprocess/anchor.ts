/**
 * Ancrage d'un extrait signalé par l'IA dans le texte réel du paragraphe.
 *
 * C'est le filtre principal contre les inventions : si l'extrait n'existe pas
 * dans le paragraphe indiqué, le problème est rejeté. La position est toujours
 * calculée par le backend, jamais reprise du modèle.
 */

/** Variantes typographiques qu'un modèle remplace souvent sans le vouloir. */
const EQUIVALENTS: Record<string, string> = {
  '’': "'",
  '‘': "'",
  ʼ: "'",
  '“': '"',
  '”': '"',
  '«': '"',
  '»': '"',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '\t': ' ',
  '\n': ' ',
  '–': '-',
  '—': '-',
  '…': '...',
};

/**
 * Normalise un texte caractère par caractère en gardant, pour chaque caractère
 * normalisé, sa position dans le texte d'origine.
 */
function normalizeWithMap(text: string): { value: string; map: number[] } {
  let value = '';
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const replaced = EQUIVALENTS[text[i] ?? ''] ?? text[i] ?? '';
    for (const char of replaced) {
      const isSpace = char === ' ';
      if (isSpace && (lastWasSpace || value.endsWith('"'))) continue;
      // Les espaces autour des guillemets (« … » à la française) sont ignorés.
      if (char === '"' && lastWasSpace) {
        value = value.slice(0, -1);
        map.pop();
      }
      value += char;
      map.push(i);
      lastWasSpace = isSpace;
    }
  }
  return { value, map };
}

export interface Anchor {
  start: number;
  end: number;
  /** Extrait tel qu'il figure réellement dans le paragraphe. */
  text: string;
}

/**
 * Cherche l'extrait dans le texte du paragraphe : d'abord à l'identique, puis
 * en tolérant les différences d'apostrophes, de guillemets et d'espaces.
 * Renvoie null si l'extrait est introuvable.
 */
export function anchorExcerpt(blockText: string, excerpt: string): Anchor | null {
  const trimmed = excerpt.trim();
  if (trimmed.length === 0) return null;

  const exact = blockText.indexOf(trimmed);
  if (exact >= 0) return { start: exact, end: exact + trimmed.length, text: trimmed };

  const haystack = normalizeWithMap(blockText);
  const needle = normalizeWithMap(trimmed).value;
  const index = haystack.value.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;

  const start = haystack.map[index] ?? 0;
  const lastMapped = haystack.map[index + needle.length - 1] ?? start;
  const end = lastMapped + 1;
  return { start, end, text: blockText.slice(start, end) };
}

/** Plage de la première phrase d'un paragraphe (pour les remarques globales). */
export function firstSentenceRange(
  text: string,
  sentences: { start: number; end: number }[],
): { start: number; end: number } {
  const first = sentences[0];
  if (first) return { start: first.start, end: Math.min(first.end, first.start + 300) };
  const trimmedEnd = Math.min(text.trimEnd().length, 300);
  return { start: 0, end: trimmedEnd };
}
