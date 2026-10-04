import type { DocumentModel } from '@wordfix/shared';

/** Mots-outils français très fréquents : leur proportion trahit la langue du texte. */
const FRENCH_STOPWORDS = new Set([
  'le',
  'la',
  'les',
  'de',
  'des',
  'du',
  'et',
  'en',
  'un',
  'une',
  'est',
  'pour',
  'que',
  'qui',
  'dans',
  'au',
  'aux',
  'sur',
  'par',
  'avec',
  'ce',
  'cette',
  'ces',
  'il',
  'elle',
  'nous',
  'sont',
  'pas',
  'plus',
  'ont',
  'été',
  'ou',
  'mais',
  'son',
  'sa',
  'ses',
  'leur',
  'leurs',
]);

/**
 * Détection simple du français (décision D7) : le moteur est conçu et testé pour
 * le français ; un autre document est analysé sans garantie, avec un avertissement.
 */
export function looksFrench(model: DocumentModel): boolean {
  const words = model.blocks
    .filter((block) => block.part === 'body')
    .slice(0, 400)
    .flatMap((block) => block.text.toLowerCase().match(/\p{L}+/gu) ?? []);
  if (words.length < 30) return true;
  const hits = words.filter((word) => FRENCH_STOPWORDS.has(word)).length;
  return hits / words.length >= 0.12;
}
