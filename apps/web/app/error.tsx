'use client';

import { Button } from '@/components/ui/button';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="font-display text-ink text-2xl font-semibold">
        Cette page n’a pas pu s’afficher
      </h1>
      <p className="text-ink-muted mt-3">
        Une erreur inattendue est survenue. Vos documents ne sont pas affectés.
      </p>
      <Button className="mt-6" onClick={reset}>
        Réessayer
      </Button>
    </div>
  );
}
