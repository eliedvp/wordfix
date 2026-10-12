import type { IssueDto } from './api-types.js';
import type { IssueCategory } from './taxonomy.js';

/**
 * « Tout corriger » : seules les corrections fiables sont acceptées d'un coup. Même
 * règle côté API (acceptation) et côté site (nombre annoncé) :
 * - point encore à traiter (`open`) : une décision de l'utilisateur (acceptée,
 *   modifiée, ignorée, vérifiée) n'est jamais remplacée ;
 * - orthographe, grammaire ou ponctuation, de nature « erreur », en confiance élevée ;
 * - proposition utilisable : présente, différente du passage, sur une seule ligne.
 * Les points incertains (« à examiner », « à vérifier », confiance moyenne ou faible,
 * style, cohérence, structure) ne sont jamais appliqués automatiquement.
 */
export const RELIABLE_CATEGORIES: readonly IssueCategory[] = ['spelling', 'grammar', 'punctuation'];

/** Nombre maximal de points d'une annulation de « Tout corriger » (taille de requête). */
export const MAX_BULK_ISSUES = 1000;

export function isReliableCorrection(
  issue: Pick<
    IssueDto,
    'status' | 'category' | 'nature' | 'confidence' | 'original' | 'suggestion'
  >,
): boolean {
  return (
    issue.status === 'open' &&
    RELIABLE_CATEGORIES.includes(issue.category) &&
    issue.nature === 'error' &&
    issue.confidence === 'high' &&
    issue.suggestion !== null &&
    issue.suggestion !== issue.original &&
    !/[\r\n\t\v\f]/.test(issue.suggestion)
  );
}
