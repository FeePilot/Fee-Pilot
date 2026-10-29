import { zodResolver } from '@hookform/resolvers/zod';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { useFees } from '@/api/hooks';
import type { Urgency } from '@/api/schemas';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CountUp } from '@/components/ui/CountUp';
import { FormInput, FormToggleGroup } from '@/components/ui/form';
import { ChevronDownIcon, ClockIcon, WifiOffIcon } from '@/components/ui/icons';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner } from '@/features/shared/Banner';
import { useNowSecs } from '@/features/shared/useNow';
import {
  advise,
  ageSecs,
  DEFAULT_POLICY,
  formatAge,
  FRESHNESS_LABELS,
  freshness,
  sourceLabel,
  type Freshness,
} from '@/lib/advisor';
import { formatRate, formatSats } from '@/lib/format';
import { fadeUp, spring, stagger } from '@/lib/motion';

const schema = z.object({
  urgency: z.enum(['high', 'normal', 'low']),
  vsize: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || (/^\d+$/.test(v) && Number(v) > 0),
      'Enter the size as a whole number of vbytes above zero, or leave it empty.',
    )
    .transform((v) => (v === '' ? null : Number(v))),
});
type In = z.input<typeof schema>;
type Out = z.output<typeof schema>;

const urgencyOptions = [
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

const freshTone: Record<Freshness, 'ok' | 'warn' | 'bad'> = {
  recent: 'ok',
  past_window: 'warn',
  very_stale: 'bad',
  missing: 'warn',
};
const confTone = {
  good: 'ok',
  reduced: 'warn',
  low: 'bad',
  none: 'neutral',
} as const;

const stamp = (secs: number) => new Date(secs * 1000).toLocaleString();

export function FeeGuidance() {
  const { fees, clockOffsetSecs, state, error, refresh } = useFees();
  const [refreshing, setRefreshing] = useState(false);
  const deviceNow = useNowSecs(15_000);
  const now = deviceNow + clockOffsetSecs;

  const { control } = useForm<In, unknown, Out>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: { urgency: 'normal', vsize: '' },
  });
  const urgency: Urgency = useWatch({ control, name: 'urgency' });
  const vsizeRaw = useWatch({ control, name: 'vsize' });
  const vsize = useMemo(() => {
    const p = schema.shape.vsize.safeParse(vsizeRaw ?? '');
    return p.success ? p.data : null;
  }, [vsizeRaw]);

  const snap = fees?.snapshot ?? null;
  const policy = fees?.policy ?? DEFAULT_POLICY;
  const fresh = freshness(snap, now, policy);
  const advice = advise({
    snapshot: snap,
    urgency,
    vsize,
    nowSecs: now,
    policy,
  });
  const offline = state === 'offline';
  const degraded = state === 'degraded';

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }
  if (state === 'loading' && !fees) {
    return (
      <Card
        className="grid gap-4 p-5 sm:p-7"
        aria-busy="true"
        aria-label="Loading fee guidance"
      >
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  return (
    <motion.div
      variants={stagger(0.07)}
      initial="hidden"
      animate="show"
      className="grid gap-5"
    >
      {offline ? (
        <Banner tone="warn" role="status">
          <b>Offline.</b> The FeePilot API cannot be reached, so these numbers
          are a saved copy, not live data.
          {snap ? ` They are ${formatAge(ageSecs(snap, now))} old.` : ''}{' '}
          Nothing here can be broadcast.
        </Banner>
      ) : null}
      {degraded ? (
        <Banner tone="warn" role="status">
          <b>Degraded.</b> The API is reachable but its Bitcoin node or fee
          source is not, so it is serving its last saved snapshot. These numbers
          are not live.
          {error ? ` Reason: ${error}` : ''}
        </Banner>
      ) : null}

      <Card className="grid gap-6 p-5 sm:p-7">
        <motion.div
          variants={fadeUp}
          className="flex flex-wrap items-start justify-between gap-3"
        >
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Current estimate
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              Planning numbers from a snapshot of the network. A fee estimate is
              a probability, never a promise.
            </p>
          </div>
          <Pill tone={offline ? 'warn' : degraded ? 'warn' : 'ok'}>
            {offline ? <WifiOffIcon /> : null}
            {offline ? 'Offline' : degraded ? 'Degraded' : 'Online'}
          </Pill>
        </motion.div>

        <motion.div
          variants={fadeUp}
          className="grid gap-2 rounded-xl border border-line bg-surface-2/50 p-4 text-sm"
        >
          {snap ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <ClockIcon className="text-base text-muted" />
                <span>
                  Snapshot taken <b>{stamp(snap.fetched_at)}</b>,{' '}
                  <b>{formatAge(ageSecs(snap, now))}</b> ago.
                </span>
                <Pill tone={freshTone[fresh]}>{FRESHNESS_LABELS[fresh]}</Pill>
                {offline || degraded ? (
                  <Pill tone="warn">Saved copy, not live</Pill>
                ) : null}
              </div>
              <p className="text-muted">
                Network {snap.network}. Source: {snap.source || 'unknown'}.
                Fresh for {formatAge(policy.recent_secs)}, then reduced
                confidence; very stale after {formatAge(policy.stale_secs)}.
              </p>
            </>
          ) : (
            <p>
              <Pill tone="warn">{FRESHNESS_LABELS.missing}</Pill> Neither this
              device nor the server has saved one yet.
            </p>
          )}
          {error && !offline && !degraded ? (
            <p role="alert" className="font-medium text-bad">
              Could not refresh: {error}
            </p>
          ) : null}
        </motion.div>

        <motion.form
          variants={fadeUp}
          noValidate
          onSubmit={(e) => e.preventDefault()}
          className="grid gap-5"
        >
          <FormToggleGroup
            control={control}
            name="urgency"
            label="Urgency"
            options={urgencyOptions}
            hint="High aims for the 2-block estimate, normal for 6 blocks, low for about a day."
          />
          <FormInput
            control={control}
            name="vsize"
            label="Transaction size (vB)"
            inputMode="numeric"
            placeholder="unknown"
            className="sm:max-w-xs"
            hint="Optional. Enter it to get a total fee."
          />
        </motion.form>

        <motion.div
          variants={fadeUp}
          aria-live="polite"
          className="rounded-xl border border-line bg-surface-2/50 p-5"
        >
          <AnimatePresence mode="wait" initial={false}>
            {advice.rate === null ? (
              <motion.p
                key="none"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm leading-relaxed"
              >
                {advice.notes.join(' ')}
              </motion.p>
            ) : (
              <motion.div
                key="rate"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring.soft}
                className="grid gap-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                    <CountUp value={advice.rate} format={formatRate} />
                  </span>
                  <span className="text-lg text-muted">sat/vB</span>
                  {advice.total_sats !== null ? (
                    <span className="text-sm text-muted sm:ml-auto">
                      Total about{' '}
                      <b className="text-fg tabular-nums">
                        {formatSats(advice.total_sats)}
                      </b>{' '}
                      sats
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    Aim for the {advice.target_blocks}-block estimate.
                  </span>
                  <Pill tone={confTone[advice.confidence]}>
                    Confidence: {advice.confidence}
                  </Pill>
                  {advice.source ? (
                    <Pill tone="info">
                      {sourceLabel({
                        source: advice.source,
                        approximate: advice.approximate,
                      })}
                    </Pill>
                  ) : null}
                </div>
                {advice.notes.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                    {advice.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {snap ? (
          <motion.details
            variants={fadeUp}
            className="group rounded-xl border border-line bg-surface-2/30 px-4 py-1"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-sm font-medium select-none">
              All cached estimates
              <ChevronDownIcon className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="overflow-x-auto pb-3">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1.5 pr-4 font-medium">Target</th>
                    <th className="py-1.5 pr-4 font-medium">Rate</th>
                    <th className="py-1.5 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {snap.estimates.map((e) => (
                    <tr key={e.blocks}>
                      <td className="py-2 pr-4">{e.blocks} blocks</td>
                      <td className="py-2 pr-4 font-mono tabular-nums">
                        {e.sat_per_vb === null
                          ? '–'
                          : `${formatRate(e.sat_per_vb)} sat/vB`}
                      </td>
                      <td className="py-2">{sourceLabel(e)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2 pr-4">Relay minimum</td>
                    <td className="py-2 pr-4 font-mono tabular-nums">
                      {formatRate(snap.min_relay_fee_sat_per_vb)} sat/vB
                    </td>
                    <td className="py-2 text-muted">floor, not a target</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Mempool minimum</td>
                    <td className="py-2 pr-4 font-mono tabular-nums">
                      {formatRate(snap.mempool_min_fee_sat_per_vb)} sat/vB
                    </td>
                    <td className="py-2 text-muted">floor, not a target</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </motion.details>
        ) : null}

        <motion.div
          variants={fadeUp}
          className="flex flex-wrap items-center gap-3"
        >
          <Button
            variant="secondary"
            onClick={() => void onRefresh()}
            loading={refreshing}
          >
            {refreshing ? 'Refreshing' : 'Refresh snapshot'}
          </Button>
          <span className="text-xs text-muted">
            {offline
              ? 'Needs a connection to the FeePilot API.'
              : 'Asks the API to fetch new estimates from its node.'}
          </span>
        </motion.div>
      </Card>
    </motion.div>
  );
}
