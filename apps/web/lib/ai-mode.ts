import type { AiMode } from '@wordfix/shared';
import { connection } from 'next/server';

/** Adresse interne de l'API, lue côté serveur uniquement (comme les réécritures /api). */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const AI_MODES: ReadonlySet<string> = new Set<AiMode>(['none', 'openai', 'gemini', 'fake']);

/**
 * Mode IA réellement configuré, lu à chaque affichage (jamais figé au build) pour que
 * la page dise ce qui est vraiment fait du texte. null si l'API ne répond pas : la page
 * affiche alors une formulation prudente.
 */
export async function getAiMode(): Promise<AiMode | null> {
  await connection();
  try {
    const response = await fetch(`${API_INTERNAL_URL}/api/ai-mode`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { mode?: unknown };
    return typeof body.mode === 'string' && AI_MODES.has(body.mode) ? (body.mode as AiMode) : null;
  } catch {
    return null;
  }
}
