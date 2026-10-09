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

/**
 * Codes d'échec dus à la seule couche IA (fournisseur indisponible, limite de débit,
 * quota, configuration, réponse invalide). L'IA est un enrichissement facultatif : ces
 * échecs ne font jamais échouer une analyse que le moteur déterministe a pu mener.
 * « bad_request » n'en fait volontairement pas partie : une requête refusée signale un
 * probable bug de WordFix, qui ne doit pas passer pour une simple panne de l'IA.
 */
export const AI_FAILURE_CODES: ReadonlySet<string> = new Set<AiErrorKind>([
  'unavailable',
  'quota',
  'config',
  'invalid_output',
]);

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
