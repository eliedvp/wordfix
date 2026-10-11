'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { isActiveExport } from '@/lib/export';

export const EXPORT_POLL_INTERVAL_MS = 1500;

/**
 * État d'un document corrigé, interrogé toutes les 1,5 s tant qu'il est en attente
 * ou en cours de génération. Une erreur passagère est retentée au même rythme ;
 * un export introuvable (404 : supprimé, autre session) ne l'est pas.
 */
export function useExport(id: string | null) {
  return useQuery({
    queryKey: ['export', id],
    queryFn: () => api.getExport(id ?? ''),
    enabled: id !== null,
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error instanceof ApiError && error.status === 404) return false;
      if (query.state.status === 'error') return EXPORT_POLL_INTERVAL_MS;
      return isActiveExport(query.state.data) ? EXPORT_POLL_INTERVAL_MS : false;
    },
    refetchIntervalInBackground: true,
    retry: false,
  });
}
