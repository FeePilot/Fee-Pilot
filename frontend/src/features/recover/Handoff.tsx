import { zodResolver } from '@hookform/resolvers/zod';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import type { RouteKind } from '@/api/schemas';
import { useSubmitJob } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormCheckbox } from '@/components/ui/form';
import { CopyIcon, DownloadIcon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { Banner, FormError } from '@/features/shared/Banner';
import { errorText, ROUTE_LABELS } from '@/features/shared/labels';
import { textareaClass } from '@/features/shared/ui';
import { formatSats } from '@/lib/format';
import { fadeUp, stagger } from '@/lib/motion';
import {
  approveSchema,
  signedSchema,
  type ApproveInput,
  type SignedInput,
} from './schemas';

export type HandoffSummary = {
  jobId: string;
  route: RouteKind;
  txid: string;
  psbt: string;
  extraFeeSat: number;
  newFeeSat?: number | undefined;
  description?: string | undefined;
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

/** Step 3b: sign elsewhere, paste the result, then approve explicitly. Nothing is broadcast until the modal is confirmed. */
export function Handoff({ summary }: { summary: HandoffSummary }) {
  const toast = useToast();
  const navigate = useNavigate();
  const submit = useSubmitJob(summary.jobId);
  const [open, setOpen] = useState(false);
  const [signedPsbt, setSignedPsbt] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [copied, setCopied] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const signedForm = useForm<SignedInput>({
    resolver: zodResolver(signedSchema),
    mode: 'onTouched',
    defaultValues: { signed: '' },
  });
  const approveForm = useForm<ApproveInput, unknown, ApproveInput>({
    resolver: zodResolver(approveSchema),
    defaultValues: { approved: false },
  });
  const approved = useWatch({ control: approveForm.control, name: 'approved' });

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: false });
  }, []);

  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([summary.psbt], { type: 'text/plain' }),
    );
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [summary.psbt]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary.psbt);
      setCopied(true);
      toast({ title: 'PSBT copied', tone: 'ok' });
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({
        title: 'Could not copy',
        description: 'Select the text and copy it manually.',
        tone: 'warn',
      });
    }
  }

  function openApprove(values: SignedInput) {
    setSignedPsbt(values.signed.trim());
    setSubmitError('');
    approveForm.reset({ approved: false });
    setOpen(true);
  }

  async function confirm() {
    setSubmitError('');
    const res = await submit.mutateAsync(signedPsbt);
    if (res.ok) {
      setOpen(false);
      toast({
        title: 'Broadcast requested',
        description: 'FeePilot is now tracking the transaction.',
        tone: 'ok',
      });
      void navigate(`/app/jobs/${summary.jobId}`);
    } else {
      const text = errorText(res);
      setSubmitError(text);
      toast({ title: 'Not broadcast', description: text, tone: 'bad' });
    }
  }

  return (
    <motion.div
      variants={stagger(0.08)}
      initial="hidden"
      animate="show"
      className="grid gap-5"
    >
      <Card className="grid gap-5 p-5 sm:p-7">
        <motion.div variants={fadeUp}>
          <h2
            ref={titleRef}
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight outline-none"
          >
            Sign in your own wallet
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This PSBT is unsigned. Open it in a wallet that holds the keys
            (Sparrow, Bitcoin Core, a hardware signer), sign it, and bring the
            signed PSBT back. FeePilot refuses a signed PSBT whose inputs,
            outputs or amounts differ from this one.
          </p>
        </motion.div>
        <motion.dl
          variants={fadeUp}
          className="grid gap-x-5 gap-y-1 rounded-xl border border-line bg-surface-2/50 p-4 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-2"
        >
          <Row k="Route">{ROUTE_LABELS[summary.route]}</Row>
          <Row k="Original transaction" mono>
            {summary.txid}
          </Row>
          {summary.newFeeSat !== undefined ? (
            <Row k="New fee">{formatSats(summary.newFeeSat)} sats</Row>
          ) : null}
          <Row k="Extra network fee">
            {formatSats(summary.extraFeeSat)} sats
          </Row>
          {summary.description ? (
            <Row k="What it does">{summary.description}</Row>
          ) : null}
          <Row k="Job" mono>
            {summary.jobId}
          </Row>
        </motion.dl>
        <motion.div variants={fadeUp} className="grid gap-2">
          <label htmlFor="unsigned-psbt" className="text-sm font-medium">
            Unsigned PSBT
          </label>
          <textarea
            id="unsigned-psbt"
            readOnly
            rows={5}
            value={summary.psbt}
            onFocus={(e) => e.currentTarget.select()}
            className={textareaClass}
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              <CopyIcon /> {copied ? 'Copied' : 'Copy PSBT'}
            </Button>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download={`feepilot-${summary.jobId.slice(0, 8)}.psbt`}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg backdrop-blur transition-colors hover:bg-surface-2"
              >
                <DownloadIcon /> Download .psbt
              </a>
            ) : null}
          </div>
          <details className="text-sm text-muted">
            <summary className="cursor-pointer py-1 select-none hover:text-fg">
              Sign with Bitcoin Core (regtest)
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface-2/70 p-3 font-mono text-xs leading-relaxed text-fg">{`bitcoin-cli -rpcwallet=<wallet> walletprocesspsbt "${summary.psbt.slice(0, 24)}…"\n# copy the "psbt" field of the result and paste it below\n# or run: scripts/demo-sign.sh <psbt>`}</pre>
          </details>
        </motion.div>
      </Card>

      <Card className="p-5 sm:p-7">
        <h3 className="text-lg font-semibold tracking-tight">
          Then paste it back signed
        </h3>
        <form
          noValidate
          className="mt-4 grid gap-4"
          onSubmit={(e) => {
            void signedForm.handleSubmit(openApprove)(e);
          }}
        >
          <div className="grid gap-1.5">
            <label htmlFor="signed-psbt" className="text-sm font-medium">
              Signed PSBT
            </label>
            <textarea
              id="signed-psbt"
              rows={5}
              spellCheck={false}
              placeholder="Paste the signed PSBT (base64) here"
              aria-invalid={
                signedForm.formState.errors.signed ? true : undefined
              }
              aria-describedby={
                signedForm.formState.errors.signed ? 'signed-error' : undefined
              }
              className={textareaClass}
              {...signedForm.register('signed')}
            />
            {signedForm.formState.errors.signed ? (
              <p
                id="signed-error"
                role="alert"
                className="text-xs font-medium text-bad"
              >
                {signedForm.formState.errors.signed.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Approve and broadcast</Button>
            <span className="text-xs text-muted">
              You will be asked to confirm before anything is sent.
            </span>
          </div>
        </form>
      </Card>

      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!submit.isPending) setOpen(o);
        }}
        title="Approve broadcast"
        description="Broadcasting spends your coins and cannot be undone by FeePilot."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submit.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void approveForm.handleSubmit(confirm)()}
              disabled={!approved}
              loading={submit.isPending}
            >
              Confirm and broadcast
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Banner tone="warn">
            Route: {ROUTE_LABELS[summary.route]}. Extra network fee:{' '}
            {formatSats(summary.extraFeeSat)} sats. A higher fee improves the
            odds of confirmation but never guarantees it.
          </Banner>
          <FormCheckbox
            control={approveForm.control}
            name="approved"
            label="I have reviewed the transaction and approve broadcasting it"
          />
          <FormError>{submitError}</FormError>
        </div>
      </Modal>
    </motion.div>
  );
}
