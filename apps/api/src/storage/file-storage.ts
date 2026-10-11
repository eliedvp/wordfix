import { isId } from '../common/ids.js';

/**
 * Stockage privé des fichiers importés. Deux implémentations : disque local en
 * développement, S3 (Cloudflare R2 ou compatible) en production. Le reste de
 * l'application ne connaît que cette interface.
 */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Supprime le fichier ; ne fait rien s'il n'existe déjà plus. */
  delete(key: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

const KEY_PATTERN =
  /^documents\/doc_[0-9a-z]{20}\/(?:source\.docx|exports\/exp_[0-9a-z]{20}\.docx)$/;

/**
 * Clé de stockage d'un document. Le nom choisi par l'utilisateur n'entre jamais
 * dans un chemin : seule la clé générée est utilisée (protection path traversal).
 */
export function sourceKey(documentId: string): string {
  if (!isId('doc', documentId)) throw new Error('Identifiant de document invalide');
  return `documents/${documentId}/source.docx`;
}

/** Clé du document corrigé d'un export (jamais celle de l'original). */
export function exportKey(documentId: string, exportId: string): string {
  if (!isId('doc', documentId) || !isId('exp', exportId)) {
    throw new Error("Identifiant d'export invalide");
  }
  return `documents/${documentId}/exports/${exportId}.docx`;
}

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('Clé de stockage invalide');
}
