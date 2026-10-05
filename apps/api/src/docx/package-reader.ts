import { SafeZip, ZipReadError } from './zip-reader.js';
import { assertSafeXml, UnsafeXmlError } from './parser/xml.js';

/** Plafonds de lecture des parties XML d'un .docx. */
export const PART_LIMITS = {
  contentTypes: 1024 * 1024,
  rels: 1024 * 1024,
  mainDocument: 30 * 1024 * 1024,
  styles: 10 * 1024 * 1024,
  notes: 10 * 1024 * 1024,
  headerFooter: 2 * 1024 * 1024,
  docProps: 1024 * 1024,
} as const;

const MAIN_DOCUMENT_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const OFFICE_DOCUMENT_REL = /\/officeDocument$/;

export type PackageProblem = 'not_docx' | 'macro' | 'corrupted' | 'unsafe_xml';

export class DocxPackageError extends Error {
  constructor(
    readonly problem: PackageProblem,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = 'DocxPackageError';
  }
}

/** Accès aux parties utiles d'un paquet .docx déjà ouvert de façon sûre. */
export class DocxPackage {
  private constructor(
    readonly zip: SafeZip,
    readonly mainPart: string,
  ) {}

  /**
   * Ouvre le paquet et vérifie qu'il s'agit bien d'un document Word .docx sans
   * macros. Toute anomalie est convertie en DocxPackageError.
   */
  static async open(buffer: Buffer): Promise<DocxPackage> {
    let zip: SafeZip;
    try {
      zip = await SafeZip.open(buffer);
    } catch (error) {
      throw toPackageError(error);
    }

    try {
      if (!zip.has('[Content_Types].xml')) {
        throw new DocxPackageError('not_docx', '[Content_Types].xml absent');
      }
      const contentTypes = await zip.readText('[Content_Types].xml', PART_LIMITS.contentTypes);
      assertSafeXml(contentTypes, '[Content_Types].xml');

      if (/macroEnabled/i.test(contentTypes) || zip.has('word/vbaProject.bin')) {
        throw new DocxPackageError('macro', 'document avec macros');
      }
      if (!contentTypes.includes(MAIN_DOCUMENT_CT)) {
        throw new DocxPackageError('not_docx', 'type de contenu Word absent');
      }

      const mainPart = await findMainPart(zip);
      if (!zip.has(mainPart)) {
        throw new DocxPackageError('corrupted', `partie principale absente : ${mainPart}`);
      }
      return new DocxPackage(zip, mainPart);
    } catch (error) {
      zip.close();
      throw toPackageError(error);
    }
  }

  has(part: string): boolean {
    return this.zip.has(part);
  }

  /** Liste des parties dont le nom correspond au motif (ex. en-têtes). */
  partsMatching(pattern: RegExp): string[] {
    return [...this.zip.entries.keys()].filter((name) => pattern.test(name)).sort();
  }

  async readPart(part: string, maxBytes: number): Promise<string> {
    try {
      const xml = await this.zip.readText(part, maxBytes);
      assertSafeXml(xml, part);
      return xml;
    } catch (error) {
      throw toPackageError(error);
    }
  }

  async readOptionalPart(part: string, maxBytes: number): Promise<string | null> {
    return this.has(part) ? this.readPart(part, maxBytes) : null;
  }

  close(): void {
    this.zip.close();
  }
}

async function findMainPart(zip: SafeZip): Promise<string> {
  if (!zip.has('_rels/.rels')) return 'word/document.xml';
  const rels = await zip.readText('_rels/.rels', PART_LIMITS.rels);
  assertSafeXml(rels, '_rels/.rels');
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const type = /Type="([^"]+)"/.exec(tag)?.[1] ?? '';
    const target = /Target="([^"]+)"/.exec(tag)?.[1];
    if (target && OFFICE_DOCUMENT_REL.test(type)) {
      const normalized = target.replace(/^\//, '');
      // Une cible doit rester dans l'archive : pas de remontée de dossier.
      if (normalized.includes('..')) throw new DocxPackageError('corrupted', 'cible invalide');
      return normalized;
    }
  }
  return 'word/document.xml';
}

function toPackageError(error: unknown): DocxPackageError {
  if (error instanceof DocxPackageError) return error;
  if (error instanceof UnsafeXmlError) {
    return new DocxPackageError('unsafe_xml', error.message, { cause: error });
  }
  if (error instanceof ZipReadError) {
    return new DocxPackageError('corrupted', `${error.reason}: ${error.message}`, { cause: error });
  }
  return new DocxPackageError('corrupted', 'erreur de lecture inattendue', { cause: error });
}
