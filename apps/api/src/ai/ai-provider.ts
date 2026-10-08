import type { ZodType } from 'zod';

/**
 * Abstraction du fournisseur d'IA. Le moteur d'analyse ne connaît que cette
 * interface : ajouter un autre fournisseur (Anthropic, Google, modèle local) se
 * fait en écrivant une nouvelle implémentation, sans toucher au moteur.
 */
export interface StructuredRequest<T> {
  model: string;
  /** Consignes système (identiques d'un appel à l'autre : profitent du cache). */
  instructions: string;
  /** Contenu à analyser. */
  input: string;
  schema: ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: TokenUsage;
}

export interface AiProvider {
  readonly name: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export type AiErrorKind =
  /** Indisponibilité temporaire (réseau, 429, 5xx, délai dépassé). */
  | 'unavailable'
  /** Quota ou crédit épuisé chez le fournisseur. */
  | 'quota'
  /** Clé absente ou invalide, modèle inconnu : inutile de réessayer. */
  | 'config'
  /** Réponse hors schéma ou tronquée. */
  | 'invalid_output'
  /**
   * Requête refusée par le fournisseur pour une autre raison que la clé ou le modèle
   * (paramètre invalide, schéma refusé, entrée trop longue…) : probable bug de WordFix,
   * à rendre visible plutôt qu'à confondre avec une indisponibilité de l'IA.
   */
  | 'bad_request';

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiError';
  }

  /** Une nouvelle tentative a-t-elle une chance de réussir ? */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'invalid_output';
  }
}
