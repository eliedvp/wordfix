'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IssueListDto, IssueStatus } from '@wordfix/shared';
import { api } from '@/lib/api/endpoints';

export function useIssues(analysisId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['issues', analysisId],
    queryFn: () => api.listIssues(analysisId),
    enabled,
    staleTime: Infinity,
  });
}

/**
 * Décision sur un problème, affichée immédiatement (mise à jour optimiste) puis
 * confirmée par le serveur ; en cas d'échec réseau, l'affichage est rétabli.
 */
export function useUpdateIssue(analysisId: string) {
  const client = useQueryClient();
  const key = ['issues', analysisId];

  return useMutation({
    mutationFn: ({
      id,
      status,
      userText,
    }: {
      id: string;
      status: IssueStatus;
      userText?: string;
    }) => api.updateIssue(id, status, userText),
    onMutate: async ({ id, status, userText }) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<IssueListDto>(key);
      client.setQueryData<IssueListDto>(key, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === id
                  ? { ...item, status, userText: status === 'edited' ? (userText ?? null) : null }
                  : item,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['analysis', analysisId] });
    },
  });
}
