import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { useTxOutputs } from '@/api/hooks';
import type { TxOutput } from '@/api/schemas';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormInput } from '@/components/ui/form';
import { FormError } from '@/features/shared/Banner';
import { formatSats } from '@/lib/format';
import {
  cpfpSchema,
  rbfSchema,
  type CpfpInput,
  type CpfpValues,
  type RbfInput,
  type RbfValues,
} from './schemas';

export type BuildRequest =
  | { kind: 'rbf'; vout: number }
  | { kind: 'cpfp'; vout: number; destination: string };

/** Step 3a: the one or two facts FeePilot cannot read from the chain. `onBuild` resolves to an error message or null. */
export function Builder({
  kind,
  txid,
  onBuild,
  onCancel,
}: {
  kind: 'rbf' | 'cpfp';
  txid: string;
  onBuild: (req: BuildRequest) => Promise<string | null>;
  onCancel: () => void;
}) {
  return kind === 'rbf' ? (
    <RbfForm txid={txid} onBuild={onBuild} onCancel={onCancel} />
  ) : (
    <CpfpForm onBuild={onBuild} onCancel={onCancel} />
  );
}

type Props = {
  onBuild: (req: BuildRequest) => Promise<string | null>;
  onCancel: () => void;
};

function Shell({
  title,
  children,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  title: string;
  children: React.ReactNode;
  busy: boolean;
  error?: string | undefined;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    ref.current?.querySelector('input')?.focus({ preventScroll: true });
  }, []);
  return (
    <Card className="p-5 sm:p-7" ref={ref}>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <form
        noValidate
        autoComplete="off"
        onSubmit={onSubmit}
        className="mt-5 grid gap-5"
      >
        {children}
        <p className="text-xs leading-relaxed text-muted">
          FeePilot builds this from public chain data. Nothing is signed or sent
          yet.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={busy}>
            Build unsigned PSBT
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Back to routes
          </Button>
          <FormError>{error}</FormError>
        </div>
      </form>
    </Card>
  );
}

function outputTag(o: TxOutput): string | null {
  if (o.is_change) return 'Looks like your change';
  if (o.is_mine) return 'Yours, but not change';
  return null;
}

/** Radio list of the transaction's outputs; `value` is the chosen vout as text. */
function OutputPicker({
  outputs,
  value,
  onChange,
  error,
}: {
  outputs: TxOutput[];
  value: string;
  onChange: (vout: string) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">
        Which output is your change?
      </legend>
      {outputs.map((o) => {
        const tag = outputTag(o);
        const checked = value === String(o.vout);
        return (
          <label
            key={o.vout}
            htmlFor={`change-output-${o.vout}`}
            aria-label={`Output ${o.vout}, ${formatSats(o.value_sat)} sats`}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors ${
              checked
                ? 'border-line-strong bg-surface-2'
                : 'border-line hover:bg-surface-2/60'
            }`}
          >
            <input
              id={`change-output-${o.vout}`}
              type="radio"
              name="change-output"
              className="mt-1"
              checked={checked}
              onChange={() => onChange(String(o.vout))}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium">
                Output {o.vout}: {formatSats(o.value_sat)} sats
                {tag ? (
                  <span className="ml-2 text-xs font-normal text-muted">
                    {tag}
                  </span>
                ) : null}
              </span>
              <code className="font-mono text-xs break-all text-muted">
                {o.address ?? 'no address'}
              </code>
            </span>
          </label>
        );
      })}
      <p className="text-xs leading-relaxed text-muted">
        The fee increase is taken from the output you choose, so pick the one
        that pays you back, not the payment to someone else.
        {outputs.every((o) => o.is_change === null)
          ? ' FeePilot could not check which output is yours, so it did not pre-select one.'
          : ''}
      </p>
      {error ? (
        <p role="alert" className="text-xs font-medium text-bad">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function RbfForm({ txid, onBuild, onCancel }: Props & { txid: string }) {
  const { control, handleSubmit, setError, setValue, watch, formState } =
    useForm<RbfInput, unknown, RbfValues>({
      resolver: zodResolver(rbfSchema),
      mode: 'onTouched',
      defaultValues: { vout: '' },
    });
  const outputsQuery = useTxOutputs(txid);
  const res = outputsQuery.data;
  const outputs = useMemo(() => (res?.ok ? res.body.outputs : []), [res]);
  const picking = outputs.length > 0;

  // Pre-select only when exactly one output is known to be change; otherwise the user chooses.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !picking) return;
    preselected.current = true;
    const change = outputs.filter((o) => o.is_change === true);
    if (change.length === 1 && change[0])
      setValue('vout', String(change[0].vout));
  }, [picking, outputs, setValue]);

  return (
    <Shell
      title="Build the replacement"
      busy={formState.isSubmitting}
      error={formState.errors.root?.message}
      onCancel={onCancel}
      onSubmit={(e) => {
        void handleSubmit(async (v) => {
          const err = await onBuild({ kind: 'rbf', vout: v.vout });
          if (err) setError('root', { message: err });
        })(e);
      }}
    >
      {outputsQuery.isPending ? (
        <p className="text-sm text-muted">Reading the transaction's outputs…</p>
      ) : picking ? (
        <OutputPicker
          outputs={outputs}
          value={watch('vout')}
          onChange={(v) =>
            setValue('vout', v, { shouldValidate: true, shouldTouch: true })
          }
          error={
            formState.errors.vout
              ? 'Choose which output is your change.'
              : undefined
          }
        />
      ) : (
        <FormInput
          control={control}
          name="vout"
          label="Your change output (vout index)"
          inputMode="numeric"
          hint="FeePilot could not list the outputs, so enter the number of the output that pays you back (0 is the first). The fee increase is taken from it."
        />
      )}
    </Shell>
  );
}

function CpfpForm({ onBuild, onCancel }: Props) {
  const { control, handleSubmit, setError, formState } = useForm<
    CpfpInput,
    unknown,
    CpfpValues
  >({
    resolver: zodResolver(cpfpSchema),
    mode: 'onTouched',
    defaultValues: { vout: '0', destination: '' },
  });
  return (
    <Shell
      title="Build the child transaction"
      busy={formState.isSubmitting}
      error={formState.errors.root?.message}
      onCancel={onCancel}
      onSubmit={(e) => {
        void handleSubmit(async (v) => {
          const err = await onBuild({
            kind: 'cpfp',
            vout: v.vout,
            destination: v.destination,
          });
          if (err) setError('root', { message: err });
        })(e);
      }}
    >
      <FormInput
        control={control}
        name="vout"
        label="Output you control (vout index)"
        inputMode="numeric"
      />
      <FormInput
        control={control}
        name="destination"
        label="Send the remainder to (your address)"
        mono
        spellCheck={false}
        placeholder="bcrt1…, tb1…, bc1…"
      />
    </Shell>
  );
}
