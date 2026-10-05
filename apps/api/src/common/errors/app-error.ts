import { ERROR_CATALOG, type ErrorCode } from '@wordfix/shared';

/**
 * Erreur métier de l'application. Son code correspond à une entrée du catalogue
 * partagé, qui fixe le statut HTTP et le message affiché à l'utilisateur.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, options?: { cause?: unknown; detail?: string }) {
    super(options?.detail ?? ERROR_CATALOG[code].message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
  }
}
