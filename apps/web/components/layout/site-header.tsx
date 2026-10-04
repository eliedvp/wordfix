'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LogoMark } from './logo';

const LINKS = [
  { href: '/', label: 'Importer' },
  { href: '/historique', label: 'Mes documents' },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="border-hairline bg-surface/90 sticky top-0 z-30 border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="font-display text-ink flex items-center gap-2 text-lg font-bold tracking-tight"
        >
          <LogoMark className="size-8" />
          WordFix
        </Link>
        <nav aria-label="Navigation principale" className="flex items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-control px-3 py-2 text-sm font-medium transition-colors',
                  active ? 'bg-brand-soft text-brand-deep' : 'text-ink-subtle hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
