'use client';

import { LoaderCircle } from 'lucide-react';
import { ApiError } from '@/lib/api/client';
import { useAnalysis } from '@/lib/hooks/use-analysis';
import { NotAvailable } from './not-available';
import { ProgressView } from './progress-view';
import { StoppedView } from './stopped-view';
import { Workbench } from '../results/workbench';

/**
 * Une seule adresse pour la progression et les résultats : un rechargement ou le
 * bouton « Reprendre » de l'historique retombent toujours au bon endroit.
 */
export function AnalysisScreen({ id }: { id: string }) {
  const { data, error, isPending } = useAnalysis(id);

  if (isPending) {
    return (
      <div className="text-ink-subtle grid flex-1 place-items-center py-24" aria-live="polite">
        <LoaderCircle className="size-6 animate-spin" aria-label="Chargement" />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotAvailable />;
  if (!data) return <NotAvailable message={error?.message} />;

  if (data.status === 'COMPLETED') return <Workbench analysis={data} />;
  if (data.status === 'FAILED' || data.status === 'CANCELED')
    return <StoppedView analysis={data} />;
  return <ProgressView analysis={data} />;
}
