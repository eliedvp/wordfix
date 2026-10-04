import { MAX_UPLOAD_BYTES } from '@wordfix/shared';

const maxUploadMb = MAX_UPLOAD_BYTES / (1024 * 1024);

/**
 * Page temporaire de l'étape 1 (fondation technique).
 * Elle sera remplacée par la vraie page d'accueil à l'étape 2. Elle n'affiche
 * aucune fonctionnalité simulée : seulement l'état du projet.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <p className="text-brand-deep bg-brand-soft w-fit rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase">
        Fondation technique · étape 1
      </p>
      <h1 className="font-display text-4xl font-bold tracking-tight">WordFix</h1>
      <p className="text-ink-muted text-lg">
        Un deuxième regard attentif sur vos documents Word longs. L&apos;interface d&apos;import
        arrive à l&apos;étape 2.
      </p>
      <div className="border-hairline bg-surface rounded-card border p-5 text-sm shadow-sm">
        <p className="text-ink-subtle">
          Limite configurée : fichiers <code>.docx</code> de {maxUploadMb} Mo maximum.
        </p>
        <p className="text-ink-subtle mt-1">
          État de l&apos;API :{' '}
          <a className="text-brand underline" href="/api/health">
            /api/health
          </a>
        </p>
      </div>
    </main>
  );
}
