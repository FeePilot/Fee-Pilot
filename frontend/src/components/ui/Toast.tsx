import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';
import { AlertIcon, CheckIcon, CloseIcon } from './icons';

export type ToastTone = 'ok' | 'warn' | 'bad' | 'info';
export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
};
type ToastItem = ToastInput & { id: number };

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

const toneClass: Record<ToastTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
};

/** Non-blocking messages, announced politely to screen readers. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setItems((cur) => cur.filter((t) => t.id !== id)),
    [],
  );
  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setItems((cur) => [...cur.slice(-3), { ...input, id }]);
      window.setTimeout(() => dismiss(id), input.durationMs ?? 5200);
    },
    [dismiss],
  );
  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={spring.soft}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line-strong bg-solid p-4 shadow-card"
            >
              <span
                className={cn('mt-0.5 text-lg', toneClass[t.tone ?? 'info'])}
              >
                {t.tone === 'ok' ? <CheckIcon /> : <AlertIcon />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t.title}</p>
                {t.description ? (
                  <p className="mt-0.5 text-sm text-muted">{t.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="text-muted transition-colors hover:text-fg"
              >
                <CloseIcon />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (t: ToastInput) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
