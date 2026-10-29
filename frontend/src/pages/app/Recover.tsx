import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAnalyze, useCreateJob } from '@/api/hooks';
import type { JobCreated, Recommendation } from '@/api/schemas';
import { Stepper } from '@/components/ui/Stepper';
import { useToast } from '@/components/ui/Toast';
import { Builder, type BuildRequest } from '@/features/recover/Builder';
import { Compare } from '@/features/recover/Compare';
import { FindForm } from '@/features/recover/FindForm';
import { Handoff } from '@/features/recover/Handoff';
import type { FindValues } from '@/features/recover/schemas';
import { errorText } from '@/features/shared/labels';
import { isTxid } from '@/lib/format';
import { duration, ease } from '@/lib/motion';
import { Seo } from '@/seo/Seo';

const STEPS = ['Find', 'Compare', 'Sign', 'Track'];

type Stage =
  | { name: 'find' }
  | { name: 'compare' }
  | { name: 'build'; kind: 'rbf' | 'cpfp' }
  | { name: 'sign'; created: JobCreated };

const swap = {
  initial: { opacity: 0, y: 14 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: ease.out },
  },
  exit: { opacity: 0, y: -8, transition: { duration: duration.fast } },
};

export default function Recover() {
  const toast = useToast();
  const [params] = useSearchParams();
  const prefill = params.get('txid') ?? '';
  const analyze = useAnalyze();
  const createJob = useCreateJob();

  const [stage, setStage] = useState<Stage>({ name: 'find' });
  const [form, setForm] = useState<FindValues | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Move focus to the new step so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headRef.current?.focus();
  }, [stage.name]);

  const current =
    stage.name === 'find'
      ? 1
      : stage.name === 'compare' || stage.name === 'build'
        ? 2
        : 3;

  async function onAnalyze(values: FindValues): Promise<string | null> {
    const res = await analyze.mutateAsync({
      txid: values.txid,
      urgency: values.urgency,
      budget: values.budget,
      canSign: values.canSign,
      controls: values.controls,
      outputValue: values.outputValue,
    });
    if (!res.ok) {
      toast({
        title: 'Could not analyze',
        description: errorText(res),
        tone: 'bad',
      });
      return errorText(res);
    }
    setForm(values);
    setRec(res.body);
    setStage({ name: 'compare' });
    return null;
  }

  async function onBuild(req: BuildRequest): Promise<string | null> {
    if (!form) return 'Start again from step 1.';
    const base = {
      txid: form.txid,
      urgency: form.urgency,
      ...(form.budget !== null ? { max_budget_sat: form.budget } : {}),
    };
    const res = await createJob.mutateAsync(
      req.kind === 'rbf'
        ? { kind: 'rbf', ...base, change_vout: req.vout }
        : {
            kind: 'cpfp',
            ...base,
            vout: req.vout,
            destination: req.destination,
          },
    );
    if (!res.ok) {
      toast({
        title: 'Could not build the PSBT',
        description: errorText(res),
        tone: 'bad',
      });
      return errorText(res);
    }
    toast({
      title: 'Unsigned PSBT ready',
      description: 'Nothing has been signed or sent.',
      tone: 'ok',
    });
    setStage({ name: 'sign', created: res.body });
    return null;
  }

  const restart = () => {
    setRec(null);
    setStage({ name: 'find' });
  };

  return (
    <div className="grid gap-6">
      <Seo
        title="Recover a transaction"
        description="Compare ways to unstick a Bitcoin transaction."
        path="/app"
        noindex
      />
      <header className="grid gap-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Unstick a Bitcoin transaction
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
          Enter a txid. FeePilot explains why it is slow, compares fee-bumping
          routes with their real cost, and hands you an unsigned PSBT to sign in
          your own wallet. It never holds your keys and never broadcasts without
          your approval.
        </p>
      </header>
      <Stepper steps={STEPS} current={current} />
      <div
        ref={headRef}
        tabIndex={-1}
        className="outline-none"
        aria-live="polite"
      >
        <span className="sr-only">
          Step {current} of 4: {STEPS[current - 1]}
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={
            stage.name === 'compare' || stage.name === 'build'
              ? 'compare'
              : stage.name
          }
          {...swap}
        >
          {stage.name === 'find' ? (
            <FindForm
              initialTxid={isTxid(prefill) ? prefill : (form?.txid ?? '')}
              onAnalyze={onAnalyze}
            />
          ) : null}
          {(stage.name === 'compare' || stage.name === 'build') && rec ? (
            <div className="grid gap-5">
              <Compare
                rec={rec}
                onBuild={(kind) => setStage({ name: 'build', kind })}
                onBack={restart}
              />
              {stage.name === 'build' ? (
                <Builder
                  key={stage.kind}
                  kind={stage.kind}
                  txid={form?.txid ?? ''}
                  onBuild={onBuild}
                  onCancel={() => setStage({ name: 'compare' })}
                />
              ) : null}
            </div>
          ) : null}
          {stage.name === 'sign' && form ? (
            <Handoff
              summary={{
                jobId: stage.created.job_id,
                route: stage.created.route,
                txid: form.txid,
                psbt: stage.created.psbt,
                extraFeeSat: stage.created.extra_fee_sat,
                newFeeSat: stage.created.fee_sat,
                description: stage.created.description,
              }}
            />
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
