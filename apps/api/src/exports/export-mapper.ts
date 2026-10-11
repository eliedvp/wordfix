import type { ExportDto, ExportSkipReason } from '@wordfix/shared';
import { isErrorCode } from '@wordfix/shared';
import type { Export } from '../generated/prisma/client.js';
import type { TextEdit } from '../docx/writer/text-edits.js';

/** Correction figée à la création d'un export : `id` est l'identifiant du point (Issue). */
export type FrozenEdit = TextEdit;

export function toExportDto(row: Export): ExportDto {
  return {
    id: row.id,
    analysisId: row.analysisId,
    status: row.status,
    requestedCount: row.requestedCount,
    appliedCount: row.appliedCount,
    skipped: row.skipped as { issueId: string; reason: ExportSkipReason }[],
    errorCode: isErrorCode(row.errorCode) ? row.errorCode : row.errorCode ? 'EXPORT_FAILED' : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Nom proposé pour le document corrigé : « Rapport (corrigé).docx ». */
export function correctedFileName(originalName: string): string {
  const base = originalName.replace(/\.docx$/i, '').trim() || 'document';
  return `${base} (corrigé).docx`;
}

/**
 * En-tête Content-Disposition d'un téléchargement : nom ASCII de repli, puis nom
 * exact en UTF-8 (RFC 6266 / RFC 5987). Aucun caractère de contrôle ni guillemet.
 */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._()-]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
