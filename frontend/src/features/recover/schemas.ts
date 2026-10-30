import { z } from 'zod';

const TXID = /^[0-9a-fA-F]{64}$/;

export const txidField = z
  .string()
  .trim()
  .regex(TXID, 'A txid is 64 hexadecimal characters.')
  .transform((s) => s.toLowerCase());

/** An optional whole number typed as text: '' means "not given". */
const optionalSats = (what: string) =>
  z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^\d+$/.test(v),
      `${what} must be a whole number of sats, or left empty.`,
    )
    .transform((v) => (v === '' ? null : Number(v)));

const triState = z.enum(['unknown', 'yes', 'no']);

export const findSchema = z.object({
  txid: txidField,
  urgency: z.enum(['low', 'normal', 'high']),
  canSign: triState,
  controls: triState,
  outputValue: optionalSats('The output value'),
});
export type FindInput = z.input<typeof findSchema>;
export type FindValues = z.output<typeof findSchema>;

const voutField = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Enter the output index as a whole number, starting at 0.')
  .transform(Number);

export const rbfSchema = z.object({ vout: voutField });
export type RbfInput = z.input<typeof rbfSchema>;
export type RbfValues = z.output<typeof rbfSchema>;

export const cpfpSchema = z.object({
  vout: voutField,
  destination: z
    .string()
    .trim()
    .min(14, 'Enter the full address you want the remainder sent to.')
    .max(120, 'That address is too long.')
    .regex(/^[0-9A-Za-z]+$/, 'An address uses only letters and digits.'),
});
export type CpfpInput = z.input<typeof cpfpSchema>;
export type CpfpValues = z.output<typeof cpfpSchema>;

export const signedSchema = z.object({
  signed: z
    .string()
    .trim()
    .min(1, 'Paste the signed PSBT from your wallet.')
    .regex(
      /^[A-Za-z0-9+/=\s]+$/,
      'A PSBT is base64 text. Check that you copied the whole value.',
    ),
});
export type SignedInput = z.input<typeof signedSchema>;

export const approveSchema = z.object({
  approved: z
    .boolean()
    .refine((v) => v === true, 'Tick the box to approve broadcasting.'),
});
export type ApproveInput = z.input<typeof approveSchema>;

export const triToBool = (v: 'unknown' | 'yes' | 'no'): boolean | null =>
  v === 'unknown' ? null : v === 'yes';
