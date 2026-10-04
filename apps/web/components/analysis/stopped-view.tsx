'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { type AnalysisDto, ERROR_CATALOG } from '@wordfix/shared';
import { CircleSlash, RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

/** Analyse en échec ou annulée : explication claire et relance possible. */
export function StoppedView({ analysis }: { analysis: AnalysisDto }) {
  const router = useRouter();
  const document = useQuery({
    queryKey: ['document', analysis.documentId],
    queryFn: () => api.getDocument(analysis.documentId),
  });
  const relaunch = useMutation({
    mutationFn: () => api.startAnalysis(analysis.documentId),
    onSuccess: ({ analysisId }) => router.push(`/analyses/${analysisId}`),
  });

  const canceled = analysis.status === 'CANCELED';
  const message = canceled
    ? 'Vous avez annulé cette analyse. Les points déjà relevés ne sont pas conservés comme résultat.'
    : ERROR_CATALOG[analysis.errorCode ?? 'ANALYSIS_FAILED'].message;
  const fileAvailable = document.data?.fileAvailable ?? false;
  const Icon = canceled ? CircleSlash : TriangleAlert;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <div className="border-hairline bg-surface rounded-card border p-8 shadow-sm">
        <Icon
          className={canceled ? 'text-ink-subtle size-8' : 'text-nature-error size-8'}
          aria-hidden
        />
        <h1 className="font-display text-ink mt-4 text-2xl font-semibold">
          {canceled ? 'Analyse annulée' : 'L’analyse n’a pas abouti'}
        </h1>
        <p className="text-ink-muted mt-1 break-words">{analysis.documentName}</p>
        <p className="text-ink mt-4" role={canceled ? undefined : 'alert'}>
          {message}
        </p>
        {relaunch.error ? (
          <p role="alert" className="text-nature-error mt-3 text-sm">
            {relaunch.error instanceof ApiError ? relaunch.error.message : 'Relance impossible.'}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          {fileAvailable ? (
            <Button onClick={() => relaunch.mutate()} disabled={relaunch.isPending}>
              <RotateCcw aria-hidden />
              Relancer l’analyse
            </Button>
          ) : document.isSuccess ? (
            <p className="text-ink-subtle text-sm">{ERROR_CATALOG.FILE_EXPIRED.message}</p>
          ) : null}
          <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
            Importer un autre document
          </Link>
        </div>
      </div>
    </div>
  );
}
