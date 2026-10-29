import { motion } from 'motion/react';
import { AlertIcon, CheckIcon, ShieldIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { fadeUp } from '@/lib/motion';

export type BannerTone = 'ok' | 'warn' | 'bad' | 'info';

const tones: Record<BannerTone, string> = {
  ok: 'border-ok/30 bg-ok-bg [&>svg]:text-ok',
  warn: 'border-warn/30 bg-warn-bg [&>svg]:text-warn',
  bad: 'border-bad/35 bg-bad-bg [&>svg]:text-bad',
  info: 'border-info/30 bg-info-bg [&>svg]:text-info',
};

/** A short, full-width message. Text stays in the foreground colour so contrast holds in both themes. */
export function Banner({
  tone = 'info',
  role,
  className,
  children,
}: {
  tone?: BannerTone;
  role?: 'status' | 'alert';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      variants={fadeUp}
      role={role}
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed text-fg',
        tones[tone],
        className,
      )}
    >
      {tone === 'ok' ? (
        <CheckIcon className="mt-0.5 shrink-0 text-base" />
      ) : tone === 'info' ? (
        <ShieldIcon className="mt-0.5 shrink-0 text-base" />
      ) : (
        <AlertIcon className="mt-0.5 shrink-0 text-base" />
      )}
      <div className="min-w-0">{children}</div>
    </motion.div>
  );
}

/** Inline form-level error; announced to screen readers. */
export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm font-medium text-bad">
      {children}
    </p>
  );
}
