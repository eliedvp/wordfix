'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Toaster } from 'sonner';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Après une coupure réseau, les requêtes reprennent seules.
            retry: (failureCount, error) =>
              failureCount < 3 &&
              !(error instanceof Error && 'status' in error && error.status === 404),
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster position="bottom-center" richColors closeButton />
    </QueryClientProvider>
  );
}
