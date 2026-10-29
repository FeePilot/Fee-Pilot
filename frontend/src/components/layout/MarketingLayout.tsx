import { Outlet } from 'react-router';
import Footer from './Footer';
import Navbar from './Navbar';

export default function MarketingLayout() {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[60] rounded-xl bg-solid px-4 py-2 text-sm font-medium text-fg shadow-card focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        Skip to content
      </a>
      <Navbar />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
