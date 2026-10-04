import OpenAI, { APIConnectionError, APIError } from 'openai';
import {
  AiError,
  type AiProvider,
  type StructuredRequest,
  type StructuredResult,
} from '../ai-provider.js';
import { toStrictJsonSchema } from '../strict-json-schema.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | null;
  /** Permet aux tests d'intercepter les appels HTTP. */
  fetch?: typeof fetch;
}

/**
 * Fournisseur OpenAI (API Responses, sorties structurées strictes).
 *
 * - `store: false` : OpenAI ne conserve pas la réponse dans son historique d'API.
 * - Le SDK réessaie seul les erreurs temporaires (429, 5xx, délai) avec une
 *   attente croissante ; les erreurs sont ensuite traduites en AiError.
 * - La clé n'est jamais journalisée.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let response: Awaited<ReturnType<OpenAI['responses']['create']>>;
    try {
      response = await this.client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        max_output_tokens: request.maxOutputTokens,
        ...(this.options.reasoningEffort
          ? { reasoning: { effort: this.options.reasoningEffort } }
          : {}),
        text: {
          format: {
            type: 'json_schema',
            name: request.schemaName,
            schema: toStrictJsonSchema(request.schema),
            strict: true,
          },
        },
      });
    } catch (error) {
      throw translateError(error);
    }

    const usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    };

    if (response.status === 'incomplete') {
      throw new AiError('invalid_output', 'réponse tronquée (limite de jetons atteinte)');
    }

    let json: unknown;
    try {
      json = JSON.parse(response.output_text);
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
}

function translateError(error: unknown): AiError {
  if (error instanceof APIConnectionError) {
    return new AiError('unavailable', 'connexion au fournisseur impossible', { cause: error });
  }
  if (error instanceof APIError) {
    const status: number = typeof error.status === 'number' ? error.status : 0;
    if (status === 401 || status === 403 || status === 404) {
      return new AiError('config', `configuration refusée (${status})`, { cause: error });
    }
    if (status === 429 && /quota|billing|insufficient/i.test(error.message)) {
      return new AiError('quota', 'quota du fournisseur épuisé', { cause: error });
    }
    if (status === 400) {
      return new AiError('config', 'requête refusée par le fournisseur (400)', { cause: error });
    }
    return new AiError('unavailable', `fournisseur indisponible (${status})`, { cause: error });
  }
  return new AiError('unavailable', 'erreur inattendue du fournisseur', { cause: error });
}
