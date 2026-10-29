import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import AppLayout from '@/components/layout/AppLayout';
import MarketingLayout from '@/components/layout/MarketingLayout';
import HowItWorks from '@/pages/marketing/HowItWorks';
import Landing from '@/pages/marketing/Landing';
import Safety from '@/pages/marketing/Safety';
import NotFound from '@/pages/NotFound';

// Marketing pages are imported eagerly: they are prerendered to static HTML and must render
// without Suspense. App pages are code-split; they only ever run in the browser.
const Recover = lazy(() => import('@/pages/app/Recover'));
const Fees = lazy(() => import('@/pages/app/Fees'));
const Orders = lazy(() => import('@/pages/app/Orders'));
const Job = lazy(() => import('@/pages/app/Job'));

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<MarketingLayout />}>
        <Route index element={<Landing />} />
        <Route path="how-it-works" element={<HowItWorks />} />
        <Route path="safety" element={<Safety />} />
      </Route>
      <Route
        path="app"
        element={
          <Suspense fallback={null}>
            <AppLayout />
          </Suspense>
        }
      >
        <Route index element={<Recover />} />
        <Route path="fees" element={<Fees />} />
        <Route path="orders" element={<Orders />} />
        <Route path="jobs/:id" element={<Job />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
