import { describe, it, expect } from 'vitest';
import {
  applyResult,
  needsSync,
  syncPayload,
  buildRecord,
  describeRecord,
  memoryBackend,
  orderQueue,
  sortRecords,
  uuid,
  openQueue,
  syncSummary,
  MEMO_MAX,
  type OrderRecord,
} from './queue';

const ctx = { now: 100, id: 'id-1', key: 'key-1' };
const TX = 'a'.repeat(64);

function record(r: ReturnType<typeof buildRecord>): OrderRecord {
  if (!r.ok) throw new Error(r.error);
  return r.record;
}

describe('queue', () => {
  it('a new record starts awaiting verification, local, with its own ids', () => {
    const r = buildRecord(
      { amountSat: '5000', memo: ' coffee ', txid: '' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(record(r)).toEqual({
      id: 'id-1',
      created_at: 100,
      amount_sat: 5000,
      memo: 'coffee',
      txid: null,
      state: 'awaiting_verification',
      sync_state: 'local',
      idempotency_key: 'key-1',
      schema_version: 1,
    });
  });

  it('invalid amounts, memos and txids are refused with a reason', () => {
    for (const amountSat of ['', '0', '-5', '1.5', 'abc', null]) {
      expect(buildRecord({ amountSat }, ctx).ok, String(amountSat)).toBe(false);
    }
    expect(
      buildRecord({ amountSat: '1', memo: 'x'.repeat(MEMO_MAX + 1) }, ctx).ok,
    ).toBe(false);
    expect(buildRecord({ amountSat: '1', txid: 'zz' }, ctx).ok).toBe(false);
    expect(
      record(buildRecord({ amountSat: '1', txid: TX.toUpperCase() }, ctx)).txid,
    ).toBe(TX);
  });

  it('a record is never described as proof of payment', () => {
    const r = record(buildRecord({ amountSat: '1' }, ctx));
    const d = describeRecord(r);
    expect(d.state).toBe('Awaiting verification');
    expect(d.note).toMatch(/not proof of payment/i);
    expect(describeRecord({ ...r, state: 'not_seen' }).note).toMatch(
      /does not prove it does not exist/i,
    );
    expect(describeRecord({ ...r, state: 'replaced' }).note).toMatch(
      /may not confirm/i,
    );
  });

  it('the queue keeps records until they are removed', async () => {
    let n = 0;
    const q = orderQueue(memoryBackend(), {
      clock: () => 10 + n,
      ids: () => `u${n++}`,
    });
    const a = record(await q.add({ amountSat: '10' }));
    const b = record(await q.add({ amountSat: '20', memo: 'second' }));
    expect((await q.list()).map((r) => r.amount_sat)).toEqual([10, 20]);
    expect(a.id).not.toBe(a.idempotency_key);
    await q.remove(a.id);
    expect((await q.list()).map((r) => r.id)).toEqual([b.id]);
  });

  it('a refused input is not stored', async () => {
    const q = orderQueue(memoryBackend());
    expect((await q.add({ amountSat: '0' })).ok).toBe(false);
    expect(await q.list()).toHaveLength(0);
  });

  it('records survive a new queue over the same backend (a restart)', async () => {
    const backend = memoryBackend();
    await orderQueue(backend).add({ amountSat: '77' });
    const reopened = orderQueue(backend);
    expect((await reopened.list())[0]?.amount_sat).toBe(77);
  });

  it('update cannot change the id or the idempotency key', async () => {
    let i = 0;
    const q = orderQueue(memoryBackend(), { ids: () => `u${i++}` });
    const rec = record(await q.add({ amountSat: '5' }));
    const next = await q.update(rec.id, {
      state: 'seen',
      id: 'other',
      idempotency_key: 'other',
    });
    expect([next?.state, next?.id, next?.idempotency_key]).toEqual([
      'seen',
      rec.id,
      rec.idempotency_key,
    ]);
    expect(await q.update('missing', {})).toBeNull();
  });

  it('records are ordered oldest first', () => {
    const rows = [
      { id: 'b', created_at: 2 },
      { id: 'a', created_at: 2 },
      { id: 'c', created_at: 1 },
    ];
    expect(sortRecords(rows).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('uuid has the v4 shape', () => {
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const fake = { getRandomValues: (b: Uint8Array) => b.fill(7) };
    expect(uuid(fake)).toBe('07070707-0707-4707-8707-070707070707');
  });

  it('sync sends unsent records and re-checks synced ones that have a txid', () => {
    const base = {
      id: 'i',
      idempotency_key: 'k',
      amount_sat: 5,
      memo: '',
      created_at: 1,
      schema_version: 1,
      state: 'awaiting_verification',
    } as const;
    const local: OrderRecord = { ...base, sync_state: 'local', txid: null };
    const syncedNoTx: OrderRecord = {
      ...base,
      sync_state: 'synced',
      txid: null,
    };
    const syncedTx: OrderRecord = {
      ...base,
      sync_state: 'synced',
      txid: TX,
      state: 'seen',
    };
    const conflict: OrderRecord = {
      ...base,
      sync_state: 'conflict',
      txid: TX,
      state: 'conflict',
    };
    expect([local, syncedNoTx, syncedTx, conflict].map(needsSync)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const body = syncPayload([local, syncedNoTx, conflict]);
    expect(body.orders).toHaveLength(1);
    expect(Object.keys(body.orders[0] ?? {}).sort()).toEqual([
      'amount_sat',
      'created_at',
      'id',
      'idempotency_key',
      'memo',
      'schema_version',
      'txid',
    ]);
  });

  it('a conflict is flagged and a normal result marks the record synced', () => {
    expect(
      applyResult({ outcome: 'conflict', state: 'seen', note: 'n' }),
    ).toEqual({
      state: 'conflict',
      sync_state: 'conflict',
      server_note: 'n',
    });
    expect(
      applyResult({ outcome: 'existing', state: 'not_seen', note: 'n' }),
    ).toEqual({
      state: 'not_seen',
      sync_state: 'synced',
      server_note: 'n',
    });
  });

  it('openQueue falls back to memory when IndexedDB is missing', async () => {
    const q = await openQueue(undefined);
    expect(q.persistent).toBe(false);
  });

  it('sync summary counts notes and conflicts', () => {
    expect(syncSummary([{ outcome: 'created' }])).toBe('Synced 1 note.');
    expect(syncSummary([{ outcome: 'created' }, { outcome: 'conflict' }])).toBe(
      'Synced 2 notes, 1 in conflict.',
    );
  });
});
