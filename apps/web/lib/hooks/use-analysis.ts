'use client';

import { useQuery } from '@tanstack/react-query';
import { isTerminalStatus } from '@wordfix/shared';
import { api } from '@/lib/api/endpoints';

/** État d'une analyse, interrogé toutes les 2 s tant qu'elle n'est pas terminée (D5). */
export function useAnalysis(id: string) {
  return useQuery({
    queryKey: ['analysis', id],
    queryFn: () => api.getAnalysis(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && isTerminalStatus(data.status) ? false : 2000;
    },
    // Le suivi continue même si l'onglet passe en arrière-plan.
    refetchIntervalInBackground: true,
  });
}
