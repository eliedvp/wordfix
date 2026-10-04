import { buildDocx, filler, type FixtureNode } from './builders.js';

/**
 * Rapport de test contenant des problèmes connus, un par étape du moteur :
 * - règles : mot doublé, saut de numérotation (1.1 → 1.3) ;
 * - analyse locale : « serveurs informatique » (accord) ;
 * - analyse contextuelle : transition abrupte (« Par ailleurs, sans transition ») ;
 * - analyse globale + vérification : durée du stage différente (3 mois / 6 mois).
 */
export function reviewDocumentNodes(): FixtureNode[] {
  return [
    { h: 1, text: '1. Introduction' },
    { p: `La durée du stage est de 3 mois au sein de l’entreprise. ${filler(150, 1)}` },
    { h: 2, text: '1.1 Contexte' },
    { p: `L’entreprise dispose de plusieurs serveurs informatique. ${filler(200, 2)}` },
    { h: 2, text: '1.3 Objectifs' },
    { p: `Le le projet vise à moderniser le réseau. ${filler(200, 3)}` },
    { h: 1, text: '2. Déroulement du stage' },
    { p: `Par ailleurs, sans transition, la durée du stage est de 6 mois. ${filler(250, 4)}` },
    { h: 1, text: '3. Conclusion' },
    { p: filler(320, 5) },
  ];
}

export function buildReviewDocument(): Promise<Buffer> {
  return buildDocx(reviewDocumentNodes());
}
