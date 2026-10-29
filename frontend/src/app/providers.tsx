import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useState } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { ToastProvider } from '@/components/ui/Toast';

/**
 * Everything the app needs around its routes. Used by the browser entry and by the prerender
 * entry, so marketing pages render the same way in both. `helmetContext` collects <head> tags
 * during prerendering.
 */
export function AppProviders({
  children,
  helmetContext,
}: {
  children: React.ReactNode;
  helmetContext?: object;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // The API is a local node's view of the chain: stale-while-revalidate is the right default.
          // `networkMode: 'always'` matters for the offline story: by default TanStack Query
          // pauses fetches while the browser reports offline, so nothing would run and the page
          // would keep saying "Online". Our client turns a failed fetch into a typed
          // `network_error` result, which is how the app learns it is offline and shows the
          // saved snapshot instead.
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
            networkMode: 'always',
          },
          mutations: { networkMode: 'always' },
        },
      }),
  );
  return (
    <HelmetProvider {...(helmetContext ? { context: helmetContext } : {})}>
      <QueryClientProvider client={queryClient}>
        {/* "user" turns transform and layout animation off when the OS asks for reduced motion. */}
        <MotionConfig reducedMotion="user">
          <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </MotionConfig>
      </QueryClientProvider>
    </HelmetProvider>
  );
}
