import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { FormInput } from '@/components/ui/form';
import { FormError } from '@/features/shared/Banner';
import { MEMO_MAX } from '@/lib/queue';

export const orderSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(
      /^[1-9]\d*$/,
      'Enter the amount as a whole number of sats, above zero.',
    ),
  memo: z
    .string()
    .trim()
    .max(MEMO_MAX, `Keep the memo to ${MEMO_MAX} characters or fewer.`),
  txid: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^[0-9a-fA-F]{64}$/.test(v),
      'A txid is 64 hexadecimal characters.',
    ),
});
export type OrderFormInput = z.input<typeof orderSchema>;
export type OrderFormValues = z.output<typeof orderSchema>;

/** `onSave` resolves to an error message, or null when the note was stored. */
export function OrderForm({
  onSave,
}: {
  onSave: (v: OrderFormValues) => Promise<string | null>;
}) {
  const { control, handleSubmit, reset, setError, formState } = useForm<
    OrderFormInput,
    unknown,
    OrderFormValues
  >({
    resolver: zodResolver(orderSchema),
    mode: 'onTouched',
    defaultValues: { amount: '', memo: '', txid: '' },
  });
  return (
    <form
      noValidate
      autoComplete="off"
      className="grid gap-5"
      onSubmit={handleSubmit(async (v) => {
        const err = await onSave(v);
        if (err) setError('root', { message: err });
        else reset();
      })}
    >
      <div className="grid items-start gap-5 sm:grid-cols-3">
        <FormInput
          control={control}
          name="amount"
          label="Amount (sats)"
          inputMode="numeric"
        />
        <FormInput
          control={control}
          name="memo"
          label="Memo (optional)"
          maxLength={MEMO_MAX + 40}
          hint={`Up to ${MEMO_MAX} characters.`}
        />
        <FormInput
          control={control}
          name="txid"
          label="Txid (optional)"
          mono
          spellCheck={false}
          placeholder="64 hex characters"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={formState.isSubmitting}>
          Save note
        </Button>
        <FormError>{formState.errors.root?.message}</FormError>
      </div>
    </form>
  );
}
