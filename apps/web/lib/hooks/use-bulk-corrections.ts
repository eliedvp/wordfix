'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnalysisDto, IssueListDto, IssueStatus, ReviewProgressDto } from '@wordfix/shared';
import { api } from '@/lib/api/endpoints';

/** Statut appliqué aux points indiqués, dans la liste en cache (les autres restent inchangés). */
function setStatus(list: IssueListDto | undefined, ids: string[], status: IssueStatus) {
  if (!list) return list;
  const wanted = new Set(ids);
  return {
    ...list,
    items: list.items.map((item) =>
      wanted.has(item.id) ? { ...item, status, userText: null } : item,
    ),
  };
}

/**
 * « Tout corriger » et son annulation. Les réponses du serveur font foi : statuts
 * des points concernés et compteur « points traités » sont écrits dans les caches,
 * puis l'analyse est relue.
 */
export function useBulkCorrections(analysisId: string) {
  const client = useQueryClient();
  const issuesKey = ['issues', analysisId];
  const analysisKey = ['analysis', analysisId];

  const applyProgress = (progress: ReviewProgressDto) =>
    client.setQueryData<AnalysisDto>(analysisKey, (current) =>
      current && current.id === progress.id
        ? { ...current, reviewedCount: progress.reviewedCount, issueCount: progress.issueCount }
        : current,
    );
  const settle = () => {
    void client.invalidateQueries({ queryKey: analysisKey });
    void client.invalidateQueries({ queryKey: ['documents'] });
  };

  const acceptAll = useMutation({
    mutationKey: ['bulk', analysisId, 'accept'],
    mutationFn: () => api.acceptReliable(analysisId),
    onSuccess: (result) => {
      client.setQueryData<IssueListDto>(issuesKey, (list) =>
        setStatus(list, result.acceptedIds, 'accepted'),
      );
      applyProgress(result.analysis);
    },
    onSettled: settle,
  });

  const undo = useMutation({
    mutationKey: ['bulk', analysisId, 'undo'],
    mutationFn: (issueIds: string[]) => api.undoAccept(analysisId, issueIds),
    onSuccess: (result) => {
      client.setQueryData<IssueListDto>(issuesKey, (list) =>
        setStatus(list, result.reopenedIds, 'open'),
      );
      applyProgress(result.analysis);
    },
    onSettled: settle,
  });

  return { acceptAll, undo };
}
