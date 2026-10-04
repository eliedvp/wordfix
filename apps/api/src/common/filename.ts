const MAX_LENGTH = 200;

/**
 * Nettoie le nom de fichier envoyé par le navigateur. Ce nom sert uniquement à
 * l'affichage : il n'est jamais utilisé pour construire un chemin.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const base = (raw ?? '')
    .normalize('NFC')
    // Garde uniquement le nom, sans dossier (certains navigateurs envoient un chemin).
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base || base === '.' || base === '..') return 'document.docx';
  if (base.length <= MAX_LENGTH) return base;

  const dot = base.lastIndexOf('.');
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, MAX_LENGTH - extension.length) + extension;
}
