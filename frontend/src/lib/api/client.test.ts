import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { request } from './client';

const schema = z.object({ n: z.number() });

function respond(status: number, body: unknown, ok = status < 400) {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('returns the validated body of a success envelope', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, { status: 200, message: 'OK', body: { n: 3 } }),
    );
    expect(await request('/v2/x', schema)).toEqual({
      ok: true,
      status: 200,
      message: 'OK',
      body: { n: 3 },
    });
  });

  it('sends JSON for a POST', async () => {
    const f = respond(200, { status: 200, message: 'OK', body: { n: 1 } });
    vi.stubGlobal('fetch', f);
    await request('/v2/x', schema, { method: 'POST', json: { a: 1 } });
    const call = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/v2/x');
    expect(call[1].method).toBe('POST');
    expect(call[1].body).toBe('{"a":1}');
  });

  it('turns an error envelope into code and message', async () => {
    vi.stubGlobal(
      'fetch',
      respond(404, {
        status: 404,
        message: 'No such job.',
        body: { code: 'not_found' },
      }),
    );
    expect(await request('/v2/x', schema)).toEqual({
      ok: false,
      status: 404,
      message: 'No such job.',
      code: 'not_found',
    });
  });

  it('reports a network error with status 0 and never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const r = await request('/v2/x', schema);
    expect(r).toMatchObject({ ok: false, status: 0, code: 'network_error' });
  });

  it('reports a non-JSON response as bad_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('x')),
        } as unknown as Response),
      ),
    );
    expect(await request('/v2/x', schema)).toMatchObject({
      ok: false,
      status: 200,
      code: 'bad_response',
    });
  });

  it('reports a schema mismatch as bad_response', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, { status: 200, message: 'OK', body: { n: 'three' } }),
    );
    expect(await request('/v2/x', schema)).toMatchObject({
      ok: false,
      code: 'bad_response',
    });
  });

  it('reports an error status without an envelope as bad_response', async () => {
    vi.stubGlobal('fetch', respond(502, { error: 'bad gateway' }));
    expect(await request('/v2/x', schema)).toMatchObject({
      ok: false,
      status: 502,
      code: 'bad_response',
    });
  });
});
