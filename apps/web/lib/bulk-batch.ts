'use client';

/**
 * Points acceptés par le dernier « Tout corriger », gardés pour la durée de l'onglet
 * (stockage de session) : ils permettent d'annuler ce « Tout corriger ». Partagé
 * entre le panneau « Corriger » et le panneau « Télécharger » (qui peut lancer
 * « Tout corriger » juste avant l'export) : chaque écriture prévient les abonnés.
 */
const storageKey = (analysisId: string) => `wordfix.bulk.${analysisId}`;
const EVENT = 'wordfix:bulk-batch';

/** Repli si le stockage de session est indisponible (navigation privée stricte). */
const fallback = new Map<string, string>();

/** Valeur brute (texte JSON, ou chaîne vide) : stable entre deux lectures. */
export function batchSnapshot(analysisId: string): string {
  try {
    return window.sessionStorage.getItem(storageKey(analysisId)) ?? '';
  } catch {
    return fallback.get(analysisId) ?? '';
  }
}

export function parseBatch(raw: string): string[] | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string')
      ? value
      : null;
  } catch {
    return null;
  }
}

export function readBatch(analysisId: string): string[] | null {
  return parseBatch(batchSnapshot(analysisId));
}

export function writeBatch(analysisId: string, ids: string[] | null): void {
  const raw = ids && ids.length > 0 ? JSON.stringify(ids) : '';
  try {
    if (raw) window.sessionStorage.setItem(storageKey(analysisId), raw);
    else window.sessionStorage.removeItem(storageKey(analysisId));
  } catch {
    // Stockage indisponible : l'annulation reste possible tant que la page est ouverte.
    fallback.set(analysisId, raw);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: analysisId }));
}

export function subscribeBatch(analysisId: string, listener: () => void): () => void {
  const onChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === analysisId) listener();
  };
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}
