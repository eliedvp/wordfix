'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnalysisDto, AnalysisStepDto } from '@wordfix/shared';
import { Check, Circle, Lightbulb, LoaderCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Ring } from '@/components/ui/score-ring';
import { ApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { STEP_LABELS } from '@/lib/copy';
import { formatDuration, formatNumber, formatPages } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Écran d'analyse en cours : uniquement des états réels, jamais un avancement simulé. */
export function ProgressView({ analysis }: { analysis: AnalysisDto }) {
  const client = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelAnalysis(analysis.id),
    onSuccess: (data) => {
      client.setQueryData(['analysis', analysis.id], data);
      toast.success('Analyse annulée.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Annulation impossible.'),
  });

  const queued = analysis.status === 'QUEUED';
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-ink text-2xl font-semibold tracking-tight sm:text-3xl">
        Analyse de <span className="break-words">{analysis.documentName}</span>
      </h1>
      <p className="text-ink-subtle mt-2">
        {formatPages(analysis.estimatedPages)} · {formatNumber(analysis.wordCount)} mots
      </p>

      <div className="border-hairline bg-surface rounded-card mt-8 grid gap-8 border p-6 shadow-sm sm:grid-cols-[auto_1fr] sm:items-center sm:p-8">
        <Ring
          value={analysis.progress}
          label={`Analyse en cours : ${analysis.progress} %`}
          className="mx-auto"
        >
          <span className="font-display text-ink text-3xl font-bold">{analysis.progress} %</span>
        </Ring>
        <div aria-live="polite">
          <p className="text-ink font-semibold">
            {queued ? 'En attente de démarrage…' : 'Relecture en cours'}
          </p>
          {analysis.chunksTotal > 0 ? (
            <p className="text-ink-subtle mt-1 text-sm">
              {analysis.chunksDone} parties relues sur {analysis.chunksTotal}
            </p>
          ) : null}
          {analysis.etaSeconds !== null ? (
            <p className="text-ink-subtle mt-1 text-sm">
              Temps restant : {formatDuration(analysis.etaSeconds)}
            </p>
          ) : null}
          <p className="text-ink-muted mt-4 text-sm">
            Vous pouvez fermer cette page : l’analyse continue et vous la retrouverez dans « Mes
            documents ».
          </p>
        </div>
      </div>

      <ol className="border-hairline bg-surface rounded-card mt-6 divide-y divide-slate-100 border shadow-sm">
        {analysis.steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>

      <div className="border-hairline bg-surface rounded-card mt-6 flex gap-4 border p-5 shadow-sm">
        <Lightbulb className="text-brand mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <h2 className="text-ink font-semibold">
            Pourquoi cette analyse prend-elle quelques minutes ?
          </h2>
          <p className="text-ink-subtle mt-1 text-sm">
            WordFix relit votre document en plusieurs passes : chaque paragraphe (orthographe,
            grammaire, style), puis chaque section (transitions, temps, répétitions), puis le
            document entier pour repérer les contradictions entre les parties. Plus le document est
            long, plus il y a de parties à relire.
          </p>
        </div>
      </div>

      <div className="mt-6 flex justify-center">
        <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          <X aria-hidden />
          Annuler l’analyse
        </Button>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: AnalysisStepDto }) {
  const label = STEP_LABELS[step.key];
  return (
    <li
      className={cn(
        'flex items-center gap-4 px-5 py-4',
        step.state === 'running' && 'bg-brand-soft/60',
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
        {step.state === 'done' ? (
          <Check className="text-brand size-5" />
        ) : step.state === 'running' ? (
          <LoaderCircle className="text-brand size-5 animate-spin" />
        ) : (
          <Circle className="size-4 text-slate-300" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', step.state === 'pending' ? 'text-ink-subtle' : 'text-ink')}>
          {label.title}
        </p>
        <p className="text-ink-subtle text-sm">{label.detail}</p>
      </div>
      <span className="text-ink-subtle text-sm whitespace-nowrap">
        <span className="sr-only">
          {step.state === 'done' ? 'Terminé' : step.state === 'running' ? 'En cours' : 'En attente'}
          {' — '}
        </span>
        {step.issueCount > 0 ? `${step.issueCount} relevé${step.issueCount > 1 ? 's' : ''}` : null}
      </span>
    </li>
  );
}
