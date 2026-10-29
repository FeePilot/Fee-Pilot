import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { STORE_KEY } from '@/lib/advisor';
import { memoryBackend, orderQueue } from '@/lib/queue';
import {
  resetReachability,
  useAnalyze,
  useCreateJob,
  useFees,
  useJob,
  useOnline,
  useOrders,
  useSubmitJob,
} from './hooks';
import {
  JOB_ID,
  TXID,
  feesFixture,
  historyFixture,
  jobCreatedFixture,
  jobFixture,
  recommendationFixture,
  snapshotFixture,
  syncFixture,
} from './fixtures';

type Handler = (
  url: string,
  init?: RequestInit,
) => { status: number; body: unknown } | 'network';

function stubFetch(handler: Handler) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init);
    if (r === 'network') throw new TypeError('Failed to fetch');
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const env = (body: unknown, status = 200, message = 'OK') => ({
  status,
  body: { status, message, body },
});
const err = (status: number, code: string, message = 'Nope.') => ({
  status,
  body: { status, message, body: { code } },
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  localStorage.clear();
  resetReachability();
});
afterEach(() => vi.unstubAllGlobals());

describe('useFees', () => {
  it('is loading first, then live, and stores the snapshot, policy and offset', async () => {
    stubFetch(() =>
      env(feesFixture({ server_time: Math.floor(Date.now() / 1000) + 100 })),
    );
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('live'));
    expect(result.current.fees?.snapshot.fetched_at).toBe(1_700_000_000);
    expect(result.current.error).toBeNull();
    expect(Math.abs(result.current.clockOffsetSecs - 100)).toBeLessThan(2);
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as {
      policy: unknown;
      clockOffsetSecs: number;
    };
    expect(stored.policy).toEqual({ recent_secs: 600, stale_secs: 3600 });
    expect(Math.abs(stored.clockOffsetSecs - 100)).toBeLessThan(2);
  });

  it('is degraded on a 200 with refresh.ok=false and still shows the saved snapshot', async () => {
    stubFetch(() =>
      env(
        feesFixture({
          refresh: {
            ok: false,
            served_from_cache: true,
            code: 'node_unreachable',
          },
          last_error: { at: 1_700_000_040, message: 'fee refresh failed' },
        }),
        200,
        'The node could not be reached, so the last saved fee snapshot is shown.',
      ),
    );
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('degraded'));
    expect(result.current.fees).not.toBeNull();
    expect(result.current.error).toMatch(/could not be reached/);
  });

  it('falls back to the stored snapshot and reports offline when the network fails', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        snapshot: snapshotFixture({ fetched_at: 123 }),
        policy: { recent_secs: 5, stale_secs: 9 },
        clockOffsetSecs: 4,
      }),
    );
    stubFetch(() => 'network');
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    // While loading the stored copy is visible but not called live.
    expect(result.current.state).toBe('loading');
    expect(result.current.fees?.snapshot.fetched_at).toBe(123);
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(result.current.fees?.snapshot.fetched_at).toBe(123);
    expect(result.current.fees?.policy).toEqual({
      recent_secs: 5,
      stale_secs: 9,
    });
    expect(result.current.clockOffsetSecs).toBe(4);
    expect(result.current.error).toMatch(/cannot reach/i);
  });

  it('is offline with no fees when nothing was ever stored', async () => {
    stubFetch(() => 'network');
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(result.current.fees).toBeNull();
  });

  it('shows an error envelope as degraded with its message', async () => {
    stubFetch(() =>
      err(502, 'node_unreachable', 'The Bitcoin node is unreachable.'),
    );
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('degraded'));
    expect(result.current.error).toBe('The Bitcoin node is unreachable.');
    expect(result.current.fees).toBeNull();
  });

  it('treats a malformed body as bad_response, not as fees', async () => {
    stubFetch(() => env({ snapshot: 'nope' }));
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('degraded'));
    expect(result.current.fees).toBeNull();
  });

  it('refresh() asks again', async () => {
    const f = stubFetch(() => env(feesFixture()));
    const { result } = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('live'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('useAnalyze', () => {
  it('builds the query and resolves to an ApiResult', async () => {
    const f = stubFetch(() => env(recommendationFixture()));
    const { result } = renderHook(() => useAnalyze(), { wrapper: wrapper() });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync({
        txid: TXID,
        urgency: 'high',
        budget: '5000',
        canSign: 'true',
        controls: '',
        outputValue: '',
      });
    });
    expect(res).toMatchObject({ ok: true, body: { recommended: 'rbf' } });
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).toContain(`/v2/analyze/${TXID}?`);
    expect(url).toContain('urgency=high');
    expect(url).toContain('max_budget_sat=5000');
    expect(url).toContain('can_sign_inputs=true');
    expect(url).not.toContain('controls_output');
  });

  it('resolves, never rejects, on an error envelope', async () => {
    stubFetch(() => err(400, 'bad_request', 'That is not a txid.'));
    const { result } = renderHook(() => useAnalyze(), { wrapper: wrapper() });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync({ txid: 'zz', urgency: 'normal' });
    });
    expect(res).toEqual({
      ok: false,
      status: 400,
      message: 'That is not a txid.',
      code: 'bad_request',
    });
  });

  it('resolves to bad_response when the body does not match', async () => {
    stubFetch(() => env({ recommended: 'rbf' }));
    const { result } = renderHook(() => useAnalyze(), { wrapper: wrapper() });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync({ txid: TXID });
    });
    expect(res).toMatchObject({ ok: false, code: 'bad_response' });
  });
});

describe('useCreateJob and useSubmitJob', () => {
  it('posts an rbf job without the kind field and without an empty budget', async () => {
    const f = stubFetch(() => env(jobCreatedFixture()));
    const { result } = renderHook(() => useCreateJob(), { wrapper: wrapper() });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync({
        kind: 'rbf',
        txid: TXID,
        change_vout: 1,
        urgency: 'normal',
        max_budget_sat: null,
      });
    });
    expect(res).toMatchObject({ ok: true, body: { job_id: JOB_ID } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v2/jobs/rbf');
    expect(JSON.parse(init.body as string)).toEqual({
      txid: TXID,
      change_vout: 1,
      urgency: 'normal',
    });
  });

  it('posts a cpfp job to its own endpoint', async () => {
    const f = stubFetch(() => env(jobCreatedFixture()));
    const { result } = renderHook(() => useCreateJob(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync({
        kind: 'cpfp',
        txid: TXID,
        vout: 0,
        destination: 'bcrt1qexample',
        max_budget_sat: 900,
      });
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v2/jobs/cpfp');
    expect(JSON.parse(init.body as string)).toEqual({
      txid: TXID,
      vout: 0,
      destination: 'bcrt1qexample',
      max_budget_sat: 900,
    });
  });

  it('surfaces a conflict from create as an ApiResult', async () => {
    stubFetch(() => err(422, 'unprocessable', 'RBF is not possible here.'));
    const { result } = renderHook(() => useCreateJob(), { wrapper: wrapper() });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync({
        kind: 'rbf',
        txid: TXID,
        change_vout: 0,
      });
    });
    expect(res).toMatchObject({ ok: false, code: 'unprocessable' });
  });

  it('submits a signed PSBT and returns the job', async () => {
    const f = stubFetch(() =>
      env(jobFixture({ state: 'broadcast', recovery_txid: 'b'.repeat(64) })),
    );
    const { result } = renderHook(() => useSubmitJob(JOB_ID), {
      wrapper: wrapper(),
    });
    let res;
    await act(async () => {
      res = await result.current.mutateAsync('signed-psbt');
    });
    expect(res).toMatchObject({ ok: true, body: { state: 'broadcast' } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/v2/jobs/${JOB_ID}/submit`);
    expect(JSON.parse(init.body as string)).toEqual({
      signed_psbt: 'signed-psbt',
    });
  });
});

describe('useJob', () => {
  it('loads the job and its history', async () => {
    stubFetch((url) =>
      url.endsWith('/history')
        ? env(historyFixture())
        : env(jobFixture({ state: 'settled' })),
    );
    const { result } = renderHook(() => useJob(JOB_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.job?.state).toBe('settled'));
    await waitFor(() => expect(result.current.history).toHaveLength(2));
    expect(result.current.result?.ok).toBe(true);
  });

  it('reports a not_found result with no job', async () => {
    stubFetch(() => err(404, 'not_found', 'No such job.'));
    const { result } = renderHook(() => useJob(JOB_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.job).toBeNull();
    expect(result.current.result).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('does nothing without an id', () => {
    const f = stubFetch(() => env(jobFixture()));
    const { result } = renderHook(() => useJob(null), { wrapper: wrapper() });
    expect(result.current).toEqual({ job: null, history: [], result: null });
    expect(f).not.toHaveBeenCalled();
  });

  it('polls an active job again and stops once it is settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let state: 'broadcast' | 'settled' = 'broadcast';
      const f = stubFetch((url) =>
        url.endsWith('/history') ? env([]) : env(jobFixture({ state })),
      );
      const { result } = renderHook(() => useJob(JOB_ID), {
        wrapper: wrapper(),
      });
      await waitFor(() => expect(result.current.job?.state).toBe('broadcast'));
      state = 'settled';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      await waitFor(() => expect(result.current.job?.state).toBe('settled'));
      const calls = f.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(f.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useOrders', () => {
  const uuidSeq = () => {
    let i = 0;
    return () => `00000000-0000-4000-8000-${String(i++).padStart(12, '0')}`;
  };

  it('adds, lists and removes notes, and refuses bad input with a reason', async () => {
    const queue = orderQueue(memoryBackend(), {
      clock: () => 10,
      ids: uuidSeq(),
    });
    const { result } = renderHook(() => useOrders({ queue }));
    expect(await result.current.add({ amountSat: '0' })).toMatchObject({
      ok: false,
    });
    await act(async () => {
      expect(
        await result.current.add({ amountSat: '5000', memo: 'coffee' }),
      ).toEqual({ ok: true });
    });
    await waitFor(() => expect(result.current.orders).toHaveLength(1));
    expect(result.current.orders[0]).toMatchObject({
      amount_sat: 5000,
      state: 'awaiting_verification',
      sync_state: 'local',
    });
    const id = result.current.orders[0]?.id ?? '';
    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.orders).toHaveLength(0);
  });

  it('says there is nothing to sync without calling the API', async () => {
    const f = stubFetch(() => env({ results: [] }));
    const { result } = renderHook(() =>
      useOrders({ queue: orderQueue(memoryBackend()) }),
    );
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.message).toBe('Nothing to sync.');
    expect(f).not.toHaveBeenCalled();
  });

  it('syncs to /v2/orders/sync and applies the server reading', async () => {
    const queue = orderQueue(memoryBackend(), {
      clock: () => 10,
      ids: uuidSeq(),
    });
    const f = stubFetch(() => env({ results: [] }));
    const { result } = renderHook(() => useOrders({ queue }));
    await act(async () => {
      await result.current.add({ amountSat: '77', txid: TXID });
    });
    await waitFor(() => expect(result.current.orders).toHaveLength(1));
    const key = result.current.orders[0]?.idempotency_key ?? '';
    f.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () =>
            env(syncFixture({ idempotency_key: key, state: 'seen' })).body,
        }) as unknown as Response,
    );
    await act(async () => {
      await result.current.sync();
    });
    const [url, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('/v2/orders/sync');
    const sent = JSON.parse(init.body as string) as {
      orders: Record<string, unknown>[];
    };
    expect(sent.orders).toHaveLength(1);
    expect(sent.orders[0]).toMatchObject({
      amount_sat: 77,
      txid: TXID,
      idempotency_key: key,
    });
    expect(result.current.message).toBe('Synced 1 note.');
    expect(result.current.syncing).toBe(false);
    expect(result.current.orders[0]).toMatchObject({
      state: 'seen',
      sync_state: 'synced',
    });
  });

  it('marks a conflict and keeps notes when sync fails', async () => {
    const queue = orderQueue(memoryBackend(), { ids: uuidSeq() });
    const { result } = renderHook(() => useOrders({ queue }));
    await act(async () => {
      await result.current.add({ amountSat: '9' });
    });
    await waitFor(() => expect(result.current.orders).toHaveLength(1));
    stubFetch(() => 'network');
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.message).toMatch(/Could not sync.*still saved here/);
    expect(result.current.orders).toHaveLength(1);
    expect(result.current.orders[0]?.sync_state).toBe('local');

    const key = result.current.orders[0]?.idempotency_key ?? '';
    stubFetch(() =>
      env(syncFixture({ idempotency_key: key, outcome: 'conflict' })),
    );
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.orders[0]).toMatchObject({
      state: 'conflict',
      sync_state: 'conflict',
    });
    expect(result.current.message).toBe('Synced 1 note, 1 in conflict.');
  });

  it('reports an error envelope from sync', async () => {
    const queue = orderQueue(memoryBackend(), { ids: uuidSeq() });
    const { result } = renderHook(() => useOrders({ queue }));
    await act(async () => {
      await result.current.add({ amountSat: '9' });
    });
    stubFetch(() => err(400, 'bad_request', 'Bad batch.'));
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.message).toContain('Bad batch.');
  });
});

describe('useOnline', () => {
  it('follows the browser online events and API reachability', async () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    const nav = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
    nav.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
    nav.mockRestore();

    // A network failure from the API marks it unreachable until an answer arrives.
    stubFetch(() => 'network');
    const fees = renderHook(() => useFees(), { wrapper: wrapper() });
    await waitFor(() => expect(fees.result.current.state).toBe('offline'));
    await waitFor(() => expect(result.current).toBe(false));
  });
});
