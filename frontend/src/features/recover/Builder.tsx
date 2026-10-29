import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormInput } from '@/components/ui/form';
import { FormError } from '@/features/shared/Banner';
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
  onBuild,
  onCancel,
}: {
  kind: 'rbf' | 'cpfp';
  onBuild: (req: BuildRequest) => Promise<string | null>;
  onCancel: () => void;
}) {
  return kind === 'rbf' ? (
    <RbfForm onBuild={onBuild} onCancel={onCancel} />
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

function RbfForm({ onBuild, onCancel }: Props) {
  const { control, handleSubmit, setError, formState } = useForm<
    RbfInput,
    unknown,
    RbfValues
  >({
    resolver: zodResolver(rbfSchema),
    mode: 'onTouched',
    defaultValues: { vout: '1' },
  });
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
      <FormInput
        control={control}
        name="vout"
        label="Your change output (vout index)"
        inputMode="numeric"
        hint="The output that pays you back. The fee increase is taken from it."
      />
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
