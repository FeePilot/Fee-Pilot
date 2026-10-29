import { motion } from 'motion/react';
import type { JobState } from '@/api/schemas';
import { JOB_STEPS, timelineView } from '@/features/shared/labels';
import { CheckIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';

/** The normal path of a job. `obsolete` is a side exit and greys the whole path out. */
export function Timeline({ state }: { state: JobState }) {
  const view = timelineView(state);
  const pct = view.obsolete ? 0 : (view.current / (JOB_STEPS.length - 1)) * 100;
  return (
    <div>
      <ol aria-label="Job progress" className="relative grid grid-cols-4 gap-1">
        <span
          aria-hidden="true"
          className="absolute top-[15px] right-[12.5%] left-[12.5%] h-0.5 rounded bg-line"
        />
        <span
          aria-hidden="true"
          className="absolute top-[15px] right-[12.5%] left-[12.5%] h-0.5"
        >
          <motion.span
            className="block h-full origin-left rounded bg-accent"
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={spring.soft}
          />
        </span>
        {JOB_STEPS.map(([key, label], i) => {
          const done = !view.obsolete && i < view.current;
          const here = !view.obsolete && i === view.current;
          return (
            <li
              key={key}
              aria-current={here ? 'step' : undefined}
              className="relative flex flex-col items-center gap-2 text-center"
            >
              <motion.span
                animate={{ scale: here ? 1.12 : 1 }}
                transition={spring.snappy}
                className={cn(
                  'relative z-10 grid size-8 place-items-center rounded-full border-2 text-xs font-semibold tabular-nums',
                  done && 'border-accent bg-accent text-accent-ink',
                  here && 'border-accent bg-solid text-accent',
                  !done && !here && 'border-line-strong bg-solid text-muted',
                )}
              >
                {here ? (
                  <span
                    className="absolute inset-0 -z-10 animate-ping rounded-full bg-accent/30 motion-reduce:hidden"
                    aria-hidden="true"
                  />
                ) : null}
                {done ? <CheckIcon /> : i + 1}
              </motion.span>
              <span
                className={cn(
                  'text-xs font-medium sm:text-sm',
                  here ? 'text-fg' : 'text-muted',
                )}
              >
                {label}
                <span className="sr-only">
                  {done ? ' (done)' : here ? ' (current)' : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {view.obsolete ? (
        <p className="mt-4 rounded-xl border border-warn/30 bg-warn-bg px-4 py-2.5 text-sm">
          <b>Obsolete.</b> This job left the normal path and will not progress.
        </p>
      ) : null}
    </div>
  );
}
