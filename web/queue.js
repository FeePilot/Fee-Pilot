// Offline order queue: local records of payments the user intends or claims to have made.
// A record is a note to verify later. It is never proof of payment, and nothing here can
// broadcast, so every new record starts as `awaiting_verification`.

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'feepilot-queue';
export const MEMO_MAX = 140;

/** Order states. F4 moves a record out of `awaiting_verification` after reconnecting. */
export const ORDER_STATES = {
  awaiting_verification: 'Awaiting verification',
  seen: 'Seen by the node',
  not_seen: 'Not seen by this node',
  conflict: 'Conflict',
};

/** Sync states: whether the server has been told about the record. */
export const SYNC_STATES = ['local', 'synced', 'conflict'];

const TXID = /^[0-9a-f]{64}$/;

/** A random UUID v4; `crypto.randomUUID` where available, else built from random bytes. */
export function uuid(rand = globalThis.crypto) {
  if (rand && rand.randomUUID) return rand.randomUUID();
  const b = new Uint8Array(16);
  rand.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Validate user input and build a record. Returns `{ ok: true, record }` or `{ ok: false, error }`.
 * Only what is needed is kept: amount, an optional short memo and an optional txid.
 */
export function buildRecord({ amountSat, memo = '', txid = '' }, { now, id, key }) {
  const amount = Number(amountSat);
  if (amountSat === '' || amountSat === null || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: 'Enter the amount as a whole number of sats, above zero.' };
  }
  const note = String(memo).trim();
  if (note.length > MEMO_MAX) return { ok: false, error: `Keep the memo under ${MEMO_MAX} characters.` };
  const tx = String(txid).trim().toLowerCase();
  if (tx && !TXID.test(tx)) return { ok: false, error: 'A txid is 64 hexadecimal characters.' };
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
export function describeRecord(r) {
  const state = ORDER_STATES[r.state] ?? r.state;
  const note = {
    awaiting_verification: 'Recorded on this device. Not proof of payment.',
    seen: 'The node can see this transaction. Check confirmations before relying on it.',
    not_seen: 'This node does not currently see it. That does not prove it does not exist.',
    conflict: 'The server holds a different record under this key. Review it.',
  }[r.state] ?? '';
  return { state, note, synced: r.sync_state === 'synced' };
}

/** Oldest first, ties broken by id so the order is stable. */
export function sortRecords(records) {
  return [...records].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/** Storage kept in memory: tests, and the fallback when IndexedDB is blocked. */
export function memoryBackend() {
  const rows = new Map();
  return {
    persistent: false,
    async put(r) { rows.set(r.id, structuredClone(r)); },
    async getAll() { return [...rows.values()].map((r) => structuredClone(r)); },
    async delete(id) { rows.delete(id); },
  };
}

/** IndexedDB storage: survives refresh and restart. Rejects if the browser blocks it. */
export function idbBackend(factory = globalThis.indexedDB) {
  const open = () => new Promise((resolve, reject) => {
    if (!factory) return reject(new Error('IndexedDB is not available'));
    const req = factory.open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore('orders', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('orders', mode);
        const req = fn(tx.objectStore('orders'));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    persistent: true,
    put: (r) => run('readwrite', (s) => s.put(r)),
    getAll: () => run('readonly', (s) => s.getAll()),
    delete: (id) => run('readwrite', (s) => s.delete(id)),
  };
}

/** The queue over a backend. `clock` and `ids` are injectable for tests. */
export function orderQueue(backend, { clock = () => Math.floor(Date.now() / 1000), ids = uuid } = {}) {
  return {
    persistent: backend.persistent,
    async add(input) {
      const built = buildRecord(input, { now: clock(), id: ids(), key: ids() });
      if (built.ok) await backend.put(built.record);
      return built;
    },
    async list() { return sortRecords(await backend.getAll()); },
    async remove(id) { await backend.delete(id); },
    /** Merge changes into a stored record (used by reconcile in F4). */
    async update(id, changes) {
      const row = (await backend.getAll()).find((r) => r.id === id);
      if (!row) return null;
      const next = { ...row, ...changes, id: row.id, idempotency_key: row.idempotency_key };
      await backend.put(next);
      return next;
    },
  };
}

/** Whether a record should go in the next sync: unsent, or has a txid worth re-checking. */
export function needsSync(r) {
  if (r.sync_state === 'conflict') return false;
  return r.sync_state === 'local' || (r.txid !== null && r.state !== 'conflict');
}

/** The body of POST /v1/orders/sync for these records. Only the fields the server stores. */
export function syncPayload(records) {
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
export function applyResult(result) {
  if (result.outcome === 'conflict') {
    return { state: 'conflict', sync_state: 'conflict', server_note: result.note };
  }
  return { state: result.state, sync_state: 'synced', server_note: result.note };
}
