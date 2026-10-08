import type { SpellChecker } from './dictionaries.js';

/**
 * Orthographe rectifiée de 1990 (recommandée par l'Académie française et
 * enseignée) : les deux graphies sont correctes. Le dictionnaire installé est
 * la version « classique » ; ces règles reconnaissent les graphies rectifiées
 * les plus courantes à partir de la forme classique, sans liste de mots :
 *
 * 1. accent circonflexe facultatif sur i et u (connaitre, maitrise, paraitre,
 *    entrainement, boite, cout, gout), sauf dans les terminaisons verbales où il
 *    reste obligatoire (nous vînmes, qu'il fût) ;
 * 2. accent grave devant une syllabe muette (évènement, règlementaire,
 *    sècheresse) au lieu de l'accent aigu ;
 * 3. tréma sur la voyelle prononcée (ambigüe, aigüe) au lieu de « uë ».
 *
 * Une graphie n'est acceptée que si la forme classique correspondante est un
 * mot du dictionnaire : une faute de frappe (« mèthode ») n'est jamais acceptée.
 */
export function isRectifiedSpelling(word: string, dictionary: SpellChecker): boolean {
  const lower = word.toLocaleLowerCase('fr');
  return classicForms(lower).some((form) => dictionary.isCorrect(form));
}

/**
 * Terminaisons du passé simple où le circonflexe reste obligatoire et dont la forme
 * sans accent n'est pas un mot (nous vînmes, vous tîntes). Les autres formes du
 * passé simple sans circonflexe (fumes, futes) sont rares ; une exclusion plus large
 * refuserait des noms courants (voutes, croutes, abimes).
 */
const KEEPS_CIRCUMFLEX = /[îû]n(?:mes|tes)$/u;
const GRAVE_BEFORE_MUTE = /è(?=[bcdfghjklmnpqrstvwxz]{1,3}e)/g;

function classicForms(word: string): string[] {
  const forms = new Set<string>();
  // 1. Circonflexe sur i / u (une position).
  const positions = [...word.matchAll(/[iu]/g)].map((match) => match.index);
  const withCircumflex = (text: string, index: number) =>
    text.slice(0, index) + (text[index] === 'i' ? 'î' : 'û') + text.slice(index + 1);
  for (const first of positions) {
    const one = withCircumflex(word, first);
    if (!KEEPS_CIRCUMFLEX.test(one)) forms.add(one);
  }
  // 2. Accent grave → aigu devant une syllabe muette.
  for (const match of word.matchAll(GRAVE_BEFORE_MUTE)) {
    forms.add(`${word.slice(0, match.index)}é${word.slice(match.index + 1)}`);
  }
  // 3. Tréma déplacé : « güe » → « guë ».
  if (word.includes('güe')) forms.add(word.replace('güe', 'guë'));
  forms.delete(word);
  return [...forms];
}
