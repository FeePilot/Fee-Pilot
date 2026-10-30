import type { z } from 'zod';
import {
  CLIENT_CODES,
  envelopeSchema,
  errorEnvelopeSchema,
  type ApiResult,
} from './envelope';
import { apiPath } from '../network';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export type RequestOptions = {
  method?: 'GET' | 'POST';
  json?: unknown;
  signal?: AbortSignal;
};

/**
 * Call a `/v2` endpoint and validate the response against `schema`.
 * Resolves to an `ApiResult`; it never rejects. A network failure is `{ ok: false, status: 0 }`
 * and a response that does not match the schema is `bad_response`, so the UI never renders
 * data it has not checked.
 */
export async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<ApiResult<z.infer<S>>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${apiPath(path)}`, {
      method: options.method ?? 'GET',
      headers:
        options.json === undefined
          ? undefined
          : { 'content-type': 'application/json' },
      body:
        options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: options.signal ?? null,
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: CLIENT_CODES.network,
      message: 'Cannot reach the FeePilot API.',
    };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return badResponse(
      res.status,
      'The server sent something that is not JSON.',
    );
  }

  if (res.ok) {
    const parsed = envelopeSchema(schema).safeParse(raw);
    if (!parsed.success)
      return badResponse(res.status, 'The server sent an unexpected response.');
    // Zod's generic output type is too deep for TypeScript to see `body` through, so name it.
    const data = parsed.data as {
      status: number;
      message: string;
      body: z.infer<S>;
    };
    return {
      ok: true,
      status: data.status,
      message: data.message,
      body: data.body,
    };
  }

  const err = errorEnvelopeSchema.safeParse(raw);
  if (!err.success)
    return badResponse(res.status, `Request failed (${res.status}).`);
  return {
    ok: false,
    status: err.data.status,
    message: err.data.message,
    code: err.data.body.code,
  };
}

function badResponse(status: number, message: string): ApiResult<never> {
  return { ok: false, status, code: CLIENT_CODES.badResponse, message };
}
