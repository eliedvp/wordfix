/**
 * Formes féminines en « -eure » des noms en « -eur » (professeure, chercheure).
 *
 * Plusieurs sont reconnues par le dictionnaire (professeure, auteure, docteure,
 * ingénieure…) ; d'autres en sont absentes alors qu'elles sont employées. Une telle
 * forme n'est jamais une faute de frappe pour le masculin : proposer « chercheurs »
 * pour « chercheure » changerait le genre (et ici le nombre).
 *
 * - Le féminin régulier (« -euse », « -trice ») est connu : c'est la forme
 *   recommandée (Office québécois de la langue française, « Féminin des appellations
 *   de personnes en -eur » : chercheuse plutôt que chercheure) → simple suggestion
 *   vers ce féminin, jamais vers le masculin.
 * - Sinon, rien ne distingue une forme féminine rare (« vainqueure ») d'une faute
 *   de frappe (« honneure ») : l'analyse ordinaire s'applique, mais sans jamais
 *   aller au-delà d'une suggestion (voir spelling.analyzer.ts).
 */
export type FeminineVerdict =
  /** Pas de féminin régulier connu pour ce mot. */
  | { kind: 'none' }
  /** Forme employée, mais le féminin régulier (`recommended`) est préféré. */
  | { kind: 'variant'; recommended: string; masculine: string };

/** Mot qui ressemble à un féminin en « -eure(s) » (jamais une certitude d'Erreur). */
export const FEMININE_EURE = /eures?$/iu;

const EURE = /^(\p{L}+)eure(s?)$/iu;

export function feminineVariant(word: string, known: (word: string) => boolean): FeminineVerdict {
  const match = EURE.exec(word);
  if (!match?.[1]) return { kind: 'none' };
  const stem = match[1];
  const plural = match[2] ?? '';
  const masculine = `${stem}eur${plural}`;
  if (!known(masculine) && !known(masculine.toLowerCase())) return { kind: 'none' };
  // Féminins réguliers : chercheur → chercheuse, directeur → directrice.
  const regular = [`${stem}euse${plural}`];
  if (/t$/iu.test(stem)) regular.push(`${stem.slice(0, -1)}trice${plural}`);
  const recommended = regular.find((form) => known(form) || known(form.toLowerCase()));
  return recommended ? { kind: 'variant', recommended, masculine } : { kind: 'none' };
}
