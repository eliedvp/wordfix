'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AnalysisDto,
  type ExportDto,
  type ExportOptions,
  type IssueDto,
  isReliableCorrection,
} from '@wordfix/shared';
import {
  CircleAlert,
  CircleCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, NETWORK_MESSAGE } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { writeBatch } from '@/lib/bulk-batch';
import {
  decisionsSignature,
  exportableIssues,
  exportFailureText,
  isActiveExport,
  isRetryableFailure,
  readStoredExport,
  replacementOf,
  requestSignature,
  saveFile,
  SKIP_REASON_TEXTS,
  type StoredExport,
  writeStoredExport,
} from '@/lib/export';
import { formatDate } from '@/lib/format';
import { useBulkCorrections } from '@/lib/hooks/use-bulk-corrections';
import { useExport } from '@/lib/hooks/use-export';
import { cn } from '@/lib/utils';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export const DOWNLOAD_LABEL = 'Télécharger les modifications';
export const NO_OPTIONS: ExportOptions = { typography: false, layout: false };

/** Libellés des options de mise en forme (panneau « Mise en forme »). */
export const FORMATTING_LABELS: Record<keyof ExportOptions, string> = {
  typography: 'Typographie française',
  layout: 'Harmonisation de la présentation',
};

/** Points qui demandent une vérification de l'utilisateur : jamais appliqués d'office. */
export function needsManualCheck(issue: IssueDto): boolean {
  return issue.status === 'open' && (issue.nature === 'potential' || issue.nature === 'verify');
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : NETWORK_MESSAGE;
}

/**
 * « Télécharger les modifications » : un seul bouton produit le document Word final.
 * - Si « Inclure les corrections fiables » est cochée, « Tout corriger » est d'abord
 *   exécuté (même règle partagée, mêmes statuts visibles, annulable dans « Corriger »).
 *   Les suggestions incertaines ne sont jamais appliquées d'office.
 * - Les corrections acceptées ou modifiées, puis la mise en forme choisie, sont
 *   appliquées à une copie du fichier ; la préparation est suivie et le fichier est
 *   téléchargé automatiquement dès qu'il est prêt (une seule fois). Le bouton relance
 *   le téléchargement si le navigateur l'a bloqué.
 * - Le fichier d'origine n'est jamais proposé à la place du document corrigé.
 */
export function ExportPanel({
  analysis,
  issues,
  options = NO_OPTIONS,
  onEditFormatting,
  onShowManual,
}: {
  analysis: AnalysisDto;
  issues: IssueDto[];
  /** Mise en forme choisie dans le panneau « Mise en forme ». */
  options?: ExportOptions;
  onEditFormatting?: () => void;
  /** Affiche les points à vérifier manuellement (panneau « Corriger », filtré). */
  onShowManual?: () => void;
}) {
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
  const reliable = useMemo(() => issues.filter(isReliableCorrection).length, [issues]);
  const manual = useMemo(() => issues.filter(needsManualCheck).length, [issues]);
  // Corrections fiables encore à traiter : incluses par défaut (case cochée).
  const [includeReliable, setIncludeReliable] = useState(true);
  const pending = includeReliable ? reliable : 0;
  const beautify = options.typography || options.layout;
  const signature = useMemo(
    () => requestSignature(decisionsSignature(issues), options),
    [issues, options],
  );
  // Une décision encore en cours d'enregistrement ne doit pas manquer au document figé.
  const savingDecisions = useIsMutating() > 0;

  const { acceptAll } = useBulkCorrections(analysis.id);
  const [acceptedNotice, setAcceptedNotice] = useState<number | null>(null);

  // Document demandé par le bouton (et choix de la demande) : téléchargé automatiquement
  // dès qu'il est prêt, si les choix affichés sont toujours ceux de la demande.
  const autoDownload = useRef<{ id: string; signature: string } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const create = useMutation<ExportDto, unknown, string>({
    mutationFn: () => api.createExport(analysis.id, options),
    onMutate: () => setRequestError(null),
    onSuccess: (dto, usedSignature) => {
      client.setQueryData(['export', dto.id], dto);
      remember({ id: dto.id, signature: usedSignature });
      autoDownload.current = { id: dto.id, signature: usedSignature };
    },
    onError: (error) => setRequestError(messageOf(error)),
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: (id: string) => api.downloadExport(id),
    onMutate: () => setDownloadError(null),
    onSuccess: ({ blob, fileName }, id) => {
      saveFile(blob, fileName);
      setDownloaded(id);
    },
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
  const active = isActiveExport(current) || create.isPending || acceptAll.isPending;
  // Le document prêt correspond exactement à ce qui serait demandé maintenant.
  const upToDate = Boolean(ready && current && !stale && pending === 0);

  // Téléchargement automatique du document demandé, une seule fois, dès qu'il est prêt.
  // Les choix affichés peuvent être mis à jour un instant après la demande (« Tout
  // corriger » juste avant) : on attend qu'ils correspondent. S'ils ont réellement changé,
  // le document ne les reflète plus et n'est pas téléchargé (« version précédente »).
  const { mutate: startDownload } = download;
  useEffect(() => {
    const pending = autoDownload.current;
    if (!pending || current?.id !== pending.id) return;
    if (current.status === 'FAILED') autoDownload.current = null;
    if (current.status !== 'READY' || pending.signature !== signature) return;
    autoDownload.current = null;
    if (new Date(current.expiresAt).getTime() > Date.now()) startDownload(current.id);
  }, [current, signature, startDownload]);

  const showRequest =
    !active &&
    !exportUnknown &&
    fileState !== 'deleted' &&
    !upToDate &&
    (!current ||
      stale ||
      expired ||
      pending > 0 ||
      (failed && isRetryableFailure(current.errorCode)));
  const canRequest =
    showRequest &&
    fileState === 'available' &&
    (eligible.length + pending > 0 || beautify) &&
    !savingDecisions;
  const retry = failed && !stale && pending === 0;

  /** Un clic : corrections fiables (si demandé), puis préparation et téléchargement. */
  const start = async () => {
    setRequestError(null);
    setAcceptedNotice(null);
    let decided = issues;
    if (pending > 0) {
      try {
        const result = await acceptAll.mutateAsync();
        // Même lot annulable que « Tout corriger » (panneau « Corriger »).
        if (result.acceptedIds.length > 0) writeBatch(analysis.id, result.acceptedIds);
        setAcceptedNotice(result.acceptedIds.length);
        const accepted = new Set(result.acceptedIds);
        decided = issues.map((issue) =>
          accepted.has(issue.id)
            ? { ...issue, status: 'accepted' as const, userText: null }
            : issue,
        );
      } catch (error) {
        // Les corrections fiables devaient être incluses : rien n'est demandé sans elles.
        setRequestError(messageOf(error));
        return;
      }
    }
    create.mutate(requestSignature(decisionsSignature(decided), options));
  };

  let status: ReactNode;
  if (exportUnknown && exportQuery.isPending) {
    status = <Progress text="Chargement de votre document corrigé…" />;
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
          acceptAll.isPending
            ? 'Application des corrections fiables…'
            : current?.status === 'RUNNING'
              ? 'Préparation de votre document…'
              : 'Demande enregistrée : en attente de préparation…'
        }
        detail={
          current && !acceptAll.isPending
            ? `${current.requestedCount > 0 ? `${plural(current.requestedCount, 'correction', 'corrections')} à appliquer` : 'Mise en forme du document'}. Cela prend en général quelques secondes ; le téléchargement démarrera tout seul.`
            : undefined
        }
      />
    );
  } else if (ready && current) {
    status = (
      <Notice tone="success" icon={<CircleCheck />}>
        <p className="font-semibold">
          {current.requestedCount > 0 ? (
            <>
              Document prêt : {current.appliedCount} sur{' '}
              {plural(current.requestedCount, 'correction appliquée', 'corrections appliquées')}.
            </>
          ) : (
            'Document prêt : mise en forme appliquée.'
          )}
        </p>
        {current.beautified && (current.options.typography || current.options.layout) ? (
          <p className="mt-0.5">{beautifiedText(current)}</p>
        ) : null}
        {downloaded === current.id && !stale ? (
          <p className="mt-0.5">
            Téléchargement lancé. Rien ne s’est passé ? Cliquez de nouveau sur{' '}
            {`«\u00a0${DOWNLOAD_LABEL}\u00a0»`}.
          </p>
        ) : null}
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
            Corrigez ces passages directement dans Word, ou modifiez vos choix puis téléchargez de
            nouveau.
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
  } else if (eligible.length + pending === 0 && !beautify) {
    status = (
      <p className="text-ink-subtle text-sm">
        Aucune modification choisie : acceptez ou modifiez au moins un point (ou « Tout corriger »),
        ou choisissez une mise en forme, pour télécharger un document. Les points ignorés, vérifiés
        ou non traités ne sont jamais appliqués.
      </p>
    );
  }

  const mainButton = active ? (
    <Button size="lg" disabled>
      <LoaderCircle className="animate-spin" aria-hidden />
      Préparation de votre document…
    </Button>
  ) : upToDate && current ? (
    <Button size="lg" onClick={() => download.mutate(current.id)} disabled={download.isPending}>
      {download.isPending ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : (
        <Download aria-hidden />
      )}
      {DOWNLOAD_LABEL}
    </Button>
  ) : showRequest ? (
    <Button size="lg" onClick={() => void start()} disabled={!canRequest}>
      {retry ? <RefreshCw aria-hidden /> : <Download aria-hidden />}
      {retry ? 'Réessayer' : DOWNLOAD_LABEL}
    </Button>
  ) : null;
  const previous = ready && current && stale ? current : null;
  const formatting = (Object.keys(FORMATTING_LABELS) as (keyof ExportOptions)[])
    .filter((key) => options[key])
    .map((key) => FORMATTING_LABELS[key]);

  return (
    <div>
      <p className="text-ink-subtle text-sm">
        Un seul document Word, copie de votre fichier avec les modifications choisies. Votre fichier
        d’origine n’est jamais modifié.
      </p>

      {fileState !== 'deleted' ? (
        <dl
          className="border-hairline divide-hairline rounded-control mt-4 divide-y border text-sm"
          aria-label="Contenu du document"
        >
          <Row label="Corrections acceptées ou modifiées">
            {plural(eligible.length, 'correction', 'corrections')}
          </Row>
          <Row label="Corrections fiables encore à traiter">
            {reliable > 0 ? (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-brand size-4 shrink-0"
                  checked={includeReliable}
                  disabled={active}
                  onChange={(event) => setIncludeReliable(event.target.checked)}
                />
                <span>Inclure les corrections fiables ({reliable})</span>
              </label>
            ) : (
              'aucune'
            )}
          </Row>
          <Row label="Mise en forme">
            <span>{formatting.length > 0 ? formatting.join(' · ') : 'aucune'}</span>
            {onEditFormatting ? (
              <button
                type="button"
                onClick={onEditFormatting}
                className="text-brand-deep ml-2 text-xs font-medium underline underline-offset-4"
              >
                Modifier
              </button>
            ) : null}
          </Row>
        </dl>
      ) : null}

      {manual > 0 ? (
        <Notice tone="warning" icon={<TriangleAlert />} className="mt-3">
          <p>
            {plural(manual, 'point demande', 'points demandent')} une vérification de votre part :{' '}
            {manual > 1 ? 'ils ne sont pas appliqués' : 'il n’est pas appliqué'} automatiquement et
            {manual > 1 ? ' ne bloquent' : ' ne bloque'} pas le téléchargement.
            {onShowManual ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onShowManual}
                  className="font-medium underline underline-offset-4"
                >
                  Voir {manual > 1 ? 'ces points' : 'ce point'}
                </button>
              </>
            ) : null}
          </p>
        </Notice>
      ) : null}

      {mainButton || previous ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {mainButton}
          {previous ? (
            <Button
              variant="ghost"
              onClick={() => download.mutate(previous.id)}
              disabled={download.isPending}
            >
              <Download aria-hidden />
              Télécharger la version précédente
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 space-y-3 empty:hidden" aria-live="polite">
        {/* Erreurs de la dernière action : juste sous le bouton, visibles sans défiler. */}
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
        {status}
        {acceptedNotice !== null && acceptedNotice > 0 ? (
          <p className="text-brand-deep text-sm">
            {plural(acceptedNotice, 'correction fiable acceptée', 'corrections fiables acceptées')}{' '}
            pour ce document. Vous pouvez {acceptedNotice > 1 ? 'les' : 'l’'} annuler dans{' '}
            {'«\u00a0Corriger\u00a0»'}.
          </p>
        ) : null}
        {showRequest && fileState === 'checking' ? (
          <Progress text="Vérification de la disponibilité de votre fichier d’origine…" />
        ) : null}
        {showRequest && fileState === 'unknown' ? (
          <Notice tone="error" icon={<TriangleAlert />}>
            <p className="font-semibold">
              La disponibilité de votre fichier d’origine n’a pas pu être vérifiée.
            </p>
            <p className="mt-0.5">
              Le téléchargement reste désactivé tant qu’elle n’est pas confirmée. Nouvel essai
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
            {eligible.length + pending > 0 || beautify
              ? ` Cliquez sur «\u00a0${DOWNLOAD_LABEL}\u00a0» pour obtenir une version à jour.`
              : ' Aucune correction ni mise en forme n’est plus choisie.'}
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
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="text-ink flex items-center font-medium">{children}</dd>
    </div>
  );
}

/** Compte rendu de la mise en forme (options demandées seulement). */
function beautifiedText(dto: ExportDto): string {
  const parts: string[] = [];
  const counts = dto.beautified ?? { typography: 0, layout: 0 };
  if (dto.options.typography) {
    parts.push(
      counts.typography > 0
        ? plural(counts.typography, 'correction typographique', 'corrections typographiques')
        : 'typographie déjà conforme',
    );
  }
  if (dto.options.layout) {
    parts.push(
      counts.layout > 0
        ? plural(counts.layout, 'paragraphe harmonisé', 'paragraphes harmonisés')
        : 'présentation déjà homogène',
    );
  }
  return `Mise en forme : ${parts.join(' · ')}.`;
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
  className,
  children,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-control flex items-start gap-2 border px-4 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        TONES[tone],
        className,
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
