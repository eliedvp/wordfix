import type { Confidence } from '@wordfix/shared';
import type { SpellingConfig } from '../config.js';
import type { WordFrequency } from './frequency.js';

/**
 * Classement des corrections proposées par nspell et calcul de la confiance.
 *
 * nspell renvoie des candidats plausibles mais peu ordonnés pour le français
 * (« peris » → paris, péris, perdis, perds, perfs, permis). On calcule donc une
 * distance pondérée qui reflète les fautes réelles de frappe en français :
 *
 *   casse seule 0,1 · accent seul 0,3 · lettre doublée ou dédoublée 0,5 ·
 *   touches voisines (AZERTY) 0,7 · deux lettres inversées 0,7 ·
 *   lettre manquante ou en trop 1,0 · autre substitution 1,2
 *
 * La confiance ne dépend pas que du meilleur score : elle exige un écart net
 * avec le deuxième candidat, peu de candidats plausibles et l'accord avec le
 * premier choix de nspell. Sinon, aucune correction n'est proposée.
 */

const AZERTY_ROWS = ['azertyuiop', 'qsdfghjklm', 'wxcvbn'];
const KEY_POSITION = new Map<string, [number, number]>();
AZERTY_ROWS.forEach((row, y) =>
  [...row].forEach((key, x) => KEY_POSITION.set(key, [x + (y === 2 ? 0.5 : 0), y])),
);

/** Lettre sans accent ni cédille (« é » → « e », « ç » → « c »). */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) return 0.1;
  const baseA = stripAccents(lowerA);
  const baseB = stripAccents(lowerB);
  if (baseA === baseB) return 0.3;
  const p = KEY_POSITION.get(baseA);
  const q = KEY_POSITION.get(baseB);
  if (p && q && Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1) return 0.7;
  return 1.2;
}

/** Distance d'édition pondérée (avec inversions), sur des mots de longueur bornée. */
export function weightedDistance(source: string, target: string): number {
  const a = [...source];
  const b = [...target];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const ai = a[i - 1] ?? '';
      const bj = b[j - 1] ?? '';
      // Lettre doublée ou dédoublée (« apeller », « professionel ») : faute très courante.
      const insert = bj === b[j - 2] || bj === ai ? 0.5 : 1;
      const remove = ai === a[i - 2] || ai === bj ? 0.5 : 1;
      let value = Math.min(
        (d[(i - 1) * cols + j] ?? 0) + remove,
        (d[i * cols + j - 1] ?? 0) + insert,
        (d[(i - 1) * cols + j - 1] ?? 0) + substitutionCost(ai, bj),
      );
      if (i > 1 && j > 1 && ai === b[j - 2] && a[i - 2] === bj) {
        value = Math.min(value, (d[(i - 2) * cols + j - 2] ?? 0) + 0.7);
      }
      d[i * cols + j] = value;
    }
  }
  return d[rows * cols - 1] ?? 0;
}

export interface RankedCandidate {
  word: string;
  cost: number;
}

/**
 * Classe les candidats : distance pondérée, puis rang chez nspell (léger
 * départage), puis fréquence si une source est disponible.
 */
export function rankCandidates(
  word: string,
  candidates: readonly string[],
  frequency: WordFrequency,
): RankedCandidate[] {
  const lower = word.toLowerCase();
  return candidates
    .map((candidate, rank) => ({
      word: candidate,
      cost:
        weightedDistance(lower, candidate.toLowerCase()) +
        rank * 0.02 -
        (frequency.of(candidate) ?? 0) * 0.1,
    }))
    .sort((x, y) => x.cost - y.cost);
}

export type SpellingConfidence = Confidence;

export interface SpellingVerdict {
  confidence: SpellingConfidence;
  best: string | null;
  /** Autres formes aussi proches (ex. masculin / féminin), citées dans l'explication. */
  alternatives: string[];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Confiance d'une correction :
 * - élevée : meilleur candidat nettement devant, très peu de candidats plausibles,
 *   d'accord avec nspell ;
 * - moyenne : en tête mais avec un ou deux concurrents (ou des formes d'un même mot) ;
 * - faible : trop d'ambiguïté, aucune correction proposée.
 */
export function assessConfidence(
  word: string,
  ranked: readonly RankedCandidate[],
  nspellFirst: string | undefined,
  config: SpellingConfig,
): SpellingVerdict {
  const best = ranked[0];
  if (!best) return { confidence: 'low', best: null, alternatives: [] };

  const second = ranked[1];
  const margin = second ? second.cost - best.cost : Number.POSITIVE_INFINITY;
  const close = ranked.filter((candidate) => candidate.cost <= best.cost + config.closeWindow);
  const density = ranked.filter((candidate) => candidate.cost <= config.densityCost).length;
  const maxCost =
    [...word].length <= config.shortWordLength ? config.maxCostShortWord : config.maxCost;
  const agrees = nspellFirst === best.word;
  const bestLower = best.word.toLowerCase();
  const sameFamily =
    close.length > 1 &&
    close.every(
      (candidate) =>
        commonPrefix(candidate.word.toLowerCase(), bestLower) >=
        Math.max(4, Math.ceil(bestLower.length * config.sameFamilyPrefixRatio)),
    );
  const alternatives = close.slice(1).map((candidate) => candidate.word);

  if (!agrees || best.cost > maxCost) return { confidence: 'low', best: null, alternatives: [] };
  if (margin >= config.highMargin && density <= config.highMaxDensity) {
    return { confidence: 'high', best: best.word, alternatives };
  }
  if ((margin >= config.mediumMargin || sameFamily) && density <= config.mediumMaxDensity) {
    return { confidence: 'medium', best: best.word, alternatives };
  }
  return { confidence: 'low', best: null, alternatives: [] };
}
