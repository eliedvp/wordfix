import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponse,
} from '@google/genai';
import type { ZodType } from 'zod';
import {
  AiError,
  type AiProvider,
  type StructuredRequest,
  type StructuredResult,
} from '../ai-provider.js';
import type { RequestRateLimiter } from '../rate-limiter.js';
import { toStrictJsonSchema } from '../strict-json-schema.js';

export interface GeminiAiProviderOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  /** Niveau de réflexion des modèles Gemini 3.x ; null : valeur par défaut du modèle. */
  thinkingLevel: ThinkingLevel | null;
  /**
   * Limiteur partagé par tous les appels du processus (GEMINI_REQUESTS_PER_MINUTE) :
   * chaque requête, nouvel essai compris, attend sa place. Il porte aussi la pause
   * commune après un 429 (voir rate-limiter.ts).
   */
  rateLimiter: RequestRateLimiter;
  /** Journal des limites de débit rencontrées (jamais la clé ni le contenu envoyé). */
  logger?: { warn: (data: Record<string, unknown>, message: string) => void };
  /** Permet aux tests d'intercepter les appels HTTP (aucun appel réseau en test). */
  fetch?: typeof fetch;
}

/** Codes HTTP réessayés par le SDK lui-même (le 429 est traité ici : quota ou débit). */
const SDK_RETRY_STATUSES = [408, 500, 502, 503, 504];
/**
 * Attente maximale acceptée avant un nouvel essai après une limite de débit. Sur
 * l'offre gratuite, Google demande souvent d'attendre 40 à 60 s (quota par minute).
 * Au-delà, ce n'est plus une limite par minute : l'appel échoue (`unavailable`).
 */
export const MAX_RATE_LIMIT_WAIT_MS = 90_000;
/** Attente sans délai indiqué par Google : 2 s, 4 s, 8 s… (plafonnée). */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** Fins de génération qui signifient « pas de réponse exploitable ». */
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
  'IMAGE_SAFETY',
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'OTHER',
]);

/**
 * Fournisseur Google Gemini (SDK officiel @google/genai, API generateContent).
 *
 * Même contrat que OpenAiProvider :
 * - sortie JSON contrainte par le schéma (responseJsonSchema), puis revalidée par zod ;
 *   toute réponse tronquée, bloquée, illisible ou hors schéma lève `invalid_output` ;
 * - les erreurs sont traduites en AiError (config, quota, unavailable) ;
 * - la clé n'est jamais journalisée ni recopiée dans les messages d'erreur.
 *
 * Les règles métier (option obligatoirement parmi les candidats, jamais d'« Erreur »)
 * restent dans le moteur (ambiguity/resolve.ts) : elles s'appliquent à l'identique,
 * quel que soit le fournisseur.
 *
 * generateContent est sans état : Google ne conserve pas de conversation. Attention :
 * sur l'offre gratuite de l'API Gemini, Google peut utiliser les contenus envoyés
 * pour améliorer ses produits (pas sur l'offre payante).
 */
export class GeminiAiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiAiProviderOptions) {
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: {
        timeout: options.timeoutMs,
        retryOptions: {
          attempts: options.maxRetries + 1,
          httpStatusCodes: SDK_RETRY_STATUSES,
        },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const response = await this.callWithRateLimitRetries(request);

    const metadata = response.usageMetadata;
    const usage = {
      inputTokens: metadata?.promptTokenCount ?? 0,
      // La réflexion est facturée comme de la sortie.
      outputTokens: (metadata?.candidatesTokenCount ?? 0) + (metadata?.thoughtsTokenCount ?? 0),
      cachedTokens: metadata?.cachedContentTokenCount ?? 0,
    };

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AiError('invalid_output', `requête bloquée par le fournisseur (${blockReason})`);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new AiError('invalid_output', 'réponse tronquée (limite de jetons atteinte)');
    }
    if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new AiError(
        'invalid_output',
        `réponse interrompue par le fournisseur (${finishReason})`,
      );
    }

    const text = response.text;
    if (!text) throw new AiError('invalid_output', 'réponse vide');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new AiError('invalid_output', 'réponse JSON illisible', { cause: error });
    }

    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new AiError(
        'invalid_output',
        `réponse hors schéma : ${parsed.error.message.slice(0, 300)}`,
      );
    }
    return { data: parsed.data, usage };
  }

  /**
   * Chaque requête attend sa place dans le limiteur partagé. Le SDK réessaie seul les
   * pannes temporaires (5xx, délai). Le 429 est traité ici :
   * - quota quotidien épuisé → `quota`, sans nouvel essai ;
   * - limite de débit (par minute) → pause commune de la durée indiquée par Google
   *   (`retryDelay`), ou attente croissante (2 s, 4 s, 8 s…) s'il n'en indique pas,
   *   puis nouvel essai, au plus maxRetries fois ; ensuite `unavailable`.
   * La pause s'applique à tous les appels du processus, même quand cet appel-ci
   * abandonne : les autres morceaux n'épuisent pas le quota en réessayant aussitôt.
   */
  private async callWithRateLimitRetries<T>(
    request: StructuredRequest<T>,
  ): Promise<GenerateContentResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.options.rateLimiter.acquire();
      try {
        return await this.client.models.generateContent({
          model: request.model,
          contents: request.input,
          config: {
            systemInstruction: request.instructions,
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: toGeminiJsonSchema(request.schema),
            ...(this.options.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: this.options.thinkingLevel } }
              : {}),
          },
        });
      } catch (error) {
        const translated = translateGeminiError(error);
        const wait = rateLimitDelay(error, attempt);
        if (wait === null) throw translated;
        const retry = attempt < this.options.maxRetries && wait <= MAX_RATE_LIMIT_WAIT_MS;
        this.options.rateLimiter.pause(Math.min(wait, MAX_RATE_LIMIT_WAIT_MS));
        this.options.logger?.warn(
          { model: request.model, attempt: attempt + 1, waitMs: wait, retry },
          retry
            ? 'Limite de débit Gemini (429) : pause commune avant un nouvel essai'
            : 'Limite de débit Gemini (429) : abandon de cet appel',
        );
        if (!retry) throw translated;
      }
    }
  }
}

/** Niveau de réflexion Gemini correspondant à AI_REASONING_EFFORT. */
export function geminiThinkingLevel(
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high',
): ThinkingLevel {
  // « minimal » n'existe pas sur tous les modèles (refusé par gemini-3.8-flash) :
  // le niveau le plus bas accepté partout est LOW.
  if (effort === 'medium') return ThinkingLevel.MEDIUM;
  if (effort === 'high') return ThinkingLevel.HIGH;
  return ThinkingLevel.LOW;
}

/**
 * Schéma JSON accepté par Gemini : le même schéma strict que pour OpenAI, avec les
 * valeurs facultatives écrites `{"type": ["string", "null"]}` (forme documentée par
 * Google) plutôt que `anyOf`.
 */
export function toGeminiJsonSchema(schema: ZodType): Record<string, unknown> {
  return nullableAsTypeArray(toStrictJsonSchema(schema)) as Record<string, unknown>;
}

function nullableAsTypeArray(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(nullableAsTypeArray);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, nullableAsTypeArray(v)]),
  );
  const anyOf = out.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nullIndex = anyOf.findIndex((m) => (m as { type?: unknown })?.type === 'null');
    const other = anyOf[1 - nullIndex] as Record<string, unknown> | undefined;
    if (nullIndex >= 0 && other && typeof other.type === 'string') {
      delete out.anyOf;
      const merged: Record<string, unknown> = { ...other, ...out, type: [other.type, 'null'] };
      if (Array.isArray(other.enum)) merged.enum = [...(other.enum as unknown[]), null];
      return merged;
    }
  }
  return out;
}

interface GoogleErrorBody {
  error?: {
    message?: string;
    status?: string;
    details?: {
      '@type'?: string;
      retryDelay?: string;
      violations?: { quotaId?: string }[];
      reason?: string;
    }[];
  };
}

function errorBody(error: ApiError): GoogleErrorBody {
  try {
    return JSON.parse(error.message) as GoogleErrorBody;
  } catch {
    return {};
  }
}

/** Quota quotidien (ou de facturation) épuisé : inutile de réessayer aujourd'hui. */
function isDailyQuota(body: GoogleErrorBody): boolean {
  const violations = body.error?.details?.flatMap((d) => d.violations ?? []) ?? [];
  return violations.some((v) => /PerDay/i.test(v.quotaId ?? ''));
}

/**
 * Attente demandée après une limite de débit (429 par minute) : le `retryDelay` de
 * Google s'il est indiqué, sinon 2 s, 4 s, 8 s… selon l'essai. null : pas une limite
 * de débit (autre erreur, ou quota quotidien épuisé).
 */
export function rateLimitDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const body = errorBody(error);
  if (isDailyQuota(body)) return null;
  const retryDelay = body.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const seconds = retryDelay ? Number.parseFloat(retryDelay) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export function translateGeminiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof ApiError) {
    const status = error.status;
    const body = errorBody(error);
    if (status === 401 || status === 403 || status === 404) {
      return new AiError('config', `configuration refusée (${status})`, { cause: error });
    }
    if (status === 429) {
      return isDailyQuota(body)
        ? new AiError('quota', 'quota du fournisseur épuisé', { cause: error })
        : new AiError('unavailable', 'limite de débit du fournisseur atteinte (429)', {
            cause: error,
          });
    }
    if (status === 400) {
      // Définitif (configuration) : clé invalide, ou compte/région non autorisés
      // (FAILED_PRECONDITION, ex. « User location is not supported »).
      if (body.error?.details?.some((d) => d.reason === 'API_KEY_INVALID')) {
        return new AiError('config', 'clé refusée par le fournisseur (400)', { cause: error });
      }
      if (body.error?.status === 'FAILED_PRECONDITION') {
        return new AiError('config', 'compte ou région non autorisés par le fournisseur (400)', {
          cause: error,
        });
      }
    }
    if (status >= 400 && status < 500 && status !== 408) {
      // Toute autre requête refusée (paramètre ou schéma invalide, entrée trop longue…) :
      // probable bug de WordFix, distingué d'une indisponibilité et jamais masqué.
      return new AiError('bad_request', `requête refusée par le fournisseur (${status})`, {
        cause: error,
      });
    }
    return new AiError('unavailable', `fournisseur indisponible (${status})`, { cause: error });
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new AiError('unavailable', 'délai de réponse dépassé', { cause: error });
  }
  if (error instanceof TypeError) {
    return new AiError('unavailable', 'connexion au fournisseur impossible', { cause: error });
  }
  return new AiError('unavailable', 'erreur inattendue du fournisseur', { cause: error });
}
