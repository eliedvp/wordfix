import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="border-hairline mt-auto border-t">
      <div className="text-ink-subtle mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm sm:px-6">
        <p>
          WordFix vous aide à repérer ce qui mérite votre attention. Vous gardez le dernier mot.
        </p>
        <Link href="/confidentialite" className="hover:text-ink underline-offset-4 hover:underline">
          Confidentialité
        </Link>
      </div>
    </footer>
  );
}
