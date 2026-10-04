import { Logger } from '@nestjs/common';
import type { DocumentModel } from '@wordfix/shared';
import { AppError } from '../common/errors/app-error.js';
import { DocxPackageError } from './package-reader.js';
import { parseDocx } from './parser/docx-parser.js';
import { parseWithMammoth } from './parser/mammoth-fallback.js';

const logger = new Logger('ExtractDocument');

export interface ExtractionResult {
  model: DocumentModel;
  /** Vrai si le lecteur principal a échoué et que Mammoth a pris le relais. */
  usedFallback: boolean;
}

/**
 * Extraction structurée d'un .docx (décision D1) : lecteur XML ciblé en premier,
 * Mammoth en secours si le lecteur principal échoue sur un document inhabituel.
 * Un fichier invalide ou dangereux n'a jamais droit au secours.
 */
export async function extractDocument(buffer: Buffer): Promise<ExtractionResult> {
  try {
    return { model: await parseDocx(buffer), usedFallback: false };
  } catch (error) {
    if (error instanceof DocxPackageError) {
      throw new AppError(error.problem === 'macro' ? 'MACRO_DOCUMENT' : 'CORRUPTED_FILE', {
        cause: error,
      });
    }
    logger.warn({ err: error }, 'Lecteur principal en échec, passage au mode secours (Mammoth)');
  }

  try {
    return { model: await parseWithMammoth(buffer), usedFallback: true };
  } catch (error) {
    throw new AppError('CORRUPTED_FILE', { cause: error });
  }
}
