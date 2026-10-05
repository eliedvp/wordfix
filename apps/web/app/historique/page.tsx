import type { Metadata } from 'next';
import { DocumentsTable } from '@/components/history/documents-table';

export const metadata: Metadata = { title: 'Mes documents' };

export default function HistoryPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-ink text-2xl font-semibold tracking-tight sm:text-3xl">
        Mes documents
      </h1>
      <p className="text-ink-muted mt-2">
        Vos documents de ce navigateur. Ils sont supprimés automatiquement, ou dès que vous le
        demandez.
      </p>
      <div className="mt-8">
        <DocumentsTable />
      </div>
    </div>
  );
}
