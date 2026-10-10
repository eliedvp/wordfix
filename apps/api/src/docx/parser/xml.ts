import { XMLParser } from 'fast-xml-parser';

/**
 * Analyse XML sûre pour les parties d'un .docx.
 *
 * Word n'écrit jamais de DTD : tout document contenant <!DOCTYPE ou <!ENTITY est
 * refusé avant l'analyse (protection contre les entités externes et l'expansion
 * d'entités). Seules les 5 entités XML standard et les références numériques
 * sont décodées (decodeXmlEntities).
 */

export class UnsafeXmlError extends Error {
  constructor(part: string) {
    super(`XML refusé (DTD ou entité déclarée) : ${part}`);
    this.name = 'UnsafeXmlError';
  }
}

/** Nœud XML en mode « ordre préservé » de fast-xml-parser. */
export type XmlNode = Record<string, unknown>;

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
// Nombre de chiffres libre : les zéros en tête sont permis (« &#00000065; » vaut « A »).
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

/** Caractère autorisé par XML 1.0 (les autres références restent telles quelles). */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/**
 * Décode, en une seule passe, les 5 entités XML standard et les références
 * numériques (&#8217; &#xA0;). Une seule passe est indispensable : « &amp;#160; »
 * doit rester le texte littéral « &#160; ». Aucune autre entité n'existe dans un
 * .docx (les DTD sont refusées avant l'analyse).
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (match, dec?: string, hex?: string, name?: string) => {
    if (name) return XML_ENTITIES[name] ?? match;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    return isXmlChar(code) ? String.fromCodePoint(code) : match;
  });
}

/** Options communes à la lecture et à la réécriture des parties XML. */
export const XML_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
} as const;

const entityDecoder = {
  decode: decodeXmlEntities,
  // Les DTD (donc les entités déclarées) sont refusées avant l'analyse.
  setExternalEntities: () => {},
  addInputEntities: () => {},
  reset: () => {},
  setXmlVersion: () => {},
};

const parser = new XMLParser({
  ...XML_OPTIONS,
  entityDecoder,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export function assertSafeXml(xml: string, part: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new UnsafeXmlError(part);
}

export function parseXml(xml: string, part: string): XmlNode[] {
  assertSafeXml(xml, part);
  return parser.parse(xml) as XmlNode[];
}

/** Nom de balise d'un nœud (ex. « w:p »), ou « #text » pour un texte. */
export function tagOf(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return '';
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

export function attrOf(node: XmlNode, name: string): string | undefined {
  const attrs = node[':@'] as Record<string, unknown> | undefined;
  const value = attrs?.[name];
  return typeof value === 'string' ? value : undefined;
}

export function textOf(node: XmlNode): string {
  const value = node['#text'];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Premier enfant direct portant cette balise. */
export function childByTag(node: XmlNode, tag: string): XmlNode | undefined {
  return childrenOf(node).find((child) => tagOf(child) === tag);
}

/** Recherche en profondeur du premier descendant portant cette balise. */
export function findDeep(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const found = findDeep(childrenOf(node), tag);
    if (found) return found;
  }
  return undefined;
}

/** Texte concaténé de tous les descendants (utile pour les petites parties). */
export function deepText(nodes: XmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    out += tagOf(node) === '#text' ? textOf(node) : deepText(childrenOf(node));
  }
  return out;
}

/** Valeur booléenne d'une propriété OOXML (<w:b/>, <w:b w:val="0"/>…). */
export function isOn(node: XmlNode | undefined): boolean {
  if (!node) return false;
  const val = attrOf(node, 'w:val');
  return val === undefined || !['0', 'false', 'off', 'none'].includes(val);
}
