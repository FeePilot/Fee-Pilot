import { motion } from 'motion/react';
import type { Recommendation, RouteOption, TxAnalysis } from '@/api/schemas';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CountUp } from '@/components/ui/CountUp';
import { Gauge } from '@/components/ui/Gauge';
import { Pill } from '@/components/ui/Pill';
import { Banner } from '@/features/shared/Banner';
import {
  eligibilityView,
  ROUTE_BLURBS,
  ROUTE_LABELS,
} from '@/features/shared/labels';
import { formatRate, formatSats, shortId } from '@/lib/format';
import { fadeUp, spring, stagger } from '@/lib/motion';

const sats = (n: number) => Math.round(n).toLocaleString('en-US');

function feeRateOf(a: TxAnalysis): number | null {
  return a.fee_sat === null ? null : a.fee_sat / Math.max(a.vsize, 1);
}

function Fact({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <div className="text-lg font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

const statusTone = {
  pending: 'warn',
  confirmed: 'ok',
  replaced: 'bad',
  not_found: 'bad',
} as const;
const statusLabel = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  replaced: 'Replaced',
  not_found: 'Not found',
} as const;

function Cost({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-semibold tabular-nums">{children}</span>
    </div>
  );
}

function RouteCard({
  option,
  recommended,
  canBuild,
  onBuild,
}: {
  option: RouteOption;
  recommended: boolean;
  canBuild: boolean;
  onBuild: (kind: 'rbf' | 'cpfp') => void;
}) {
  const view = eligibilityView(option);
  const unsupported = option.kind === 'external_accelerator';
  const buildable =
    canBuild &&
    view.tone === 'ok' &&
    (option.kind === 'rbf' || option.kind === 'cpfp');
  const hasNetwork = option.network_fee_sat !== null;
  return (
    <motion.article
      layout
      variants={fadeUp}
      transition={spring.soft}
      aria-label={ROUTE_LABELS[option.kind]}
      aria-disabled={unsupported || undefined}
      className={`flex flex-col gap-3 rounded-card border p-5 backdrop-blur-xl ${
        recommended
          ? 'border-accent/60 bg-surface shadow-glow'
          : 'border-line bg-surface shadow-card'
      } ${unsupported ? 'opacity-60' : ''}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="text-base font-semibold tracking-tight">
          {ROUTE_LABELS[option.kind]}
        </h4>
        {recommended ? (
          <Pill tone="ok">Recommended</Pill>
        ) : (
          <Pill tone={unsupported ? 'neutral' : view.tone}>
            {unsupported ? 'Not supported yet' : view.label}
          </Pill>
        )}
      </header>
      {recommended ? (
        <Pill tone={view.tone} className="self-start">
          {view.label}
        </Pill>
      ) : null}
      <p className="text-sm leading-relaxed text-muted">
        {ROUTE_BLURBS[option.kind]}
      </p>
      {view.reason && !unsupported ? (
        <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-sm">
          {view.reason}
        </p>
      ) : null}
      {hasNetwork || option.service_fee_sat !== null ? (
        <div className="grid gap-1.5 border-t border-line pt-3">
          {hasNetwork ? (
            <Cost label="Extra network fee">
              <CountUp value={option.network_fee_sat ?? 0} format={sats} /> sats
            </Cost>
          ) : null}
          <Cost label="Service charge">
            {option.service_fee_sat !== null ? (
              <>
                <CountUp value={option.service_fee_sat} format={sats} /> sats
              </>
            ) : (
              'none'
            )}
          </Cost>
        </div>
      ) : null}
      {option.notes.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {option.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {unsupported ? (
        <Button
          variant="secondary"
          size="sm"
          disabled
          className="mt-auto self-start"
        >
          Not supported yet
        </Button>
      ) : buildable ? (
        <Button
          variant={recommended ? 'primary' : 'secondary'}
          size="sm"
          className="mt-auto self-start"
          onClick={() => onBuild(option.kind as 'rbf' | 'cpfp')}
        >
          Build this recovery
        </Button>
      ) : null}
    </motion.article>
  );
}

/** Step 2: what the transaction looks like and what each route would cost. */
export function Compare({
  rec,
  onBuild,
  onBack,
}: {
  rec: Recommendation;
  onBuild: (kind: 'rbf' | 'cpfp') => void;
  onBack: () => void;
}) {
  const a = rec.analysis;
  const pending = a.status === 'pending';
  const rate = feeRateOf(a);
  return (
    <motion.div
      variants={stagger(0.08)}
      initial="hidden"
      animate="show"
      className="grid gap-5"
    >
      <Card className="grid gap-5 p-5 sm:p-7">
        <motion.div
          variants={fadeUp}
          className="flex flex-wrap items-center gap-3"
        >
          <h2 className="text-xl font-semibold tracking-tight">
            Compare recovery routes
          </h2>
          <Pill tone={statusTone[a.status]}>{statusLabel[a.status]}</Pill>
          <code
            className="font-mono text-xs break-all text-muted"
            title={a.txid}
          >
            {shortId(a.txid)}
          </code>
        </motion.div>
        {!pending ? (
          <Banner tone={a.status === 'confirmed' ? 'ok' : 'info'}>
            {a.status === 'confirmed'
              ? `Already confirmed with ${a.confirmations} confirmation${a.confirmations === 1 ? '' : 's'}. Nothing to recover.`
              : a.status === 'replaced'
                ? 'This transaction was replaced by another one spending the same inputs. Look up the replacement instead.'
                : 'This node does not know the transaction. It may have been evicted or never broadcast; that does not prove it does not exist.'}
          </Banner>
        ) : null}
        <motion.dl
          variants={fadeUp}
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        >
          <Fact
            value={a.fee_sat === null ? '–' : `${formatSats(a.fee_sat)} sats`}
            label="Fee paid"
          />
          <Fact value={`${formatSats(a.vsize)} vB`} label="Size" />
          <Fact
            value={
              a.signals_rbf === null ? 'Unknown' : a.signals_rbf ? 'Yes' : 'No'
            }
            label="Signals RBF"
          />
          <Fact
            value={`${a.unconfirmed_ancestors} / ${a.unconfirmed_descendants}`}
            label="Unconfirmed parents / children"
          />
        </motion.dl>
        {pending ? (
          <motion.div variants={fadeUp} className="grid gap-2">
            {rate !== null && a.target_fee_rate !== null ? (
              <>
                <Gauge rate={rate} target={a.target_fee_rate} />
                <div className="flex flex-wrap justify-between gap-2 text-sm text-muted">
                  <span>
                    Paying{' '}
                    <b className="text-fg tabular-nums">{formatRate(rate)}</b>{' '}
                    sat/vB
                  </span>
                  <span>
                    Next-block target{' '}
                    <b className="text-fg tabular-nums">
                      {formatRate(a.target_fee_rate)}
                    </b>{' '}
                    sat/vB
                  </span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">
                Fee rate or the current fee estimate is unknown, so routes that
                depend on them stay unknown.
              </p>
            )}
          </motion.div>
        ) : null}
        <motion.p
          variants={fadeUp}
          className="rounded-xl border border-line bg-surface-2/50 px-4 py-3 text-sm leading-relaxed"
        >
          {rec.rationale}
        </motion.p>
      </Card>

      <h3 className="px-1 text-sm font-semibold tracking-wider text-muted uppercase">
        Routes
      </h3>
      <motion.div layout className="grid gap-4 md:grid-cols-2">
        {rec.options.map((o) => (
          <RouteCard
            key={o.kind}
            option={o}
            recommended={rec.recommended === o.kind}
            canBuild={pending}
            onBuild={onBuild}
          />
        ))}
      </motion.div>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Check another transaction
        </Button>
      </div>
    </motion.div>
  );
}
