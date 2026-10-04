import type {
  AnalysisDto,
  DocumentDto,
  IssueDto,
  IssueListDto,
  IssueStatus,
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
    apiFetch<IssueDto>(`/issues/${id}`, {
      method: 'PATCH',
      ...jsonBody(userText === undefined ? { status } : { status, userText }),
    }),
};

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
