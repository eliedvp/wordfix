import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="font-display text-ink text-2xl font-semibold">Page introuvable</h1>
      <p className="text-ink-muted mt-3">Cette adresse ne correspond à aucune page de WordFix.</p>
      <Link href="/" className={buttonVariants({ className: 'mt-6' })}>
        Retour à l’accueil
      </Link>
    </div>
  );
}
