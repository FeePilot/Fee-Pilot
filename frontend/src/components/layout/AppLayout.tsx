import { AnimatePresence, motion } from 'motion/react';
import { Suspense } from 'react';
import { Link, NavLink, useLocation, useOutlet } from 'react-router';
import { useFees, useNetworks, useOnline } from '@/api/hooks';
import { Backdrop } from '@/components/background/Backdrop';
import { NetworkSwitch } from '@/components/layout/NetworkSwitch';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { AlertIcon, WifiOffIcon } from '@/components/ui/icons';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { page, spring } from '@/lib/motion';

const NAV = [
  { to: '/app', label: 'Recover', end: true },
  { to: '/app/fees', label: 'Fees', end: false },
  { to: '/app/orders', label: 'Orders', end: false },
];

const slide = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

export function OfflineBanner({ show }: { show: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="offline"
          role="status"
          {...slide}
          transition={spring.soft}
          className="overflow-hidden border-b border-warn/30 bg-warn-bg"
        >
          <p className="mx-auto flex max-w-5xl items-start gap-2.5 px-4 py-2.5 text-sm leading-relaxed text-fg sm:px-6">
            <WifiOffIcon className="mt-0.5 shrink-0 text-base text-warn" />
            <span>
              <b>Offline mode:</b> the FeePilot API is unreachable. You can plan
              with the saved fee snapshot, but nothing can be broadcast, and
              nothing here confirms that a payment was sent or received.
            </span>
          </p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default function AppLayout() {
  const online = useOnline();
  const { fees } = useFees();
  const location = useLocation();
  const outlet = useOutlet();
  const { data: networks } = useNetworks();
  const switchable = networks?.ok === true && networks.body.networks.length > 1;
  const network = fees?.snapshot?.network ?? null;
  const mainnet = network === 'mainnet';

  return (
    <div className="relative flex min-h-dvh flex-col">
      <Backdrop fixed />
      <a
        href="#main"
        className="sr-only z-[60] rounded-xl bg-solid px-4 py-2 text-sm font-medium text-fg shadow-card focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-surface backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg text-base font-semibold tracking-tight"
            aria-label="FeePilot home"
          >
            <span
              aria-hidden="true"
              className="grid size-7 place-items-center rounded-lg bg-gradient-to-b from-accent-soft to-accent text-sm font-bold text-accent-ink"
            >
              F
            </span>
            <span className="hidden sm:inline">FeePilot</span>
          </Link>
          <nav aria-label="App" className="flex flex-1 items-center gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    'relative rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'text-fg' : 'text-muted hover:text-fg',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <motion.span
                        layoutId="app-nav-active"
                        transition={spring.soft}
                        className="absolute inset-0 rounded-lg border border-line-strong bg-surface-2"
                      />
                    ) : null}
                    <span className="relative">{n.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          {switchable ? (
            <NetworkSwitch />
          ) : network ? (
            <Pill tone={mainnet ? 'bad' : 'info'}>{network}</Pill>
          ) : null}
          <ThemeToggle />
        </div>
        <AnimatePresence initial={false}>
          {mainnet ? (
            <motion.div
              key="mainnet"
              role="alert"
              {...slide}
              transition={spring.soft}
              className="overflow-hidden border-t border-bad/30 bg-bad-bg"
            >
              <p className="mx-auto flex max-w-5xl items-start gap-2.5 px-4 py-2 text-sm text-fg sm:px-6">
                <AlertIcon className="mt-0.5 shrink-0 text-base text-bad" />
                <span>
                  <b>Mainnet.</b> Early build: test on regtest or signet first.
                </span>
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <OfflineBanner show={!online} />
      </header>

      <main
        id="main"
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            variants={page}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <Suspense
              fallback={
                <div className="grid gap-4" aria-busy="true">
                  <Skeleton className="h-9 w-72" />
                  <Skeleton className="h-64 w-full" />
                </div>
              }
            >
              {outlet}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 text-xs text-muted sm:px-6">
        FeePilot never controls miners or guarantees confirmation. Fee estimates
        are probabilistic.
      </footer>
    </div>
  );
}
