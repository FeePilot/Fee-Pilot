import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { CountUp } from '@/components/ui/CountUp';
import { Gauge } from '@/components/ui/Gauge';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/cn';

const STUCK = 2;
const TARGET = 12;
const REPLACED = 12.5;

/** An illustrative card for the hero. The numbers are made up and the card says so. */
export function ExampleCard() {
  const [replaced, setReplaced] = useState(false);
  const rate = replaced ? REPLACED : STUCK;
  return (
    <Card
      glow
      role="group"
      className="relative w-full max-w-md p-6 sm:p-7"
      aria-labelledby="example-card-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="example-card-title" className="text-sm font-medium text-muted">
          Fee check
        </h2>
        <Pill tone="info">Example</Pill>
      </div>

      <p className="mt-5 text-sm text-muted">
        {replaced ? 'Replacement preview' : 'Stuck transaction'}
      </p>
      <p className="mt-1 flex items-baseline gap-2">
        <CountUp
          value={rate}
          className="font-mono text-5xl font-semibold tracking-tight tabular-nums"
        />
        <span className="text-sm text-muted">sat/vB</span>
      </p>

      <div className="mt-6">
        <Gauge rate={rate} target={TARGET} />
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>Paying {rate.toFixed(1)}</span>
          <span>Target {TARGET.toFixed(1)}</span>
        </div>
      </div>

      <p className="mt-5 flex items-center gap-2 text-sm" aria-live="polite">
        <Pill tone={replaced ? 'ok' : 'warn'}>
          {replaced ? 'Meets target' : 'Below target'}
        </Pill>
        <span className="text-muted">
          {replaced ? 'Estimates can still change.' : 'May wait a long time.'}
        </span>
      </p>

      <button
        type="button"
        onClick={() => setReplaced((v) => !v)}
        aria-pressed={replaced}
        className={cn(
          'mt-6 w-full rounded-xl border border-line-strong bg-surface-2 px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent',
        )}
      >
        {replaced ? 'Show the stuck transaction' : 'Preview a replacement'}
      </button>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Illustrative numbers, not live data and not a recommendation. FeePilot
        cannot guarantee confirmation.
      </p>
    </Card>
  );
}
