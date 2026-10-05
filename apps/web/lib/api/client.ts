import { type ApiErrorBody, ERROR_CATALOG, type ErrorCode, isErrorCode } from '@wordfix/shared';

/**
 * Erreur renvoyée par l'API, avec le code du catalogue partagé et un message
 * en français prêt à afficher.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NETWORK_MESSAGE =
  'Connexion impossible. Vérifiez votre accès à Internet puis réessayez.';

export async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    const code = body.error?.code;
    if (isErrorCode(code)) {
      return new ApiError(
        code,
        body.error?.message ?? ERROR_CATALOG[code].message,
        response.status,
      );
    }
  } catch {
    // Réponse non JSON : on retombe sur le message générique.
  }
  return new ApiError('INTERNAL_ERROR', ERROR_CATALOG.INTERNAL_ERROR.message, response.status);
}

/**
 * Appel à l'API du site (même domaine, décision D4) : le cookie de session est
 * envoyé automatiquement ; aucune clé n'existe côté navigateur.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0);
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function jsonBody(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
}
