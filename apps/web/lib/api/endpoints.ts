import type {
  AnalysisDto,
  DocumentDto,
  ExportDto,
  IssueListDto,
  IssueStatus,
  UpdatedIssueDto,
} from '@wordfix/shared';
import { ApiError, apiFetch, jsonBody, NETWORK_MESSAGE, parseError } from './client';

export const api = {
  listDocuments: () => apiFetch<DocumentDto[]>('/documents'),
  getDocument: (id: string) => apiFetch<DocumentDto>(`/documents/${id}`),
  deleteDocument: (id: string) => apiFetch<void>(`/documents/${id}`, { method: 'DELETE' }),
  startAnalysis: (documentId: string) =>
    apiFetch<{ analysisId: string }>(`/documents/${documentId}/analyze`, { method: 'POST' }),
  getAnalysis: (id: string) => apiFetch<AnalysisDto>(`/analyses/${id}`),
  cancelAnalysis: (id: string) =>
    apiFetch<AnalysisDto>(`/analyses/${id}/cancel`, { method: 'POST' }),
  listIssues: (analysisId: string) =>
    apiFetch<IssueListDto>(`/analyses/${analysisId}/issues?status=all&limit=1000`),
  updateIssue: (id: string, status: IssueStatus, userText?: string) =>
    apiFetch<UpdatedIssueDto>(`/issues/${id}`, {
      method: 'PATCH',
      ...jsonBody(userText === undefined ? { status } : { status, userText }),
    }),
  /** Demande d'un document corrigé (corrections acceptées ou modifiées, figées). */
  createExport: (analysisId: string) =>
    apiFetch<ExportDto>(`/analyses/${analysisId}/exports`, { method: 'POST' }),
  getExport: (id: string) => apiFetch<ExportDto>(`/exports/${id}`),
  downloadExport: (id: string) => downloadExport(id),
};

export interface DownloadedFile {
  blob: Blob;
  fileName: string;
}

/** Nom du fichier annoncé par Content-Disposition (forme UTF-8 en priorité). */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Encodage invalide : on retombe sur la forme simple.
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null;
}

/**
 * Téléchargement du document corrigé. Le fichier vient toujours de la route d'export
 * (jamais du fichier d'origine). Lu en mémoire avant d'être proposé à l'enregistrement :
 * une erreur (export expiré, pas prêt) s'affiche comme un message, pas comme une page JSON.
 */
async function downloadExport(id: string): Promise<DownloadedFile> {
  let response: Response;
  try {
    response = await fetch(`/api/exports/${id}/download`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0);
  }
  if (!response.ok) throw await parseError(response);
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0);
  }
  return {
    blob,
    fileName:
      fileNameFromDisposition(response.headers.get('Content-Disposition')) ??
      'Document (corrigé).docx',
  };
}

export interface UploadHandle {
  promise: Promise<DocumentDto>;
  abort: () => void;
}

/**
 * Envoi d'un fichier avec suivi réel de la progression (octets envoyés).
 * fetch() ne permet pas encore de suivre l'envoi : on utilise XMLHttpRequest.
 */
export function uploadDocument(file: File, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<DocumentDto>((resolve, reject) => {
    xhr.open('POST', '/api/documents');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const response = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as DocumentDto);
      } else {
        void parseError(response).then(reject);
      }
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0));
    xhr.onabort = () => reject(new DOMException('Envoi annulé', 'AbortError'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
