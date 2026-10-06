/**
 * Cas ambigus : fautes que le moteur déterministe détecte, mais dont il ne peut
 * pas choisir la correction sans comprendre la phrase (« peris » → permis ? paris ?
 * péris ?). Ces cas, et eux seuls, peuvent être confiés à l'IA, qui ne fait que
 * choisir parmi les corrections proposées par le moteur.
 */

/**
 * - `spelling` : mot absent du dictionnaire, plusieurs corrections proches ;
 * - `distorted` : mot absent du dictionnaire, très déformé (aucun mot à une faute près) ;
 * - `confusion` : mot du dictionnaire probablement confondu avec un autre qui ne
 *   s'en distingue que par les accents (taches / tâches) ;
 * - `grammar` : faute de grammaire avec plusieurs corrections possibles.
 */
export type AmbiguityKind = 'spelling' | 'distorted' | 'confusion' | 'grammar';

/** Une correction possible, déjà validée par le moteur déterministe. */
export interface AmbiguityOption {
  /** Plage remplacée dans le texte du paragraphe. */
  start: number;
  end: number;
  replacement: string;
}

/**
 * Ce que devient le cas si l'IA ne tranche pas (budget atteint, IA indisponible,
 * réponse invalide ou incertaine) :
 * - `verify` : remarque « À vérifier », sans correction ;
 * - `keep` : la remarque déterministe telle quelle (Suggestion) ;
 * - `drop` : aucune remarque (le mot existe, ou le moteur n'a aucun indice fiable).
 */
export type AmbiguityFallback = 'verify' | 'keep' | 'drop';

export interface AmbiguityInfo {
  kind: AmbiguityKind;
  options: AmbiguityOption[];
  fallback: AmbiguityFallback;
}
