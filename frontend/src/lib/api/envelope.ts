import { z } from 'zod';

/** What every `/v2` response looks like. `body` is the real payload. */
export type Envelope<T> = { status: number; message: string; body: T };

/** The result of an API call. Never thrown: callers branch on `ok`. */
export type ApiResult<T> =
  | { ok: true; status: number; message: string; body: T }
  | { ok: false; status: number; message: string; code: string };

export const errorBodySchema = z.object({ code: z.string() });

export function envelopeSchema<T extends z.ZodType>(body: T) {
  return z.object({ status: z.number().int(), message: z.string(), body });
}

export const errorEnvelopeSchema = envelopeSchema(errorBodySchema);

/** Stable codes the client produces itself, on top of the ones the server sends. */
export const CLIENT_CODES = {
  network: 'network_error',
  badResponse: 'bad_response',
} as const;
