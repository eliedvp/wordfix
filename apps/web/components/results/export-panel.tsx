'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalysisDto, ExportDto, IssueDto } from '@wordfix/shared';
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, NETWORK_MESSAGE } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import {
  decisionsSignature,
  exportableIssues,
  exportFailureText,
  isActiveExport,
  isRetryableFailure,
  readStoredExport,
  replacementOf,
  saveFile,
  SKIP_REASON_TEXTS,
  type StoredExport,
  writeStoredExport,
} from '@/lib/export';
import { formatDate } from '@/lib/format';
import { useExport } from '@/lib/hooks/use-export';
import { cn } from '@/lib/utils';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : NETWORK_MESSAGE;
}

/**
 * Document corrigé : génération à la demande (corrections acceptées ou modifiées
 * appliquées à une copie du fichier Word), suivi de la génération, téléchargement
 * du seul fichier produit, et compte rendu des corrections non applicables.
 * Le fichier d'origine n'est jamais proposé à la place du document corrigé.
 */
export function ExportPanel({ analysis, issues }: { analysis: AnalysisDto; issues: IssueDto[] }) {
  const client = useQueryClient();

  // Dernier export demandé : relu après un rechargement (aucune route ne liste les exports).
  // (Rendu côté navigateur seulement : l'espace de relecture attend les données de l'API.)
  const [stored, setStored] = useState<StoredExport | null>(() =>
    typeof window === 'undefined' ? null : readStoredExport(analysis.id),
  );
  const remember = useCallback(
    (value: StoredExport | null) => {
      writeStoredExport(analysis.id, value);
      setStored(value);
    },
    [analysis.id],
  );

  const documentQuery = useQuery({
    queryKey: ['document', analysis.documentId],
    queryFn: () => api.getDocument(analysis.documentId),
    staleTime: 60_000,
    retry: false,
    // Vérification impossible (coupure, limite de débit) : nouvel essai automatique.
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false),
  });
  const query = useExport(stored?.id ?? null);
  // Export introuvable (supprimé avec son document, autre session) : il est oublié.
  const lost = query.error instanceof ApiError && query.error.status === 404;
  useEffect(() => {
    if (lost) writeStoredExport(analysis.id, null);
  }, [lost, analysis.id]);
  const exportQuery = query;
  const exportError = lost ? null : query.error;
  const current: ExportDto | undefined = lost ? undefined : query.data;
  const tracked = lost ? null : stored;

  // Heure courante, rafraîchie chaque minute : un document expiré n'est plus proposé.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const eligible = useMemo(() => exportableIssues(issues), [issues]);
  const signature = useMemo(() => decisionsSignature(issues), [issues]);
  // Une décision encore en cours d'enregistrement ne doit pas manquer au document figé.
  const savingDecisions = useIsMutating() > 0;

  const [requestError, setRequestError] = useState<string | null>(null);
  const create = useMutation<ExportDto, unknown, string>({
    mutationFn: () => api.createExport(analysis.id),
    onMutate: () => setRequestError(null),
    onSuccess: (dto, usedSignature) => {
      client.setQueryData(['export', dto.id], dto);
      remember({ id: dto.id, signature: usedSignature });
    },
    onError: (error) => setRequestError(messageOf(error)),
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: (id: string) => api.downloadExport(id),
    onMutate: () => setDownloadError(null),
    onSuccess: ({ blob, fileName }) => saveFile(blob, fileName),
    onError: (error) => {
      setDownloadError(messageOf(error));
      void exportQuery.refetch();
    },
  });

  // Fichier d'origine : la génération n'est possible que s'il est confirmé disponible.
  const fileState: 'available' | 'deleted' | 'checking' | 'unknown' = documentQuery.data
    ? documentQuery.data.fileAvailable
      ? 'available'
      : 'deleted'
    : documentQuery.isError
      ? 'unknown'
      : 'checking';
  // Export suivi dont l'état n'est pas (encore) connu : aucune nouvelle demande, qui
  // consommerait le quota pour un export peut-être déjà prêt ou en cours.
  const exportUnknown = tracked !== null && current === undefined;
  const stale = Boolean(current && tracked && tracked.signature !== signature);
  const expired = Boolean(
    current?.status === 'READY' && new Date(current.expiresAt).getTime() <= now,
  );
  const ready = current?.status === 'READY' && !expired;
  const failed = current?.status === 'FAILED';
  const active = isActiveExport(current) || create.isPending;

  const showRequest =
    !active &&
    !exportUnknown &&
    fileState !== 'deleted' &&
    (!current || stale || expired || (failed && isRetryableFailure(current.errorCode)));
  const canRequest =
    showRequest && fileState === 'available' && eligible.length > 0 && !savingDecisions;
  const requestLabel = !current
    ? 'Générer le document corrigé'
    : failed && !stale
      ? 'Réessayer'
      : 'Générer une nouvelle version';

  let status: ReactNode;
  if (exportUnknown && exportQuery.isPending) {
    status = <Progress text="Chargement du document corrigé…" />;
  } else if (exportUnknown) {
    status = (
      <Notice tone="error" icon={<TriangleAlert />}>
        <p className="font-semibold">
          L’état de votre document corrigé n’a pas pu être récupéré pour le moment.
        </p>
        <p className="mt-0.5">{messageOf(exportError)}</p>
        <p className="mt-0.5">
          Nouvel essai automatique en cours. Aucune nouvelle demande n’est envoyée tant que cet état
          reste inconnu.
        </p>
        <Button
          className="mt-2"
          size="sm"
          variant="secondary"
          onClick={() => void exportQuery.refetch()}
          disabled={exportQuery.isFetching}
        >
          <RefreshCw aria-hidden />
          Récupérer l’état maintenant
        </Button>
      </Notice>
    );
  } else if (active) {
    status = (
      <Progress
        text={
          current?.status === 'RUNNING'
            ? 'Génération du document corrigé…'
            : 'Demande enregistrée : en attente de génération…'
        }
        detail={
          current
            ? `${plural(current.requestedCount, 'correction', 'corrections')} à appliquer. Cela prend en général quelques secondes.`
            : undefined
        }
      />
    );
  } else if (ready && current) {
    status = (
      <Notice tone="success" icon={<CircleCheck />}>
        <p className="font-semibold">
          Document corrigé prêt : {current.appliedCount} sur{' '}
          {plural(current.requestedCount, 'correction appliquée', 'corrections appliquées')}.
        </p>
        <p className="mt-0.5">
          Téléchargeable jusqu’au {formatDate(current.expiresAt)}. Relisez-le dans Word avant de
          l’envoyer.
        </p>
      </Notice>
    );
  } else if (expired) {
    status = (
      <Notice tone="neutral" icon={<CircleAlert />}>
        Ce document corrigé n’est plus disponible (conservation de 24 h après l’import).
      </Notice>
    );
  } else if (failed && current) {
    status = (
      <Notice tone="error" icon={<TriangleAlert />}>
        <p className="font-semibold">Aucun document corrigé n’a été produit.</p>
        <p className="mt-0.5">{exportFailureText(current.errorCode)}</p>
        {current.errorCode === 'EXPORT_NO_APPLICABLE' && !stale ? (
          <p className="mt-0.5">
            Corrigez ces passages directement dans Word, ou modifiez vos choix puis générez une
            nouvelle version.
          </p>
        ) : null}
      </Notice>
    );
  } else if (fileState === 'deleted') {
    status = (
      <Notice tone="neutral" icon={<CircleAlert />}>
        Votre fichier d’origine a été supprimé (24 h après l’import) : le document corrigé ne peut
        plus être produit. Vos choix restent consultables ici.
      </Notice>
    );
  } else if (eligible.length === 0) {
    status = (
      <p className="text-ink-subtle text-sm">
        Acceptez ou modifiez au moins un point pour générer un document corrigé. Les points ignorés,
        vérifiés ou non traités ne sont jamais appliqués.
      </p>
    );
  } else {
    status = (
      <p className="text-ink-muted text-sm">
        {plural(
          eligible.length,
          'correction acceptée ou modifiée sera appliquée',
          'corrections acceptées ou modifiées seront appliquées',
        )}{' '}
        à une copie de votre fichier.
      </p>
    );
  }

  return (
    <section
      aria-labelledby="export-title"
      className="border-hairline bg-surface rounded-card mt-6 border p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-brand-soft text-brand-deep rounded-control grid size-10 shrink-0 place-items-center">
            <FileText className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="export-title" className="font-display text-ink text-lg font-semibold">
              Document corrigé
            </h2>
            <p className="text-ink-subtle text-sm">
              Vos corrections acceptées ou modifiées, appliquées à une copie de votre fichier Word.
              Votre fichier d’origine n’est jamais modifié.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ready && current ? (
            <Button
              variant={stale ? 'secondary' : 'primary'}
              onClick={() => download.mutate(current.id)}
              disabled={download.isPending}
            >
              {download.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Download aria-hidden />
              )}
              {stale ? 'Télécharger la version précédente' : 'Télécharger le document corrigé'}
            </Button>
          ) : null}
          {showRequest ? (
            <Button onClick={() => create.mutate(signature)} disabled={!canRequest}>
              {current ? <RefreshCw aria-hidden /> : <FileText aria-hidden />}
              {requestLabel}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-3" aria-live="polite">
        {status}
        {showRequest && fileState === 'checking' ? (
          <Progress text="Vérification de la disponibilité de votre fichier d’origine…" />
        ) : null}
        {showRequest && fileState === 'unknown' ? (
          <Notice tone="error" icon={<TriangleAlert />}>
            <p className="font-semibold">
              La disponibilité de votre fichier d’origine n’a pas pu être vérifiée.
            </p>
            <p className="mt-0.5">
              La génération reste désactivée tant qu’elle n’est pas confirmée. Nouvel essai
              automatique en cours.
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="secondary"
              onClick={() => void documentQuery.refetch()}
              disabled={documentQuery.isFetching}
            >
              <RefreshCw aria-hidden />
              Vérifier maintenant
            </Button>
          </Notice>
        ) : null}
        {stale && ready ? (
          <Notice tone="warning" icon={<TriangleAlert />}>
            Vos choix ont changé depuis la génération de ce document : il ne les reflète plus.
            {eligible.length > 0
              ? ' Générez une nouvelle version pour les appliquer.'
              : ' Aucune correction n’est plus choisie.'}
          </Notice>
        ) : null}
        {requestError ? (
          <Notice tone="error" icon={<TriangleAlert />}>
            {requestError}
          </Notice>
        ) : null}
        {downloadError ? (
          <Notice tone="error" icon={<TriangleAlert />}>
            {downloadError}
          </Notice>
        ) : null}
        {exportError && !exportUnknown ? (
          <Notice tone="error" icon={<TriangleAlert />}>
            {messageOf(exportError)}
          </Notice>
        ) : null}
      </div>

      {current && !active && current.skipped.length > 0 ? (
        <SkippedList skipped={current.skipped} issues={issues} />
      ) : null}
    </section>
  );
}

function Progress({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="text-ink-muted flex items-start gap-2 text-sm" role="status">
      <LoaderCircle className="text-brand mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
      <div>
        <p className="text-ink font-medium">{text}</p>
        {detail ? <p className="text-ink-subtle mt-0.5">{detail}</p> : null}
      </div>
    </div>
  );
}

const TONES = {
  success: 'border-emerald-200 bg-brand-soft text-brand-deep',
  error: 'border-rose-200 bg-nature-error-soft text-rose-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  neutral: 'border-hairline bg-canvas text-ink-muted',
} as const;

function Notice({
  tone,
  icon,
  children,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-control flex items-start gap-2 border px-4 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        TONES[tone],
      )}
    >
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SkippedList({ skipped, issues }: { skipped: ExportDto['skipped']; issues: IssueDto[] }) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  return (
    <details className="border-hairline rounded-control mt-4 border" open={skipped.length <= 5}>
      <summary className="text-ink cursor-pointer px-4 py-2.5 text-sm font-semibold">
        {plural(skipped.length, 'correction non appliquée', 'corrections non appliquées')} — à
        reporter à la main dans Word si besoin
      </summary>
      <ul className="divide-hairline border-hairline divide-y border-t">
        {skipped.map(({ issueId, reason }) => {
          const issue = byId.get(issueId);
          const replacement = issue ? replacementOf(issue) : null;
          return (
            <li key={issueId} className="px-4 py-2.5 text-sm">
              {issue ? (
                <p className="text-ink break-words">
                  <span className="line-through decoration-rose-400">{issue.original}</span>
                  {replacement !== null ? (
                    <>
                      {' '}
                      → <span className="font-medium">{replacement}</span>
                    </>
                  ) : null}
                </p>
              ) : null}
              <p className="text-ink-subtle mt-0.5">{SKIP_REASON_TEXTS[reason]}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
