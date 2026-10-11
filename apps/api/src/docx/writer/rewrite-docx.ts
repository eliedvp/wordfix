import { createHash } from 'node:crypto';
import type { Entry } from 'yauzl';
import { ZipFile } from 'yazl';
import { DocxPackage, PART_LIMITS } from '../package-reader.js';
import {
  partKindOf,
  type WalkedPartKind,
  type WalkedParagraph,
  walkPart,
} from '../parser/parts.js';
import { SafeZip } from '../zip-reader.js';
import { readEditableXml, writeEditableXml } from './xml-writer.js';
import type { XmlNode } from '../parser/xml.js';

/**
 * Socle d'écriture d'un .docx existant : seules les parties XML demandées sont
 * réécrites ; toutes les autres entrées (images, styles, relations…) sont recopiées
 * octet pour octet, dans le même ordre, avec la même date et le même mode de
 * compression. Le fichier d'origine n'est jamais modifié : un nouveau fichier est produit.
 *
 * Aucune correction de texte n'est faite ici : les modifications sont fournies par
 * l'appelant (PartEdit), qui agit sur l'arbre XML de la partie.
 */

export interface PartEditContext {
  part: string;
  /** Nature de la partie (corps, en-tête, notes…), ou null pour une partie sans texte lu. */
  kind: WalkedPartKind | null;
  /**
   * Paragraphes de la partie, indexés comme BlockAnchor.paragraphIndex (même
   * parcours que la lecture). Vide pour une partie sans texte lu (styles…).
   */
  paragraphs: ReadonlyMap<number, WalkedParagraph>;
}

export interface PartEdit {
  /** Partie XML à modifier (ex. word/document.xml). */
  part: string;
  /** Modifie l'arbre en place ; renvoie true seulement s'il a été modifié. */
  apply: (tree: XmlNode[], context: PartEditContext) => boolean;
  /**
   * Contrôle facultatif de la partie réécrite, sur l'arbre relu depuis le XML produit
   * (sans nouvelle analyse). Une exception annule toute la réécriture : aucun fichier.
   */
  verify?: (reread: XmlNode[], context: PartEditContext) => void;
}

export interface RewriteResult {
  buffer: Buffer;
  /** Parties réellement réécrites (vide : octets d'origine renvoyés tels quels). */
  changedParts: string[];
}

export type RewriteProblem = 'duplicate_entry' | 'missing_part' | 'not_xml_part' | 'integrity';

export class DocxRewriteError extends Error {
  constructor(
    readonly problem: RewriteProblem,
    detail: string,
  ) {
    super(detail);
    this.name = 'DocxRewriteError';
  }
}

const XML_PART = /\.(xml|rels)$/i;

export async function rewriteDocx(
  source: Buffer,
  edits: readonly PartEdit[],
): Promise<RewriteResult> {
  // Aucune modification : le fichier d'origine, sans reconstruire l'archive.
  if (edits.length === 0) return { buffer: source, changedParts: [] };

  // Ouverture sûre (limites ZIP, macros, XML dangereux) : mêmes contrôles qu'à l'import.
  const pkg = await DocxPackage.open(source);
  const rewritten = new Map<string, Buffer>();
  try {
    assertUniqueEntryNames(pkg.zip);
    for (const part of new Set(edits.map((edit) => edit.part))) {
      if (!pkg.has(part)) throw new DocxRewriteError('missing_part', `partie absente : ${part}`);
      if (!XML_PART.test(part)) {
        throw new DocxRewriteError('not_xml_part', `partie non XML : ${part}`);
      }
      const kind = partKindOf(part, pkg.mainPart);
      const editable = readEditableXml(await pkg.readPart(part, partLimit(part, kind)), part);
      const paragraphs = new Map<number, WalkedParagraph>(
        kind
          ? walkPart(part, kind, editable.tree).paragraphs.map((p) => [p.paragraphIndex, p])
          : [],
      );
      const context: PartEditContext = { part, kind, paragraphs };
      const partEdits = edits.filter((edit) => edit.part === part);
      let changed = false;
      for (const edit of partEdits) {
        if (edit.apply(editable.tree, context)) changed = true;
      }
      if (!changed) continue;
      const written = writeEditableXml(editable);
      for (const edit of partEdits) edit.verify?.(written.reread, context);
      rewritten.set(part, Buffer.from(written.xml, 'utf8'));
    }

    if (rewritten.size === 0) return { buffer: source, changedParts: [] };
    const buffer = await repack(pkg.zip, rewritten);
    await verifyRepack(pkg.zip, buffer, rewritten);
    return { buffer, changedParts: [...rewritten.keys()] };
  } finally {
    pkg.close();
  }
}

/** Plafond de lecture d'une partie : le même que pour la lecture du document. */
function partLimit(part: string, kind: WalkedPartKind | null): number {
  switch (kind) {
    case 'body':
      return PART_LIMITS.mainDocument;
    case 'header':
    case 'footer':
      return PART_LIMITS.headerFooter;
    case 'footnotes':
    case 'endnotes':
      return PART_LIMITS.notes;
    default:
      if (part === '[Content_Types].xml') return PART_LIMITS.contentTypes;
      if (part.endsWith('.rels')) return PART_LIMITS.rels;
      if (part.startsWith('docProps/')) return PART_LIMITS.docProps;
      return PART_LIMITS.styles;
  }
}

/**
 * Une archive dont deux entrées portent le même nom (à la casse près : les noms de
 * parties Word ne la distinguent pas) est ambiguë : on ne sait pas laquelle Word
 * affiche, et la recopie par nom ne pourrait pas conserver les deux. Refus explicite.
 */
function assertUniqueEntryNames(zip: SafeZip): void {
  const seen = new Set<string>();
  for (const entry of zip.order) {
    const key = entry.fileName.toLowerCase();
    if (seen.has(key)) {
      throw new DocxRewriteError('duplicate_entry', `entrée en double : ${entry.fileName}`);
    }
    seen.add(key);
  }
}

/** Nouvelle archive : mêmes entrées, même ordre ; seules les parties réécrites changent. */
async function repack(zip: SafeZip, rewritten: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const out = new ZipFile();
  const done = collect(out.outputStream);
  for (const entry of zip.order) {
    const options = { mtime: entry.getLastModDate(), forceDosTimestamp: true };
    if (entry.fileName.endsWith('/')) {
      out.addEmptyDirectory(entry.fileName, options);
      continue;
    }
    const data =
      rewritten.get(entry.fileName) ?? (await zip.read(entry.fileName, entry.uncompressedSize));
    out.addBuffer(data, entry.fileName, { ...options, compress: entry.compressionMethod !== 0 });
  }
  out.end();
  return done;
}

/**
 * Relecture du résultat : même liste d'entrées dans le même ordre, mêmes modes de
 * compression, contenu identique pour toute entrée non réécrite, et paquet Word
 * toujours valide.
 */
async function verifyRepack(
  original: SafeZip,
  output: Buffer,
  rewritten: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const fail = (detail: string): never => {
    throw new DocxRewriteError('integrity', detail);
  };
  const result = await SafeZip.open(output);
  try {
    const names = (entries: readonly Entry[]) => entries.map((entry) => entry.fileName).join('\n');
    if (names(result.order) !== names(original.order)) fail('liste des entrées modifiée');
    for (const [index, entry] of original.order.entries()) {
      if (entry.fileName.endsWith('/')) continue;
      const copy = result.order[index];
      if (!copy || copy.compressionMethod !== entry.compressionMethod) {
        fail(`compression modifiée : ${entry.fileName}`);
      }
      const expected =
        rewritten.get(entry.fileName) ??
        (await original.read(entry.fileName, entry.uncompressedSize));
      if (copy?.uncompressedSize !== expected.length) fail(`taille inattendue : ${entry.fileName}`);
      const actual = await result.read(entry.fileName, expected.length);
      if (digest(actual) !== digest(expected)) fail(`contenu inattendu : ${entry.fileName}`);
    }
  } finally {
    result.close();
  }
  // Le résultat doit rester un paquet Word acceptable par les contrôles d'import.
  (await DocxPackage.open(output)).close();
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}
