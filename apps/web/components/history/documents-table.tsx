'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalysisStatus, DocumentDto } from '@wordfix/shared';
import { FileText, LoaderCircle, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate, formatPages, formatTimeLeft } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS: Record<AnalysisStatus | 'NONE', { label: string; className: string }> = {
  NONE: { label: 'Non analysé', className: 'bg-slate-100 text-ink-muted' },
  QUEUED: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  EXTRACTING: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  ANALYZING_LOCAL: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  ANALYZING_CONTEXT: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  ANALYZING_GLOBAL: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  FINALIZING: { label: 'En cours', className: 'bg-brand-soft text-brand-deep' },
  COMPLETED: { label: 'Terminé', className: 'bg-brand-soft text-brand-deep' },
  FAILED: { label: 'Échec', className: 'bg-nature-error-soft text-nature-error' },
  CANCELED: { label: 'Annulé', className: 'bg-slate-100 text-ink-muted' },
};

export function DocumentsTable() {
  const documents = useQuery({
    queryKey: ['documents'],
    queryFn: api.listDocuments,
    refetchInterval: 10_000,
  });

  if (documents.isPending) {
    return (
      <div className="text-ink-subtle grid place-items-center py-20">
        <LoaderCircle className="size-6 animate-spin" aria-label="Chargement" />
      </div>
    );
  }
  if (documents.isError) {
    return (
      <div className="py-16 text-center">
        <p className="text-ink">
          {documents.error instanceof ApiError ? documents.error.message : 'Chargement impossible.'}
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => void documents.refetch()}>
          Réessayer
        </Button>
      </div>
    );
  }
  if (documents.data.length === 0) {
    return (
      <div className="border-hairline bg-surface rounded-card border px-6 py-16 text-center">
        <FileText className="text-ink-subtle mx-auto size-8" aria-hidden />
        <p className="text-ink mt-4 font-semibold">Aucun document pour l’instant</p>
        <p className="text-ink-muted mt-1">
          Importez un rapport, un mémoire ou un document long pour commencer.
        </p>
        <Link href="/" className={cn(buttonVariants(), 'mt-6')}>
          Importer un document
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {documents.data.map((document) => (
        <DocumentRow key={document.id} document={document} />
      ))}
    </ul>
  );
}

function DocumentRow({ document }: { document: DocumentDto }) {
  const router = useRouter();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const analysis = document.latestAnalysis;
  const status = STATUS[analysis?.status ?? 'NONE'];

  const remove = useMutation({
    mutationFn: () => api.deleteDocument(document.id),
    onSuccess: () => {
      setConfirming(false);
      toast.success('Document supprimé définitivement.');
      void client.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Suppression impossible.'),
  });
  const start = useMutation({
    mutationFn: () => api.startAnalysis(document.id),
    onSuccess: ({ analysisId }) => router.push(`/analyses/${analysisId}`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Lancement impossible.'),
  });

  return (
    <li className="border-hairline bg-surface rounded-card flex flex-col gap-4 border p-4 shadow-sm sm:flex-row sm:items-center sm:p-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-ink truncate font-semibold" title={document.originalName}>
            {document.originalName}
          </p>
          <span
            className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', status.className)}
          >
            {status.label}
          </span>
        </div>
        <p className="text-ink-subtle mt-1 text-sm">
          {formatDate(document.createdAt)} · {formatPages(document.estimatedPages)}
          {analysis?.score !== null && analysis?.score !== undefined
            ? ` · score ${analysis.score}/100${analysis.aiDisabled ? ' (sans IA)' : ''}`
            : ''}
          {analysis?.status === 'COMPLETED' && analysis.issueCount > 0
            ? ` · ${analysis.reviewedCount}/${analysis.issueCount} points traités`
            : ''}
        </p>
        <p className="text-ink-subtle mt-1 text-xs">
          Suppression automatique {formatTimeLeft(document.contentExpiresAt)}
          {document.fileAvailable
            ? ` · fichier d’origine supprimé ${formatTimeLeft(document.fileExpiresAt)}`
            : ''}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {analysis ? (
          <Link
            href={`/analyses/${analysis.id}`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            Reprendre
          </Link>
        ) : document.fileAvailable ? (
          <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
            <Play aria-hidden />
            Lancer l’analyse
          </Button>
        ) : null}
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Supprimer ${document.originalName}`}
          >
            <Trash2 aria-hidden />
            <span className="sm:sr-only">Supprimer</span>
          </Button>
          <DialogContent
            title="Supprimer ce document ?"
            description="Le fichier, le texte extrait et les résultats de l’analyse seront supprimés définitivement."
          >
            <div className="mt-6 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="secondary">Garder</Button>
              </DialogClose>
              <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Supprimer définitivement
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </li>
  );
}
