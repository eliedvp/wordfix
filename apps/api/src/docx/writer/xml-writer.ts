import { createHash } from 'node:crypto';
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

export interface WrittenXml {
  xml: string;
  /** Arbre relu depuis le XML produit (identique à l'arbre écrit, vérifié). */
  reread: XmlNode[];
}

/**
 * Réécrit l'arbre. Le résultat est relu et doit redonner exactement le même arbre
 * (comparaison directe, sans copie intermédiaire) : sinon la sérialisation aurait
 * altéré le contenu et la partie est refusée. L'arbre relu est renvoyé pour que
 * l'appelant vérifie le texte sans analyser la partie une fois de plus.
 */
export function writeEditableXml({ part, tree, prolog }: EditableXml): WrittenXml {
  const body: string = builder.build(tree);
  if (hasInvalidXmlChar(body)) {
    throw new XmlRewriteError('invalid_output', `caractère interdit en XML : ${part}`);
  }
  const xml = prolog + body;
  const reread = parseXml(xml, part);
  if (!sameXml(reread, tree)) {
    throw new XmlRewriteError('invalid_output', `réécriture non fidèle : ${part}`);
  }
  return { xml, reread };
}

/** Égalité stricte de deux arbres (balises, attributs dans l'ordre, textes), sans récursion. */
export function sameXml(a: XmlNode[], b: XmlNode[]): boolean {
  const stack: [XmlNode[], XmlNode[]][] = [[a, b]];
  while (stack.length > 0) {
    const [left, right] = stack.pop()!;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const x = left[i]!;
      const y = right[i]!;
      const keysX = Object.keys(x);
      const keysY = Object.keys(y);
      if (keysX.length !== keysY.length) return false;
      for (let k = 0; k < keysX.length; k++) {
        const key = keysX[k]!;
        if (key !== keysY[k]) return false;
        const vx = x[key];
        const vy = y[key];
        if (key === ':@') {
          if (!sameAttributes(vx, vy)) return false;
        } else if (Array.isArray(vx)) {
          if (!Array.isArray(vy)) return false;
          stack.push([vx as XmlNode[], vy as XmlNode[]]);
        } else if (vx !== vy) {
          return false;
        }
      }
    }
  }
  return true;
}

function sameAttributes(x: unknown, y: unknown): boolean {
  const ax = x as Record<string, unknown>;
  const ay = y as Record<string, unknown>;
  const kx = Object.keys(ax);
  const ky = Object.keys(ay);
  return kx.length === ky.length && kx.every((key, i) => key === ky[i] && ax[key] === ay[key]);
}

/**
 * Empreinte d'un élément et de tout son contenu. Avec `skeletonOnly`, le texte des
 * w:t et leur attribut xml:space sont ignorés : deux paragraphes de même empreinte
 * ne diffèrent alors que par ce texte (structure, runs et mise en forme identiques).
 */
export function xmlFingerprint(node: XmlNode, skeletonOnly = false): string {
  const hash = createHash('sha256');
  const stack: (XmlNode | string)[] = [node];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      hash.update(item);
      continue;
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === ':@') {
        for (const [name, attr] of Object.entries(value as Record<string, unknown>)) {
          if (skeletonOnly && name === 'xml:space' && 'w:t' in item) continue;
          hash.update(`@${name}=${JSON.stringify(attr)}\u0000`);
        }
      } else if (Array.isArray(value)) {
        hash.update(`<${key}\u0000`);
        stack.push(`>${key}\u0000`);
        if (skeletonOnly && key === 'w:t') continue;
        for (let i = value.length - 1; i >= 0; i--) stack.push(value[i] as XmlNode);
      } else {
        hash.update(`#${key}=${JSON.stringify(value)}\u0000`);
      }
    }
  }
  return hash.digest('hex');
}
