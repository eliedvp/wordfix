'use client';

import type { DocumentDto } from '@wordfix/shared';
import { MAX_UPLOAD_BYTES } from '@wordfix/shared';
import { FileText, LoaderCircle, RotateCcw, UploadCloud, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type DragEvent, useCallback, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ApiError } from '@/lib/api/client';
import { api, uploadDocument } from '@/lib/api/endpoints';
import { checkFileBeforeUpload } from '@/lib/file-check';
import { formatBytes, formatNumber, formatPages } from '@/lib/format';
import { cn } from '@/lib/utils';

type State =
  | { kind: 'idle'; error?: string }
  | { kind: 'uploading'; name: string; size: number; progress: number; abort: () => void }
  | { kind: 'ready'; document: DocumentDto; error?: string }
  | { kind: 'starting'; document: DocumentDto };

const SAMPLE_URL = '/exemple/rapport-de-stage-exemple.docx';
const maxMb = MAX_UPLOAD_BYTES / (1024 * 1024);

/**
 * Import en deux temps (validé avec la maquette) : le fichier est d'abord envoyé
 * et vérifié par le serveur, puis l'utilisateur lance l'analyse en connaissant
 * le nombre de pages. Rien n'est analysé sans confirmation.
 */
export function UploadPanel() {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);

  const send = useCallback((file: File) => {
    const problem = checkFileBeforeUpload(file);
    if (problem) {
      setState({ kind: 'idle', error: problem });
      return;
    }
    const handle = uploadDocument(file, (progress) =>
      setState((current) => (current.kind === 'uploading' ? { ...current, progress } : current)),
    );
    setState({
      kind: 'uploading',
      name: file.name,
      size: file.size,
      progress: 0,
      abort: handle.abort,
    });
    handle.promise
      .then((document) => setState({ kind: 'ready', document }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState({ kind: 'idle' });
        } else {
          setState({ kind: 'idle', error: messageOf(error) });
        }
      });
  }, []);

  const useSample = async () => {
    try {
      const response = await fetch(SAMPLE_URL);
      const blob = await response.blob();
      send(new File([blob], 'Rapport de stage (exemple).docx', { type: blob.type }));
    } catch {
      setState({ kind: 'idle', error: 'Le document d’exemple n’a pas pu être chargé.' });
    }
  };

  const reset = async () => {
    if (state.kind === 'ready') {
      // Le document non analysé est supprimé : rien n'est gardé inutilement.
      await api.deleteDocument(state.document.id).catch(() => undefined);
    }
    setState({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  const launch = async () => {
    if (state.kind !== 'ready') return;
    const document = state.document;
    setState({ kind: 'starting', document });
    try {
      const { analysisId } = await api.startAnalysis(document.id);
      router.push(`/analyses/${analysisId}`);
    } catch (error) {
      setState({ kind: 'ready', document, error: messageOf(error) });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && state.kind === 'idle') send(file);
  };

  if (state.kind === 'ready' || state.kind === 'starting') {
    const { document } = state;
    return (
      <section
        aria-label="Document prêt"
        className="border-hairline bg-surface rounded-card border p-5 shadow-sm sm:p-6"
      >
        <div className="flex items-start gap-4">
          <span className="bg-brand-soft text-brand grid size-12 shrink-0 place-items-center rounded-xl">
            <FileText className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-ink truncate font-semibold" title={document.originalName}>
              {document.originalName}
            </p>
            <p className="text-ink-subtle mt-1 text-sm">
              {formatBytes(document.sizeBytes)} · {formatPages(document.estimatedPages)} ·{' '}
              {formatNumber(document.wordCount)} mots
            </p>
            <p className="text-brand-deep mt-2 text-sm">Fichier vérifié : prêt pour l’analyse.</p>
          </div>
        </div>
        {state.kind === 'ready' && state.error ? (
          <p role="alert" className="text-nature-error mt-4 text-sm">
            {state.error}
          </p>
        ) : null}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            size="lg"
            className="flex-1"
            onClick={launch}
            disabled={state.kind === 'starting'}
          >
            {state.kind === 'starting' ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : null}
            Lancer l’analyse ({document.estimatedPages}{' '}
            {document.estimatedPages > 1 ? 'pages' : 'page'})
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={reset}
            disabled={state.kind === 'starting'}
          >
            <RotateCcw aria-hidden />
            Choisir un autre fichier
          </Button>
        </div>
      </section>
    );
  }

  if (state.kind === 'uploading') {
    return (
      <section
        aria-label="Envoi en cours"
        className="border-hairline bg-surface rounded-card border p-6 shadow-sm"
      >
        <div className="flex items-center gap-4">
          <LoaderCircle className="text-brand size-6 shrink-0 animate-spin" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-ink truncate font-semibold">{state.name}</p>
            <p className="text-ink-subtle text-sm" aria-live="polite">
              {state.progress < 1
                ? `Envoi… ${Math.round(state.progress * 100)} % de ${formatBytes(state.size)}`
                : 'Vérification du fichier…'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={state.abort} aria-label="Annuler l’envoi">
            <X aria-hidden />
            Annuler
          </Button>
        </div>
        <ProgressBar value={state.progress * 100} label="Progression de l’envoi" className="mt-4" />
      </section>
    );
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-card bg-surface focus-within:outline-brand flex cursor-pointer flex-col items-center gap-3 border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-2',
          dragging ? 'border-brand bg-brand-soft' : 'border-hairline-strong hover:border-brand',
        )}
      >
        <span className="bg-brand-soft text-brand grid size-14 place-items-center rounded-2xl">
          <UploadCloud className="size-7" aria-hidden />
        </span>
        <span className="font-display text-ink text-lg font-semibold">
          {dragging ? 'Déposez pour envoyer le fichier' : 'Glissez votre document Word ici'}
        </span>
        <span className="text-ink-subtle text-sm">
          ou{' '}
          <span className="text-brand-deep font-semibold underline underline-offset-4">
            parcourez vos fichiers
          </span>
        </span>
        <span className="text-ink-subtle text-xs">
          Format .docx · {maxMb} Mo maximum · environ 150 pages
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) send(file);
          }}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-nature-error mt-3 text-sm">
          {state.error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={useSample}
        className="text-ink-subtle hover:text-ink mt-3 text-sm underline underline-offset-4"
      >
        Essayer avec un rapport de stage d’exemple
      </button>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : 'Une erreur inattendue est survenue. Réessayez.';
}
