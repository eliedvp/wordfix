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
  /** Distance pondérée entre le mot écrit et le candidat. */
  cost: number;
  /** Fréquence d'usage (Zipf), null si inconnue. */
  zipf: number | null;
  /** Score de classement : distance, rang nspell, fréquence (plus bas = meilleur). */
  score: number;
}

/**
 * Classe les candidats : distance pondérée, puis rang chez nspell (léger
 * départage), puis fréquence d'usage. Un mot courant passe devant un mot rare
 * aussi proche (« buget » → budget plutôt que auget).
 */
export function rankCandidates(
  word: string,
  candidates: readonly string[],
  frequency: WordFrequency,
  frequencyWeight = 0,
): RankedCandidate[] {
  const lower = word.toLowerCase();
  return candidates
    .map((candidate, rank) => {
      const cost = weightedDistance(lower, candidate.toLowerCase());
      const zipf = frequency.of(candidate);
      return {
        word: candidate,
        cost,
        zipf,
        score: cost + rank * 0.02 - (zipf ?? 0) * frequencyWeight,
      };
    })
    .sort((x, y) => x.score - y.score);
}

export type SpellingConfidence = Confidence;

export interface SpellingVerdict {
  confidence: SpellingConfidence;
  best: string | null;
  /** Autres formes aussi proches (ex. masculin / féminin), citées dans l'explication. */
  alternatives: string[];
  /** Distance du candidat retenu (pour les règles de confiance de l'analyseur). */
  cost: number | null;
  zipf: number | null;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const NONE: SpellingVerdict = {
  confidence: 'low',
  best: null,
  alternatives: [],
  cost: null,
  zipf: null,
};

/**
 * Confiance d'une correction :
 * - élevée (Erreur) : meilleur candidat nettement devant, très peu de candidats
 *   plausibles, une seule modification élémentaire au plus, vers un mot courant ;
 * - moyenne (Suggestion) : en tête mais avec un ou deux concurrents (ou des
 *   formes d'un même mot), ou correction plus lointaine, ou mot rare ;
 * - faible : trop d'ambiguïté, aucune correction proposée.
 *
 * Sans fréquence, le premier choix de nspell doit être le nôtre. Avec la
 * fréquence, un désaccord avec nspell limite la confiance à « moyenne ».
 */
export function assessConfidence(
  word: string,
  ranked: readonly RankedCandidate[],
  nspellFirst: string | undefined,
  config: SpellingConfig,
  options: {
    /** Les candidats ont été classés avec la fréquence (mot absent de la liste = rare). */
    useFrequency?: boolean;
    /** Exiger l'accord avec nspell même avec la fréquence (mot peut-être nom propre). */
    requireAgreement?: boolean;
  } = {},
): SpellingVerdict {
  const withFrequency = options.useFrequency ?? false;
  const best = ranked[0];
  if (!best) return NONE;

  const second = ranked[1];
  const margin = second ? second.score - best.score : Number.POSITIVE_INFINITY;
  const close = ranked.filter((candidate) => candidate.score <= best.score + config.closeWindow);
  // Candidats plausibles : assez proches du mot, et pas beaucoup moins probables
  // que le meilleur (un mot très rare ne fait pas concurrence à un mot courant).
  const density = ranked.filter(
    (candidate) =>
      candidate.cost <= config.densityCost && candidate.score - best.score <= config.densityWindow,
  ).length;
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
  // Autres corrections aussi proches du mot écrit, les formes du même mot d'abord
  // (« heureus » → heureux, puis heureuse avant heures).
  const alternatives = ranked
    .filter((candidate) => candidate !== best && candidate.cost <= best.cost + config.closeWindow)
    .sort(
      (x, y) =>
        commonPrefix(y.word.toLowerCase(), bestLower) -
          commonPrefix(x.word.toLowerCase(), bestLower) || x.score - y.score,
    )
    .map((candidate) => candidate.word);
  const verdict = (confidence: SpellingConfidence): SpellingVerdict => ({
    confidence,
    best: best.word,
    alternatives,
    cost: best.cost,
    zipf: best.zipf,
  });

  if (best.cost > maxCost || (!agrees && (!withFrequency || options.requireAgreement))) {
    return NONE;
  }
  // Une faute de frappe touche rarement la première lettre : si la correction la
  // change (« ealement » → « salement »), elle n'est jamais présentée comme certaine.
  const sameFirstLetter =
    stripAccents(word.charAt(0).toLowerCase()) === stripAccents(bestLower.charAt(0));
  const certain =
    agrees &&
    sameFirstLetter &&
    best.cost <= config.highMaxCost &&
    (!withFrequency || (best.zipf ?? 0) >= config.highMinZipf);
  if (margin >= config.highMargin && density <= config.highMaxDensity) {
    return verdict(certain ? 'high' : 'medium');
  }
  if ((margin >= config.mediumMargin || sameFamily) && density <= config.mediumMaxDensity) {
    return verdict('medium');
  }
  return NONE;
}
