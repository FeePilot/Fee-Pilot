// Offline order queue: local records of payments the user intends or claims to have made.
// A record is a note to verify later. It is never proof of payment, and nothing here can
// broadcast, so every new record starts as `awaiting_verification`.

import type { OrderState, SyncResult, UpsertOutcome } from '@/api/schemas';

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'feepilot-queue';
export const MEMO_MAX = 140;

/** A local record's state: the server's states, plus `conflict` when the server disagreed. */
export type LocalOrderState = OrderState | 'conflict';

/** Sync states: whether the server has been told about the record. */
export type SyncState = 'local' | 'synced' | 'conflict';
export const SYNC_STATES: readonly SyncState[] = [
  'local',
  'synced',
  'conflict',
];

export const ORDER_STATES: Record<LocalOrderState, string> = {
  awaiting_verification: 'Awaiting verification',
  seen: 'Seen by the node',
  replaced: 'A different transaction was seen',
  not_seen: 'Not seen by this node',
  conflict: 'Conflict',
};

export type OrderRecord = {
  id: string;
  created_at: number;
  amount_sat: number;
  memo: string;
  txid: string | null;
  state: LocalOrderState;
  sync_state: SyncState;
  idempotency_key: string;
  schema_version: number;
  server_note?: string;
};

export type OrderInput = {
  amountSat: string | number | null;
  memo?: string;
  txid?: string;
};

export type BuildResult =
  { ok: true; record: OrderRecord } | { ok: false; error: string };

const TXID = /^[0-9a-f]{64}$/;

type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => unknown;
};

/** A random UUID v4; `crypto.randomUUID` where available, else built from random bytes. */
export function uuid(
  rand: RandomSource | undefined = globalThis.crypto,
): string {
  if (rand?.randomUUID) return rand.randomUUID();
  const b = new Uint8Array(16);
  if (!rand?.getRandomValues)
    throw new Error('No secure random source is available');
  rand.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Validate user input and build a record. Only what is needed is kept: amount, an optional
 * short memo and an optional txid.
 */
export function buildRecord(
  { amountSat, memo = '', txid = '' }: OrderInput,
  { now, id, key }: { now: number; id: string; key: string },
): BuildResult {
  const amount = Number(amountSat);
  if (
    amountSat === '' ||
    amountSat === null ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return {
      ok: false,
      error: 'Enter the amount as a whole number of sats, above zero.',
    };
  }
  const note = String(memo).trim();
  if (note.length > MEMO_MAX)
    return { ok: false, error: `Keep the memo under ${MEMO_MAX} characters.` };
  const tx = String(txid).trim().toLowerCase();
  if (tx && !TXID.test(tx))
    return { ok: false, error: 'A txid is 64 hexadecimal characters.' };
  return {
    ok: true,
    record: {
      id,
      created_at: now,
      amount_sat: amount,
      memo: note,
      txid: tx || null,
      state: 'awaiting_verification',
      sync_state: 'local',
      idempotency_key: key,
      schema_version: SCHEMA_VERSION,
    },
  };
}

/** Wording for a record. It never claims the payment happened. */
export function describeRecord(r: Pick<OrderRecord, 'state' | 'sync_state'>): {
  state: string;
  note: string;
  synced: boolean;
} {
  const notes: Record<LocalOrderState, string> = {
    awaiting_verification: 'Recorded on this device. Not proof of payment.',
    seen: 'The node can see this transaction. Check confirmations before relying on it.',
    replaced:
      'A different transaction spending the same inputs was seen. This one may not confirm.',
    not_seen:
      'This node does not currently see it. That does not prove it does not exist.',
    conflict: 'The server holds a different record under this key. Review it.',
  };
  return {
    state: ORDER_STATES[r.state] ?? r.state,
    note: notes[r.state] ?? '',
    synced: r.sync_state === 'synced',
  };
}

/** Oldest first, ties broken by id so the order is stable. */
export function sortRecords<T extends Pick<OrderRecord, 'id' | 'created_at'>>(
  records: readonly T[],
): T[] {
  return [...records].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
}

export type QueueBackend = {
  persistent: boolean;
  put(r: OrderRecord): Promise<void>;
  getAll(): Promise<OrderRecord[]>;
  delete(id: string): Promise<void>;
};

/** Storage kept in memory: tests, and the fallback when IndexedDB is blocked. */
export function memoryBackend(): QueueBackend {
  const rows = new Map<string, OrderRecord>();
  return {
    persistent: false,
    put(r) {
      rows.set(r.id, structuredClone(r));
      return Promise.resolve();
    },
    getAll() {
      return Promise.resolve([...rows.values()].map((r) => structuredClone(r)));
    },
    delete(id) {
      rows.delete(id);
      return Promise.resolve();
    },
  };
}

/** IndexedDB storage: survives refresh and restart. Rejects if the browser blocks it. */
export function idbBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): QueueBackend {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) return reject(new Error('IndexedDB is not available'));
      const req = factory.open(DB_NAME, SCHEMA_VERSION);
      req.onupgradeneeded = () =>
        req.result.createObjectStore('orders', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error('IndexedDB failed to open'));
    });
  const run = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('orders', mode);
        const req = fn(tx.objectStore('orders'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () =>
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  };
  return {
    persistent: true,
    put: async (r) => {
      await run('readwrite', (s) => s.put(r));
    },
    getAll: () =>
      run<OrderRecord[]>(
        'readonly',
        (s) => s.getAll() as IDBRequest<OrderRecord[]>,
      ),
    delete: async (id) => {
      await run('readwrite', (s) => s.delete(id));
    },
  };
}

export type OrderQueue = {
  persistent: boolean;
  add(input: OrderInput): Promise<BuildResult>;
  list(): Promise<OrderRecord[]>;
  remove(id: string): Promise<void>;
  update(
    id: string,
    changes: Partial<OrderRecord>,
  ): Promise<OrderRecord | null>;
};

/** The queue over a backend. `clock` and `ids` are injectable for tests. */
export function orderQueue(
  backend: QueueBackend,
  {
    clock = () => Math.floor(Date.now() / 1000),
    ids = uuid,
  }: { clock?: () => number; ids?: () => string } = {},
): OrderQueue {
  return {
    persistent: backend.persistent,
    async add(input) {
      const built = buildRecord(input, { now: clock(), id: ids(), key: ids() });
      if (built.ok) await backend.put(built.record);
      return built;
    },
    async list() {
      return sortRecords(await backend.getAll());
    },
    async remove(id) {
      await backend.delete(id);
    },
    /** Merge changes into a stored record. The id and idempotency key can never change. */
    async update(id, changes) {
      const row = (await backend.getAll()).find((r) => r.id === id);
      if (!row) return null;
      const next: OrderRecord = {
        ...row,
        ...changes,
        id: row.id,
        idempotency_key: row.idempotency_key,
      };
      await backend.put(next);
      return next;
    },
  };
}

/**
 * Open the best available backend: IndexedDB if it works, memory otherwise.
 * The probe is a real read, because some browsers expose `indexedDB` but reject on open.
 */
export async function openQueue(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined'
    ? undefined
    : indexedDB,
): Promise<OrderQueue> {
  const idb = idbBackend(factory);
  try {
    await idb.getAll();
    return orderQueue(idb);
  } catch {
    return orderQueue(memoryBackend());
  }
}

/** Whether a record should go in the next sync: unsent, or has a txid worth re-checking. */
export function needsSync(
  r: Pick<OrderRecord, 'sync_state' | 'txid' | 'state'>,
): boolean {
  if (r.sync_state === 'conflict') return false;
  return (
    r.sync_state === 'local' || (r.txid !== null && r.state !== 'conflict')
  );
}

export type SyncOrderPayload = {
  id: string;
  idempotency_key: string;
  amount_sat: number;
  memo: string;
  txid: string | null;
  created_at: number;
  schema_version: number;
};

/** The body of POST /v2/orders/sync for these records. Only the fields the server stores. */
export function syncPayload(records: readonly OrderRecord[]): {
  orders: SyncOrderPayload[];
} {
  return {
    orders: records.filter(needsSync).map((r) => ({
      id: r.id,
      idempotency_key: r.idempotency_key,
      amount_sat: r.amount_sat,
      memo: r.memo,
      txid: r.txid,
      created_at: r.created_at,
      schema_version: r.schema_version,
    })),
  };
}

/**
 * Changes to store on a record after the server answered. A conflict keeps the local record
 * as is and flags it; anything else marks it synced with the server's reading of its state.
 */
export function applyResult(result: {
  outcome: UpsertOutcome;
  state: OrderState;
  note: string;
}): Pick<OrderRecord, 'state' | 'sync_state' | 'server_note'> {
  if (result.outcome === 'conflict') {
    return {
      state: 'conflict',
      sync_state: 'conflict',
      server_note: result.note,
    };
  }
  return {
    state: result.state,
    sync_state: 'synced',
    server_note: result.note,
  };
}

/** One-line summary of a sync, e.g. "Synced 2 notes, 1 in conflict." */
export function syncSummary(
  results: readonly Pick<SyncResult, 'outcome'>[],
): string {
  const conflicts = results.filter((r) => r.outcome === 'conflict').length;
  const n = results.length;
  return `Synced ${n} note${n === 1 ? '' : 's'}${conflicts ? `, ${conflicts} in conflict` : ''}.`;
}
