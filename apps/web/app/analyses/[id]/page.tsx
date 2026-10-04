import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';

export const metadata: Metadata = { title: 'Analyse' };

export default async function AnalysisPage(props: PageProps<'/analyses/[id]'>) {
  const { id } = await props.params;
  return (
    <Suspense>
      <AnalysisScreen id={id} />
    </Suspense>
  );
}
