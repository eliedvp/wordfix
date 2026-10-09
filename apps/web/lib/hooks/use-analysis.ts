'use client';

import { useQuery } from '@tanstack/react-query';
import { isTerminalStatus } from '@wordfix/shared';
import { ApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

/** Nouvel essai d'une relecture échouée sur une analyse terminée (limite de débit, coupure). */
export const ANALYSIS_RECOVERY_INTERVAL_MS = 5000;

/**
 * État d'une analyse, interrogé toutes les 2 s tant qu'elle n'est pas terminée (D5).
 * Une fois terminée, elle n'est plus interrogée, sauf si sa dernière relecture a
 * échoué (après une décision, par exemple) : elle est alors retentée jusqu'à
 * réussir, pour que le compteur « points traités » ne reste jamais figé sur une
 * valeur périmée. Une analyse introuvable (404) n'est pas retentée.
 */
export function useAnalysis(id: string) {
  return useQuery({
    queryKey: ['analysis', id],
    queryFn: () => api.getAnalysis(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !isTerminalStatus(data.status)) return 2000;
      const error = query.state.error;
      const notFound = error instanceof ApiError && error.status === 404;
      return query.state.status === 'error' && !notFound ? ANALYSIS_RECOVERY_INTERVAL_MS : false;
    },
    // Le suivi continue même si l'onglet passe en arrière-plan.
    refetchIntervalInBackground: true,
  });
}
