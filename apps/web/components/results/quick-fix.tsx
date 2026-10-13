'use client';

import { useIsMutating } from '@tanstack/react-query';
import { type IssueDto, isReliableCorrection } from '@wordfix/shared';
import { CircleCheck, RotateCcw, TriangleAlert, Wand2 } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, NETWORK_MESSAGE } from '@/lib/api/client';
import { batchSnapshot, parseBatch, subscribeBatch, writeBatch } from '@/lib/bulk-batch';
import { useBulkCorrections } from '@/lib/hooks/use-bulk-corrections';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * « Tout corriger » : accepte d'un coup les corrections fiables (orthographe,
 * grammaire, ponctuation ; erreurs sûres avec une proposition), sans toucher aux
 * décisions déjà prises, avec annulation. Le fichier Word n'est modifié qu'au moment
 * de télécharger le document (copie, jamais l'original). Le lot annulable est partagé
 * avec « Corriger et télécharger » (`lib/bulk-batch.ts`).
 */
export function QuickFix({ analysisId, issues }: { analysisId: string; issues: IssueDto[] }) {
  const { acceptAll, undo } = useBulkCorrections(analysisId);
  // Lot du dernier « Tout corriger » (partagé avec le panneau « Télécharger »).
  const rawBatch = useSyncExternalStore(
    (listener) => subscribeBatch(analysisId, listener),
    () => batchSnapshot(analysisId),
    () => '',
  );
  const batch = useMemo(() => parseBatch(rawBatch), [rawBatch]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Une décision en cours d'enregistrement : on attend qu'elle soit prise en compte.
  const busy = useIsMutating() > 0;

  const reliable = useMemo(() => issues.filter(isReliableCorrection).length, [issues]);
  // Points du dernier « Tout corriger » encore acceptés (une décision prise depuis l'en retire).
  const undoable = useMemo(() => {
    if (!batch) return 0;
    const accepted = new Set(issues.filter((i) => i.status === 'accepted').map((i) => i.id));
    return batch.filter((id) => accepted.has(id)).length;
  }, [batch, issues]);

  const remember = (ids: string[] | null) => writeBatch(analysisId, ids);
  const fail = (cause: unknown) =>
    setError(cause instanceof ApiError ? cause.message : NETWORK_MESSAGE);

  const fixAll = () => {
    setError(null);
    setNotice(null);
    acceptAll.mutate(undefined, {
      onSuccess: ({ acceptedIds }) => {
        remember(acceptedIds.length > 0 ? acceptedIds : null);
        setNotice(
          acceptedIds.length > 0
            ? `${plural(acceptedIds.length, 'correction acceptée', 'corrections acceptées')}.`
            : 'Aucune correction sûre à accepter.',
        );
      },
      onError: fail,
    });
  };

  const cancel = () => {
    if (!batch) return;
    setError(null);
    undo.mutate(batch, {
      onSuccess: ({ reopenedIds }) => {
        remember(null);
        const kept = batch.length - reopenedIds.length;
        setNotice(
          `${plural(reopenedIds.length, 'correction remise', 'corrections remises')} à traiter.` +
            (kept > 0
              ? ` ${plural(kept, 'point modifié', 'points modifiés')} depuis par vous ${kept > 1 ? 'ont été conservés' : 'a été conservé'}.`
              : ''),
        );
      },
      onError: fail,
    });
  };

  if (reliable === 0 && undoable === 0 && !notice && !error) return null;

  return (
    <section
      aria-labelledby="quick-fix-title"
      className="border-hairline bg-canvas rounded-card border p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-brand-soft text-brand-deep rounded-control grid size-10 shrink-0 place-items-center">
            <Wand2 className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="quick-fix-title" className="font-display text-ink text-lg font-semibold">
              Correction rapide
            </h2>
            <p className="text-ink-subtle text-sm">
              {reliable > 0
                ? `${plural(reliable, 'correction sûre', 'corrections sûres')} d’orthographe, de grammaire ou de ponctuation ${reliable > 1 ? 'peuvent' : 'peut'} être acceptée${reliable > 1 ? 's' : ''} en une fois. `
                : 'Aucune autre correction sûre à accepter. '}
              Les points incertains et vos propres décisions ne sont jamais modifiés.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {undoable > 0 ? (
            <Button variant="secondary" onClick={cancel} disabled={busy}>
              <RotateCcw aria-hidden />
              Annuler « Tout corriger »
            </Button>
          ) : null}
          {reliable > 0 ? (
            <Button onClick={fixAll} disabled={busy}>
              <Wand2 aria-hidden />
              Tout corriger ({reliable})
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 space-y-2" aria-live="polite">
        {notice ? (
          <p className="text-brand-deep flex items-start gap-2 text-sm">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {notice}
              {undoable > 0
                ? ' Elles seront appliquées au document téléchargé. Vous pouvez annuler.'
                : ''}
            </span>
          </p>
        ) : null}
        {error ? (
          <p className="text-nature-error flex items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
