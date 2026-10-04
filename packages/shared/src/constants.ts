/**
 * Limites et durées du MVP, partagées par le frontend et le backend.
 *
 * Ce sont les valeurs par défaut validées (décisions D6 et D8). Le backend peut
 * les surcharger par variables d'environnement ; le frontend les utilise pour
 * informer l'utilisateur et refuser tôt un fichier manifestement invalide.
 */

/** Taille maximale d'un fichier importé : 20 Mo (D8). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Nombre maximal de mots analysés par document (D8). */
export const MAX_DOCUMENT_WORDS = 60_000;

/** Seule extension acceptée dans le MVP. */
export const ACCEPTED_EXTENSION = '.docx';

/** Type MIME officiel d'un document Word .docx (indice seulement, jamais une preuve). */
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Durée de conservation du fichier source après l'import : 24 h (D6). */
export const SOURCE_FILE_RETENTION_HOURS = 24;

/** Durée de conservation du texte extrait et des résultats : 7 jours (D6). */
export const CONTENT_RETENTION_DAYS = 7;

/** Durée maximale de conservation des sauvegardes de la base : 7 jours (P1). */
export const BACKUP_RETENTION_DAYS = 7;
