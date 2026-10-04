import { ERROR_CATALOG, MAX_UPLOAD_BYTES } from '@wordfix/shared';

/**
 * Vérifications immédiates dans le navigateur, avant tout envoi. Le serveur
 * refait toutes les vérifications : celles-ci servent seulement à répondre vite.
 */
export function checkFileBeforeUpload(file: { name: string; size: number }): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.doc')) return ERROR_CATALOG.LEGACY_DOC_FORMAT.message;
  if (name.endsWith('.docm')) return ERROR_CATALOG.MACRO_DOCUMENT.message;
  if (!name.endsWith('.docx')) return ERROR_CATALOG.UNSUPPORTED_FORMAT.message;
  if (file.size === 0) return ERROR_CATALOG.CORRUPTED_FILE.message;
  if (file.size > MAX_UPLOAD_BYTES) return ERROR_CATALOG.FILE_TOO_LARGE.message;
  return null;
}
