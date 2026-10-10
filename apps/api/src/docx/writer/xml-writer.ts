import { XMLBuilder } from 'fast-xml-parser';
import { parseXml, XML_OPTIONS, type XmlNode } from '../parser/xml.js';

/**
 * Lecture et réécriture d'une partie XML d'un .docx pour la modifier.
 *
 * L'arbre est celui de la lecture (parseXml, mêmes options), donc celui que le
 * modèle du document a numéroté. La réécriture garde à l'identique ce qui précède
 * l'élément racine (marque d'ordre des octets, déclaration <?xml … standalone="yes"?>)
 * et refuse les constructions que l'arbre ne conserve pas, plutôt que de les perdre.
 */

export type XmlRewriteProblem = 'unsupported_xml' | 'invalid_output';

export class XmlRewriteError extends Error {
  constructor(
    readonly problem: XmlRewriteProblem,
    detail: string,
  ) {
    super(detail);
    this.name = 'XmlRewriteError';
  }
}

const builder = new XMLBuilder({
  ...XML_OPTIONS,
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
  format: false,
});

/** Début de partie conservé tel quel : BOM, déclaration XML, espaces avant la racine. */
const PROLOG = /^(\uFEFF?)(<\?xml\s[^?]*\?>)?(\s*)/;
const DECLARED_ENCODING = /\bencoding\s*=\s*["']([^"']+)["']/i;

/**
 * Vrai si le texte contient un caractère interdit par XML 1.0 : caractère de
 * contrôle (hors tabulation et fins de ligne), U+FFFE, U+FFFF ou demi-paire isolée.
 */
export function hasInvalidXmlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20) {
      if (code !== 0x9 && code !== 0xa && code !== 0xd) return true;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if ((code >= 0xdc00 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      return true;
    }
  }
  return false;
}

export interface EditableXml {
  part: string;
  /** Arbre modifiable en place (même structure que pour la lecture). */
  tree: XmlNode[];
  prolog: string;
}

/** Analyse une partie pour la modifier ; refuse ce que la réécriture ne saurait pas conserver. */
export function readEditableXml(xml: string, part: string): EditableXml {
  const prolog = PROLOG.exec(xml)?.[0] ?? '';
  const declaration = PROLOG.exec(xml)?.[2] ?? '';
  const encoding = DECLARED_ENCODING.exec(declaration)?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new XmlRewriteError(
      'unsupported_xml',
      `encodage non pris en charge (${encoding}) : ${part}`,
    );
  }
  const rest = xml.slice(prolog.length);
  // Commentaires et instructions de traitement ne sont pas gardés dans l'arbre.
  if (rest.includes('<!--') || rest.includes('<?')) {
    throw new XmlRewriteError(
      'unsupported_xml',
      `commentaire ou instruction XML non conservable : ${part}`,
    );
  }
  return { part, tree: parseXml(xml, part), prolog };
}

/**
 * Réécrit l'arbre. Le résultat est relu et doit redonner exactement le même arbre :
 * sinon la sérialisation aurait altéré le contenu et la partie est refusée.
 */
export function writeEditableXml({ part, tree, prolog }: EditableXml): string {
  const body: string = builder.build(tree);
  if (hasInvalidXmlChar(body)) {
    throw new XmlRewriteError('invalid_output', `caractère interdit en XML : ${part}`);
  }
  const xml = prolog + body;
  if (JSON.stringify(parseXml(xml, part)) !== JSON.stringify(tree)) {
    throw new XmlRewriteError('invalid_output', `réécriture non fidèle : ${part}`);
  }
  return xml;
}
