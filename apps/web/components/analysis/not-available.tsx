import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export function NotAvailable({ message }: { message?: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="font-display text-ink text-2xl font-semibold">Analyse introuvable</h1>
      <p className="text-ink-muted mt-3">
        {message ??
          'Cette analyse n’existe pas, a été supprimée, a expiré, ou a été lancée depuis un autre navigateur.'}
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/" className={buttonVariants()}>
          Importer un document
        </Link>
        <Link href="/historique" className={buttonVariants({ variant: 'secondary' })}>
          Mes documents
        </Link>
      </div>
    </div>
  );
}
