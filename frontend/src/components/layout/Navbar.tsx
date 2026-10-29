import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { NAV_LINKS } from '@/components/marketing/content';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { buttonStyles } from '@/components/ui/Button';
import { CloseIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { duration, ease, spring } from '@/lib/motion';

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      aria-label="FeePilot home"
      className={cn(
        'group inline-flex items-center gap-2 text-lg font-semibold tracking-tight',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-8 place-items-center rounded-lg bg-gradient-to-b from-accent-soft to-accent text-accent-ink shadow-glow"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 17l6-6 4 4 6-8" />
        </svg>
      </span>
      <span>FeePilot</span>
    </Link>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:text-fg',
    isActive ? 'text-fg' : 'text-muted',
  );

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header
      data-scrolled={scrolled || undefined}
      className={cn(
        'sticky top-0 z-50 border-b backdrop-blur-xl transition-colors duration-300',
        scrolled || open
          ? 'border-line bg-bg/80'
          : 'border-transparent bg-bg/30',
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Wordmark />
        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            to="/app"
            className={buttonStyles({
              size: 'sm',
              className: 'hidden sm:inline-flex',
            })}
          >
            Open the app
          </Link>
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            transition={spring.press}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
            className="grid size-10 place-items-center rounded-xl border border-line bg-surface text-lg text-muted backdrop-blur hover:text-fg md:hidden"
          >
            {open ? (
              <CloseIcon />
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="1em"
                height="1em"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            )}
          </motion.button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id="mobile-menu"
            key="menu"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.base, ease: ease.out }}
            className="overflow-hidden md:hidden"
          >
            <nav
              aria-label="Mobile"
              className="mx-auto flex max-w-6xl flex-col gap-1 px-4 pt-1 pb-5"
            >
              <NavLink
                to="/"
                end
                className={(s) => cn(linkClass(s), 'py-3 text-base')}
              >
                Home
              </NavLink>
              {NAV_LINKS.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={(s) => cn(linkClass(s), 'py-3 text-base')}
                >
                  {l.label}
                </NavLink>
              ))}
              <Link
                to="/app"
                className={buttonStyles({ size: 'lg', className: 'mt-3' })}
              >
                Open the app
              </Link>
            </nav>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
