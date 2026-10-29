import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';

/**
 * A fee-rate bar. 100% of the track is 1.5x the target, so the target mark sits two thirds in.
 * Green when the rate meets the target, amber when it falls short.
 */
export function Gauge({
  rate,
  target,
  className,
}: {
  rate: number | null;
  target: number | null;
  className?: string;
}) {
  if (rate === null || target === null || target <= 0) return null;
  const scale = target * 1.5;
  const fill = Math.min(100, (rate / scale) * 100);
  const mark = (target / scale) * 100;
  const fine = rate >= target;
  return (
    <div
      className={cn(
        'relative h-2.5 w-full rounded-full bg-surface-2',
        className,
      )}
      role="img"
      aria-label={`Paying ${rate.toFixed(1)} sat/vB against a target of ${target.toFixed(1)} sat/vB`}
    >
      <motion.div
        className={cn('h-full rounded-full', fine ? 'bg-ok' : 'bg-warn')}
        initial={{ width: 0 }}
        animate={{ width: `${fill}%` }}
        transition={spring.soft}
      />
      <div
        className="absolute -top-1 h-[18px] w-0.5 rounded bg-fg/70"
        style={{ left: `${mark}%` }}
        title="Target rate"
      />
    </div>
  );
}
