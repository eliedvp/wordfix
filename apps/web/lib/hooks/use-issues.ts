'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalysisDto,
  IssueDto,
  IssueListDto,
  IssueStatus,
  UpdatedIssueDto,
} from '@wordfix/shared';
import { useRef } from 'react';
import { api } from '@/lib/api/endpoints';

export function useIssues(analysisId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['issues', analysisId],
    queryFn: () => api.listIssues(analysisId),
    enabled,
    staleTime: Infinity,
  });
}

/** Remplace un problème de la liste en cache (les autres restent inchangés). */
function replaceItem(
  list: IssueListDto | undefined,
  id: string,
  change: (item: IssueDto) => IssueDto,
): IssueListDto | undefined {
  return list
    ? { ...list, items: list.items.map((item) => (item.id === id ? change(item) : item)) }
    : list;
}

/**
 * Avancement de la relecture joint à la réponse du PATCH, s'il est présent et bien
 * formé. Une API qui ne l'envoie pas (version antérieure, déploiement en cours) ne
 * fait pas échouer une décision enregistrée : le compteur est alors relu.
 */
export function reviewProgressOf(
  response: Partial<Pick<UpdatedIssueDto, 'analysis'>>,
): UpdatedIssueDto['analysis'] | null {
  const progress = response.analysis;
  return progress &&
    typeof progress.id === 'string' &&
    Number.isInteger(progress.reviewedCount) &&
    Number.isInteger(progress.issueCount)
    ? progress
    : null;
}

/** Le problème enregistré, sans l'avancement joint à la réponse. */
function issueOf(response: UpdatedIssueDto): IssueDto {
  const { analysis, ...issue } = response;
  void analysis;
  return issue;
}

/**
 * Décision sur un problème, affichée immédiatement (mise à jour optimiste) puis
 * confirmée par le serveur :
 * - la réponse du PATCH porte le problème enregistré et le compteur « points
 *   traités » recompté par le serveur avec la décision : ils sont écrits dans les
 *   caches, sans dépendre d'une seconde requête ;
 * - si plusieurs décisions se suivent, seule la réponse de la plus récente est écrite
 *   (une réponse plus ancienne, arrivée en retard, ne rétablit pas un ancien statut
 *   et ne fait pas reculer le compteur) ;
 * - en cas d'échec, seul ce problème retrouve son état précédent : les décisions
 *   prises entre-temps sur d'autres problèmes sont conservées ;
 * - dans tous les cas, l'analyse est ensuite relue sur le serveur (voir useAnalysis :
 *   une relecture qui échoue est retentée).
 * Une décision que le serveur a enregistrée (PATCH réussi) n'est jamais présentée
 * comme un échec : si la réponse ne contient pas le compteur, seul le compteur
 * attend la relecture de l'analyse.
 */
export function useUpdateIssue(analysisId: string) {
  const client = useQueryClient();
  const issuesKey = ['issues', analysisId];
  const analysisKey = ['analysis', analysisId];
  /** Numéro de la dernière décision envoyée pour cette analyse. */
  const latest = useRef(0);

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
      await client.cancelQueries({ queryKey: issuesKey });
      const previous = client
        .getQueryData<IssueListDto>(issuesKey)
        ?.items.find((item) => item.id === id);
      client.setQueryData<IssueListDto>(issuesKey, (current) =>
        replaceItem(current, id, (item) => ({
          ...item,
          status,
          userText: status === 'edited' ? (userText ?? null) : null,
        })),
      );
      return { previous, sequence: ++latest.current };
    },
    onSuccess: (updated, _vars, context) => {
      // Une décision plus récente est en cours : c'est sa réponse qui fera foi (sinon une
      // réponse en retard pourrait rétablir un ancien statut ou faire reculer le compteur).
      if (context.sequence !== latest.current) return;
      const progress = reviewProgressOf(updated);
      const issue = issueOf(updated);
      client.setQueryData<IssueListDto>(issuesKey, (current) =>
        replaceItem(current, issue.id, () => issue),
      );
      if (!progress) return;
      client.setQueryData<AnalysisDto>(analysisKey, (current) =>
        current && current.id === progress.id
          ? { ...current, reviewedCount: progress.reviewedCount, issueCount: progress.issueCount }
          : current,
      );
    },
    onError: (_error, { id }, context) => {
      const previous = context?.previous;
      if (previous)
        client.setQueryData<IssueListDto>(issuesKey, (current) =>
          replaceItem(current, id, () => previous),
        );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: analysisKey });
      // Résumé de l'historique (« x/y points traités ») : relu à sa prochaine ouverture.
      void client.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}
