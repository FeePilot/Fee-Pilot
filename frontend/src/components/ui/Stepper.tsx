import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';

/** A horizontal progress tracker. The active step's underline slides between steps. */
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: string[];
  current: number;
  className?: string;
}) {
  return (
    <ol
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label="Progress"
    >
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className="relative pb-2.5"
          >
            <span
              className={cn(
                'text-xs font-medium transition-colors',
                active ? 'text-fg' : done ? 'text-muted' : 'text-muted/60',
              )}
            >
              <span className="mr-1.5 tabular-nums">{done ? '✓' : n}</span>
              {label}
            </span>
            <span className="absolute inset-x-0 bottom-0 h-0.5 rounded bg-line" />
            {(active || done) && (
              <motion.span
                layoutId={active ? 'stepper-active' : undefined}
                className={cn(
                  'absolute inset-x-0 bottom-0 h-0.5 rounded',
                  active ? 'bg-accent' : 'bg-accent/40',
                )}
                transition={spring.soft}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
