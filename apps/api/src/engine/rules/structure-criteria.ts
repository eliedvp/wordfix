/**
 * Critères de structure partagés par les règles (`rules.ts`) et le résumé de structure
 * (`engine/structure.ts`) : un titre compté comme numéroté, ou une entrée de sommaire
 * comptée comme comparable, est exactement ce que la règle correspondante contrôle.
 * Module sans dépendance : l'API peut l'importer sans charger le moteur de langue.
 */

/** Numéro saisi au début d'un titre (« 2.3 Méthode »). */
export const TYPED_HEADING_NUMBER = /^\s*(\d+(?:\.\d+)*)\.?\s+\S/;

/** Position d'un titre numéroté dans la suite des numéros de son niveau. */
export interface NumberingStep {
  /** Numéro du titre précédent de même niveau et de même parent (absent : aucun). */
  previous: number[] | undefined;
  /** Dernier nombre attendu ; `null` : rien à comparer (premier de son niveau). */
  expected: number | null;
  current: number;
}

/**
 * Suit les numéros saisis des titres, dans l'ordre du document : chaque appel renvoie
 * ce à quoi le numéro est comparé. Un titre de niveau supérieur réinitialise la
 * numérotation des niveaux inférieurs ; le premier numéro d'un niveau n'est comparé à rien.
 */
export function createNumberingTracker(): (number: string) => NumberingStep {
  const last = new Map<number, number[]>();
  return (number) => {
    const parts = number.split('.').map(Number);
    const depth = parts.length;
    for (const key of [...last.keys()]) if (key > depth) last.delete(key);
    const previous = last.get(depth);
    const sameParent =
      previous !== undefined && previous.slice(0, -1).join('.') === parts.slice(0, -1).join('.');
    last.set(depth, parts);
    return {
      previous,
      expected: sameParent ? (previous.at(-1) ?? 0) + 1 : null,
      current: parts.at(-1) ?? 0,
    };
  };
}

/** Titre normalisé pour comparer une entrée de sommaire aux titres. */
export function normalizeTitle(text: string): string {
  return text
    .replace(/[\t.…\s]+\d+\s*$/u, '') // numéro de page en fin d'entrée
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Entrée de sommaire comparée aux titres : ni trop courte, ni le titre « Sommaire » /
 * « Table des matières » lui-même.
 */
export function isComparableTocEntry(text: string): boolean {
  const title = normalizeTitle(text);
  return title.length >= 3 && !/^(table des matières|sommaire)$/.test(title);
}
