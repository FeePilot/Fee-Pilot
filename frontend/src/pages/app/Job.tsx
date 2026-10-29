import { AnimatePresence, motion } from 'motion/react';
import { Link, useNavigate, useParams } from 'react-router';
import { useJob } from '@/api/hooks';
import type { JobState } from '@/api/schemas';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import { Handoff } from '@/features/recover/Handoff';
import { Banner } from '@/features/shared/Banner';
import { Timeline } from '@/features/job/Timeline';
import {
  describeHistory,
  errorText,
  isActive,
  ROUTE_LABELS,
} from '@/features/shared/labels';
import { formatSats, shortId } from '@/lib/format';
import { fadeUp, spring, stagger } from '@/lib/motion';
import { Seo } from '@/seo/Seo';

const banners: Partial<
  Record<JobState, [tone: 'info' | 'ok' | 'warn', text: string]>
> = {
  broadcasting: ['info', 'Broadcasting…'],
  broadcast: [
    'info',
    'Broadcast. Waiting for a miner to include it. This can take minutes to hours depending on the fee rate, and is never guaranteed.',
  ],
  confirmed: [
    'ok',
    'Confirmed. Not final yet: FeePilot keeps watching in case of a reorg.',
  ],
  settled: [
    'ok',
    'Settled. It has enough confirmations that a reorg is no longer a practical concern.',
  ],
  obsolete: [
    'warn',
    'This job is obsolete: the original transaction confirmed or was replaced by someone else before you signed.',
  ],
};

function Row({
  k,
  children,
  mono,
}: {
  k: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd
        className={`min-w-0 break-all ${mono ? 'font-mono text-xs leading-5' : ''}`}
      >
        {children}
      </dd>
    </>
  );
}

function JobSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading job">
      <Skeleton className="h-8 w-64" />
      <Card className="grid gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </Card>
      <Card className="grid gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </Card>
    </div>
  );
}

export default function Job() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { job, history, result } = useJob(id);

  const seo = (
    <Seo
      title="Recovery job"
      description="Track a FeePilot recovery job."
      path="/app"
      noindex
    />
  );

  if (!job && result && !result.ok) {
    return (
      <div className="grid gap-5">
        {seo}
        <h1 className="text-3xl font-semibold tracking-tight">Recovery job</h1>
        <Banner tone="bad" role="alert">
          <b>
            {result.code === 'not_found'
              ? 'Job not found.'
              : 'Could not load this job.'}
          </b>{' '}
          {errorText(result)}
          {result.code !== 'not_found'
            ? ' It is polled again automatically.'
            : ''}
        </Banner>
        <div>
          <Link
            to="/app"
            className="text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Start a recovery
          </Link>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <>
        {seo}
        <JobSkeleton />
      </>
    );
  }

  const note = banners[job.state];
  const active = isActive(job.state);
  const stale = result && !result.ok;

  return (
    <motion.div
      variants={stagger(0.08)}
      initial="hidden"
      animate="show"
      className="grid gap-5"
    >
      {seo}
      <motion.div
        variants={fadeUp}
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <h1 className="text-3xl font-semibold tracking-tight">Recovery job</h1>
        {active ? (
          <Pill tone="ok">
            <span
              className="size-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none"
              aria-hidden="true"
            />{' '}
            Live
          </Pill>
        ) : (
          <Pill>Finished</Pill>
        )}
      </motion.div>
      {stale ? (
        <Banner tone="warn" role="status">
          Could not refresh just now ({errorText(result)}). Showing the last
          state we have; trying again.
        </Banner>
      ) : null}
      <Card className="grid gap-6 p-5 sm:p-7">
        <Timeline state={job.state} />
        {note ? (
          <Banner tone={note[0]} role="status">
            {note[1]}
          </Banner>
        ) : null}
        <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-2">
          <Row k="Route">{ROUTE_LABELS[job.route]}</Row>
          <Row k="Original" mono>
            {job.txid}
          </Row>
          {job.recovery_txid ? (
            <Row k="Recovery" mono>
              {job.recovery_txid}
            </Row>
          ) : null}
          <Row k="Extra fee">{formatSats(job.extra_fee_sat)} sats</Row>
          <Row k="Job" mono>
            {job.id}
          </Row>
        </dl>
      </Card>

      {job.state === 'awaiting_signature' ? (
        <Handoff
          summary={{
            jobId: job.id,
            route: job.route,
            txid: job.txid,
            psbt: job.unsigned_psbt,
            extraFeeSat: job.extra_fee_sat,
          }}
        />
      ) : null}

      <Card className="p-5 sm:p-7">
        <h2 className="text-lg font-semibold tracking-tight">History</h2>
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No changes recorded yet. The tracker records an entry whenever a
            status changes.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line" aria-live="polite">
            <AnimatePresence initial={false}>
              {[...history].reverse().map((e) => (
                <motion.li
                  key={`${e.observed_at}-${e.status}-${e.txid}`}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0 }}
                  transition={spring.soft}
                  className="overflow-hidden"
                >
                  <div className="grid gap-1 py-3 sm:grid-cols-[13rem_1fr_auto] sm:gap-4">
                    <time
                      className="text-xs text-muted sm:pt-0.5"
                      dateTime={e.observed_at}
                    >
                      {new Date(e.observed_at).toLocaleString()}
                    </time>
                    <span className="text-sm">{describeHistory(e)}</span>
                    <code
                      className="font-mono text-xs text-muted"
                      title={e.txid}
                    >
                      {shortId(e.txid)}
                    </code>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>
      <motion.div variants={fadeUp}>
        <Button variant="secondary" onClick={() => void navigate('/app')}>
          Start another recovery
        </Button>
      </motion.div>
    </motion.div>
  );
}
