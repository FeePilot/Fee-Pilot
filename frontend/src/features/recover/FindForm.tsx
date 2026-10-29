import { zodResolver } from '@hookform/resolvers/zod';
import { AnimatePresence, motion } from 'motion/react';
import { useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FormInput, FormSelect, FormToggleGroup } from '@/components/ui/form';
import { ArrowRightIcon } from '@/components/ui/icons';
import { spring } from '@/lib/motion';
import { FormError } from '@/features/shared/Banner';
import { findSchema, type FindInput, type FindValues } from './schemas';

const urgencyOptions = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
];
const canSignOptions = [
  { value: 'unknown', label: 'Not sure' },
  { value: 'yes', label: 'Yes, I sent it' },
  { value: 'no', label: 'No' },
];
const controlsOptions = [
  { value: 'unknown', label: 'Not sure' },
  { value: 'yes', label: 'Yes, I received it' },
  { value: 'no', label: 'No' },
];

/** Step 1: which transaction, and what you know about it. `onAnalyze` resolves to an error message or null. */
export function FindForm({
  initialTxid = '',
  onAnalyze,
}: {
  initialTxid?: string;
  onAnalyze: (values: FindValues) => Promise<string | null>;
}) {
  const { control, handleSubmit, setError, formState } = useForm<
    FindInput,
    unknown,
    FindValues
  >({
    resolver: zodResolver(findSchema),
    mode: 'onTouched',
    defaultValues: {
      txid: initialTxid,
      urgency: 'normal',
      budget: '',
      canSign: 'unknown',
      controls: 'unknown',
      outputValue: '',
    },
  });
  const controls = useWatch({ control, name: 'controls' });

  return (
    <Card className="p-5 sm:p-7">
      <h2 className="text-xl font-semibold tracking-tight">
        Find the transaction
      </h2>
      <p className="mt-1.5 text-sm text-muted">
        Paste the id of the stuck transaction. FeePilot reads it from your node;
        nothing is signed or sent.
      </p>
      <form
        noValidate
        autoComplete="off"
        className="mt-6 grid gap-5"
        onSubmit={handleSubmit(async (values) => {
          const err = await onAnalyze(values);
          if (err) setError('root', { message: err });
        })}
      >
        <FormInput
          control={control}
          name="txid"
          label="Transaction id"
          mono
          spellCheck={false}
          placeholder="64 hex characters"
          maxLength={64}
        />
        <FormToggleGroup
          control={control}
          name="urgency"
          label="How aggressively to bump the fee"
          options={urgencyOptions}
          hint="How high RBF and CPFP aim: 0.5x, 1x or 1.5x the next-block rate. No paid service, and no guarantee of confirmation."
        />
        <div className="grid items-start gap-5 sm:grid-cols-2">
          <FormInput
            control={control}
            name="budget"
            label="Max extra fee (sats), optional"
            inputMode="numeric"
            placeholder="no limit"
            hint="Optional. Leave empty and FeePilot works out the fee itself and recommends the cheapest route that works. Fill it in only to set a ceiling: routes costing more than this are marked not possible. This is a limit in sats, not a fee rate."
          />
          <FormSelect
            control={control}
            name="canSign"
            label="Can you sign for the original inputs?"
            options={canSignOptions}
          />
          <FormSelect
            control={control}
            name="controls"
            label="Do you control an output of it?"
            options={controlsOptions}
          />
          <AnimatePresence initial={false}>
            {controls === 'yes' ? (
              <motion.div
                key="out"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.soft}
                className="-m-1 overflow-hidden p-1"
              >
                <FormInput
                  control={control}
                  name="outputValue"
                  label="Value of that output (sats)"
                  inputMode="numeric"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          &ldquo;Not sure&rdquo; is fine: a route that depends on it is shown as
          unknown and is never recommended.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" loading={formState.isSubmitting}>
            {formState.isSubmitting ? 'Analyzing' : 'Analyze'}
            {formState.isSubmitting ? null : <ArrowRightIcon />}
          </Button>
          <FormError>{formState.errors.root?.message}</FormError>
        </div>
      </form>
    </Card>
  );
}
