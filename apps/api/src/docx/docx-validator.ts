import { ACCEPTED_EXTENSION, MAX_DOCUMENT_WORDS } from '@wordfix/shared';
import { AppError } from '../common/errors/app-error.js';
import { DocxPackage, DocxPackageError, PART_LIMITS } from './package-reader.js';
import { countWords } from './parser/text.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** Nom de flux présent dans un .docx chiffré (conteneur OLE), en UTF-16LE. */
const ENCRYPTED_PACKAGE_MARKER = Buffer.from('EncryptedPackage', 'utf16le');
const WORDS_PER_PAGE = 400;

export interface DocxQuickStats {
  wordCount: number;
  declaredPages: number | null;
  estimatedPages: number;
}

/**
 * Vérifie qu'un fichier importé est un vrai .docx exploitable et en tire des
 * statistiques rapides (mots, pages). Ne fait jamais confiance à l'extension ni
 * au type MIME envoyé par le navigateur : seule la structure du fichier compte.
 *
 * Lève une AppError portant le code du catalogue adapté au problème.
 */
export async function validateDocx(buffer: Buffer, originalName: string): Promise<DocxQuickStats> {
  const lowerName = originalName.toLowerCase();

  if (buffer.length === 0) throw new AppError('CORRUPTED_FILE', { detail: 'fichier vide' });

  if (buffer.subarray(0, 8).equals(OLE_MAGIC)) {
    // Conteneur OLE : soit un .docx protégé par mot de passe, soit un ancien .doc.
    throw new AppError(
      buffer.includes(ENCRYPTED_PACKAGE_MARKER) ? 'PASSWORD_PROTECTED' : 'LEGACY_DOC_FORMAT',
    );
  }
  if (lowerName.endsWith('.docm')) throw new AppError('MACRO_DOCUMENT');
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC) || !lowerName.endsWith(ACCEPTED_EXTENSION)) {
    throw new AppError('UNSUPPORTED_FORMAT');
  }

  let pkg: DocxPackage;
  try {
    pkg = await DocxPackage.open(buffer);
  } catch (error) {
    throw packageErrorToAppError(error);
  }

  try {
    const documentXml = await pkg.readPart(pkg.mainPart, PART_LIMITS.mainDocument);
    if (!/<w:body[\s>]/.test(documentXml)) {
      throw new AppError('CORRUPTED_FILE', { detail: 'corps du document absent' });
    }

    const wordCount = countWords(quickBodyText(documentXml));
    if (wordCount === 0) throw new AppError('EMPTY_DOCUMENT');
    if (wordCount > MAX_DOCUMENT_WORDS) throw new AppError('DOCUMENT_TOO_LONG');

    const appXml = await pkg.readOptionalPart('docProps/app.xml', PART_LIMITS.docProps);
    const declaredPages = plausiblePages(parseDeclaredPages(appXml), wordCount);
    return {
      wordCount,
      declaredPages,
      estimatedPages: declaredPages ?? Math.max(1, Math.ceil(wordCount / WORDS_PER_PAGE)),
    };
  } catch (error) {
    throw packageErrorToAppError(error);
  } finally {
    pkg.close();
  }
}

/**
 * Texte approximatif du corps, sans analyse XML complète : contenu des balises
 * <w:t>, paragraphes séparés par une espace. Suffisant pour compter les mots.
 */
export function quickBodyText(documentXml: string): string {
  const parts: string[] = [];
  for (const match of documentXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>/g)) {
    parts.push(match[1] ?? ' ');
  }
  return parts.join('');
}

export function parseDeclaredPages(appXml: string | null): number | null {
  if (!appXml) return null;
  const value = Number(/<Pages>(\d+)<\/Pages>/.exec(appXml)?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Le nombre de pages déclaré par le logiciel d'édition n'est gardé que s'il est
 * vraisemblable (entre 80 et 900 mots par page) : certains outils écrivent une
 * valeur par défaut jamais mise à jour.
 */
export function plausiblePages(declared: number | null, wordCount: number): number | null {
  if (!declared) return null;
  const perPage = wordCount / declared;
  return perPage >= 80 && perPage <= 900 ? declared : null;
}

function packageErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DocxPackageError) {
    switch (error.problem) {
      case 'macro':
        return new AppError('MACRO_DOCUMENT', { cause: error });
      case 'not_docx':
        return new AppError('UNSUPPORTED_FORMAT', { cause: error });
      default:
        return new AppError('CORRUPTED_FILE', { cause: error, detail: error.message });
    }
  }
  return new AppError('CORRUPTED_FILE', { cause: error });
}
