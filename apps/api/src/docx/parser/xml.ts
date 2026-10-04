import { XMLParser } from 'fast-xml-parser';

/**
 * Analyse XML sûre pour les parties d'un .docx.
 *
 * Word n'écrit jamais de DTD : tout document contenant <!DOCTYPE ou <!ENTITY est
 * refusé avant l'analyse (protection contre les entités externes et l'expansion
 * d'entités). Seules les 5 entités XML standard et les références numériques
 * sont décodées.
 */

export class UnsafeXmlError extends Error {
  constructor(part: string) {
    super(`XML refusé (DTD ou entité déclarée) : ${part}`);
    this.name = 'UnsafeXmlError';
  }
}

/** Nœud XML en mode « ordre préservé » de fast-xml-parser. */
export type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
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
