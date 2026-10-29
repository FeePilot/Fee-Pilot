import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { request } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/envelope';
import { STORE_KEY, parseCacheEntry } from '@/lib/advisor';
import { analyzeQuery, type AnalyzeInput } from '@/lib/analysis';
import {
  applyResult,
  memoryBackend,
  openQueue,
  orderQueue,
  syncPayload,
  syncSummary,
  type OrderInput,
  type OrderQueue,
  type OrderRecord,
} from '@/lib/queue';
import { readItem, writeItem } from '@/lib/storage';
import {
  cacheFromResult,
  initialFees,
  jobPollInterval,
  resolveFees,
  type FeeState,
  type StoredFees,
} from './logic';
import {
  feesBodySchema,
  historySchema,
  jobCreatedSchema,
  jobSchema,
  recommendationSchema,
  syncBodySchema,
  type HistoryEntry,
  type Job,
  type JobCreated,
  type Recommendation,
  type Urgency,
} from './schemas';

// ---------------------------------------------------------------- reachability

let reachable = true;
const listeners = new Set<() => void>();

function setReachable(next: boolean) {
  if (reachable === next) return;
  reachable = next;
  listeners.forEach((l) => l());
}

/** Every API call goes through here so the app knows whether the API answered. */
async function call<S extends z.ZodType>(
  path: string,
  schema: S,
  options?: Parameters<typeof request>[2],
): Promise<ApiResult<z.infer<S>>> {
  const res = await request(path, schema, options);
  setReachable(res.ok || res.status !== 0);
  return res;
}

/** The browser's `online` event only says a network exists; ask the API itself, as the original UI did. */
export async function probeHealth(): Promise<boolean> {
  let ok = false;
  try {
    const res = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/health`, {
      cache: 'no-store',
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  setReachable(ok);
  return ok;
}

/** Run `onBack` after the browser comes back online and the API answers. */
function useOnReconnect(onBack: () => void) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    const handler = () => {
      void probeHealth().then((ok) => {
        if (ok) latest.current();
      });
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, []);
}

function subscribeOnline(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** True when the browser says it is online and the API was reachable the last time we asked. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine && reachable,
    () => true,
  );
}

/** Test helper: forget what the last API call said. */
export function resetReachability() {
  reachable = true;
}

// ---------------------------------------------------------------- fees

export type FeesView = {
  fees: StoredFees | null;
  clockOffsetSecs: number;
  state: FeeState;
  error: string | null;
  refresh: () => Promise<void>;
};

export const feesKey = ['fees'] as const;

export function useFees(): FeesView {
  const [stored] = useState(() => parseCacheEntry(readItem(STORE_KEY)));
  const latestStored = () => parseCacheEntry(readItem(STORE_KEY));
  const query = useQuery({
    queryKey: feesKey,
    queryFn: async ({ signal }) => {
      const result = await call('/v2/fees', feesBodySchema, { signal });
      const nowMs = Date.now();
      const entry = cacheFromResult(result, nowMs);
      if (entry) writeItem(STORE_KEY, JSON.stringify(entry));
      return resolveFees(result, entry ?? latestStored(), nowMs);
    },
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refetch = query.refetch;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());

  return useMemo<FeesView>(() => {
    if (query.data) return { ...query.data, refresh };
    // Before the first answer: show the stored copy, marked as loading, never as live.
    const first = initialFees(stored);
    return {
      fees: first.fees,
      clockOffsetSecs: first.clockOffsetSecs,
      state: 'loading',
      error: null,
      refresh,
    };
  }, [query.data, stored, refresh]);
}

// ---------------------------------------------------------------- mutations

export function useAnalyze() {
  return useMutation<ApiResult<Recommendation>, Error, AnalyzeInput>({
    mutationFn: (input) =>
      call(
        `/v2/analyze/${encodeURIComponent(input.txid.trim())}?${analyzeQuery(input)}`,
        recommendationSchema,
      ),
  });
}

export type CreateJobInput =
  | {
      kind: 'rbf';
      txid: string;
      change_vout: number;
      urgency?: Urgency;
      max_budget_sat?: number | null;
    }
  | {
      kind: 'cpfp';
      txid: string;
      vout: number;
      destination: string;
      urgency?: Urgency;
      max_budget_sat?: number | null;
    };

export function useCreateJob() {
  return useMutation<ApiResult<JobCreated>, Error, CreateJobInput>({
    mutationFn: ({ kind, ...body }) => {
      const json: Record<string, unknown> = { ...body };
      if (json.max_budget_sat === null || json.max_budget_sat === undefined)
        delete json.max_budget_sat;
      return call(`/v2/jobs/${kind}`, jobCreatedSchema, {
        method: 'POST',
        json,
      });
    },
  });
}

export function useSubmitJob(id: string) {
  const client = useQueryClient();
  return useMutation<ApiResult<Job>, Error, string>({
    mutationFn: (signedPsbt) =>
      call(`/v2/jobs/${encodeURIComponent(id)}/submit`, jobSchema, {
        method: 'POST',
        json: { signed_psbt: signedPsbt },
      }),
    onSuccess: (res) => {
      if (res.ok) void client.invalidateQueries({ queryKey: ['job', id] });
    },
  });
}

// ---------------------------------------------------------------- jobs

export function useJob(id: string | null | undefined): {
  job: Job | null;
  history: HistoryEntry[];
  result: ApiResult<Job> | null;
} {
  const jobQuery = useQuery({
    queryKey: ['job', id, 'state'],
    queryFn: ({ signal }) =>
      call(`/v2/jobs/${encodeURIComponent(id ?? '')}`, jobSchema, { signal }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (q) => jobPollInterval(q.state.data),
  });
  const result = jobQuery.data ?? null;

  const historyQuery = useQuery({
    queryKey: ['job', id, 'history'],
    // Throwing keeps the last good history on screen when a poll fails.
    queryFn: async ({ signal }) => {
      const res = await call(
        `/v2/jobs/${encodeURIComponent(id ?? '')}/history`,
        historySchema,
        { signal },
      );
      if (!res.ok) throw new Error(res.message);
      return res.body;
    },
    enabled: Boolean(id),
    retry: false,
    refetchInterval: () => jobPollInterval(jobQuery.data ?? undefined),
  });

  // A failed poll keeps showing the last job we saw rather than blanking the page.
  const last = useRef<{ id: string | null | undefined; job: Job | null }>({
    id,
    job: null,
  });
  if (last.current.id !== id) last.current = { id, job: null };
  if (result?.ok) last.current.job = result.body;

  return { job: last.current.job, history: historyQuery.data ?? [], result };
}

// ---------------------------------------------------------------- orders

export type AddOrderResult = { ok: true } | { ok: false; error: string };

export type OrdersView = {
  orders: OrderRecord[];
  add: (input: OrderInput) => Promise<AddOrderResult>;
  remove: (id: string) => Promise<void>;
  sync: () => Promise<void>;
  syncing: boolean;
  message: string;
  persistent: boolean;
};

/** `queue` can be injected for tests; by default IndexedDB with a memory fallback. */
export function useOrders(
  options: { queue?: Promise<OrderQueue> | OrderQueue } = {},
): OrdersView {
  const ready = useRef<Promise<OrderQueue> | null>(null);
  ready.current ??= Promise.resolve(options.queue ?? openQueue());

  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [persistent, setPersistent] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const q = await ready.current!;
    const rows = await q.list();
    if (!alive.current) return;
    setOrders(rows);
    setPersistent(q.persistent);
  }, []);

  useEffect(() => {
    load().catch(() => {
      if (alive.current)
        setMessage('Could not read the saved notes on this device.');
    });
  }, [load]);

  const add = useCallback(
    async (input: OrderInput): Promise<AddOrderResult> => {
      let q = await ready.current!;
      let built;
      try {
        built = await q.add(input);
      } catch {
        // The browser refused to write (blocked storage, quota): keep the note in memory instead.
        const fallback = orderQueue(memoryBackend());
        for (const row of await q.list().catch(() => []))
          await fallback.update(row.id, row);
        ready.current = Promise.resolve(fallback);
        q = fallback;
        built = await q.add(input);
        setMessage(
          'Storage is blocked, so notes are kept only until you close this tab.',
        );
      }
      if (!built.ok) return { ok: false, error: built.error };
      await load();
      return { ok: true };
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      const q = await ready.current!;
      await q.remove(id);
      await load();
    },
    [load],
  );

  const sync = useCallback(async () => {
    if (busy.current) return;
    const q = await ready.current!;
    const { orders: pending } = syncPayload(await q.list());
    if (pending.length === 0) {
      setMessage('Nothing to sync.');
      return;
    }
    busy.current = true;
    setSyncing(true);
    setMessage('Syncing…');
    try {
      const res = await call('/v2/orders/sync', syncBodySchema, {
        method: 'POST',
        json: { orders: pending },
      });
      if (!res.ok) {
        setMessage(
          `Could not sync: ${res.message} Your notes are still saved here.`,
        );
        return;
      }
      const rows = await q.list();
      for (const r of res.body.results) {
        const row = rows.find((o) => o.idempotency_key === r.idempotency_key);
        if (row) await q.update(row.id, applyResult(r));
      }
      setMessage(syncSummary(res.body.results));
    } catch {
      setMessage('Could not sync. Your notes are still saved here.');
    } finally {
      busy.current = false;
      if (alive.current) setSyncing(false);
      await load().catch(() => undefined);
    }
  }, [load]);

  // Back online: reconcile the queued notes, as the original UI did.
  useOnReconnect(() => void sync());

  return { orders, add, remove, sync, syncing, message, persistent };
}
