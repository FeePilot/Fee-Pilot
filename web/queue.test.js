import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, needsSync, syncPayload, buildRecord, describeRecord, memoryBackend, orderQueue, sortRecords, uuid, MEMO_MAX } from './queue.js';

const ctx = { now: 100, id: 'id-1', key: 'key-1' };
const TX = 'a'.repeat(64);

test('a new record starts awaiting verification, local, with its own ids', () => {
  const r = buildRecord({ amountSat: '5000', memo: ' coffee ', txid: '' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.record, {
    id: 'id-1', created_at: 100, amount_sat: 5000, memo: 'coffee', txid: null,
    state: 'awaiting_verification', sync_state: 'local', idempotency_key: 'key-1', schema_version: 1,
  });
});

test('invalid amounts, memos and txids are refused with a reason', () => {
  for (const amountSat of ['', '0', '-5', '1.5', 'abc', null]) {
    assert.equal(buildRecord({ amountSat }, ctx).ok, false, String(amountSat));
  }
  assert.equal(buildRecord({ amountSat: '1', memo: 'x'.repeat(MEMO_MAX + 1) }, ctx).ok, false);
  assert.equal(buildRecord({ amountSat: '1', txid: 'zz' }, ctx).ok, false);
  assert.equal(buildRecord({ amountSat: '1', txid: TX.toUpperCase() }, ctx).record.txid, TX);
});

test('a record is never described as proof of payment', () => {
  const r = buildRecord({ amountSat: '1' }, ctx).record;
  const d = describeRecord(r);
  assert.equal(d.state, 'Awaiting verification');
  assert.match(d.note, /not proof of payment/i);
  assert.match(describeRecord({ ...r, state: 'not_seen' }).note, /does not prove it does not exist/i);
});

test('the queue keeps records until they are removed', async () => {
  let n = 0;
  const q = orderQueue(memoryBackend(), { clock: () => 10 + n, ids: () => `u${n++}` });
  const a = await q.add({ amountSat: '10' });
  const b = await q.add({ amountSat: '20', memo: 'second' });
  assert.deepEqual((await q.list()).map((r) => r.amount_sat), [10, 20]);
  assert.notEqual(a.record.id, a.record.idempotency_key);
  await q.remove(a.record.id);
  assert.deepEqual((await q.list()).map((r) => r.id), [b.record.id]);
});

test('a refused input is not stored', async () => {
  const q = orderQueue(memoryBackend());
  assert.equal((await q.add({ amountSat: '0' })).ok, false);
  assert.equal((await q.list()).length, 0);
});

test('records survive a new queue over the same backend (a restart)', async () => {
  const backend = memoryBackend();
  await orderQueue(backend).add({ amountSat: '77' });
  const reopened = orderQueue(backend);
  assert.equal((await reopened.list())[0].amount_sat, 77);
});

test('update cannot change the id or the idempotency key', async () => {
  const q = orderQueue(memoryBackend(), { ids: (() => { let i = 0; return () => `u${i++}`; })() });
  const { record } = await q.add({ amountSat: '5' });
  const next = await q.update(record.id, { state: 'seen', id: 'other', idempotency_key: 'other' });
  assert.deepEqual([next.state, next.id, next.idempotency_key], ['seen', record.id, record.idempotency_key]);
  assert.equal(await q.update('missing', {}), null);
});

test('records are ordered oldest first', () => {
  const rows = [{ id: 'b', created_at: 2 }, { id: 'a', created_at: 2 }, { id: 'c', created_at: 1 }];
  assert.deepEqual(sortRecords(rows).map((r) => r.id), ['c', 'a', 'b']);
});

test('uuid has the v4 shape', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const fake = { getRandomValues: (b) => { b.fill(7); return b; } };
  assert.match(uuid(fake), /^07070707-0707-4707-8707-070707070707$/);
});

test('sync sends unsent records and re-checks synced ones that have a txid', () => {
  const base = { id: 'i', idempotency_key: 'k', amount_sat: 5, memo: '', created_at: 1, schema_version: 1, state: 'awaiting_verification' };
  const local = { ...base, sync_state: 'local', txid: null };
  const syncedNoTx = { ...base, sync_state: 'synced', txid: null };
  const syncedTx = { ...base, sync_state: 'synced', txid: TX, state: 'seen' };
  const conflict = { ...base, sync_state: 'conflict', txid: TX, state: 'conflict' };
  assert.deepEqual([local, syncedNoTx, syncedTx, conflict].map(needsSync), [true, false, true, false]);
  const body = syncPayload([local, syncedNoTx, conflict]);
  assert.equal(body.orders.length, 1);
  assert.deepEqual(Object.keys(body.orders[0]).sort(),
    ['amount_sat', 'created_at', 'id', 'idempotency_key', 'memo', 'schema_version', 'txid']);
});

test('a conflict is flagged and a normal result marks the record synced', () => {
  assert.deepEqual(applyResult({ outcome: 'conflict', state: 'seen', note: 'n' }),
    { state: 'conflict', sync_state: 'conflict', server_note: 'n' });
  assert.deepEqual(applyResult({ outcome: 'existing', state: 'not_seen', note: 'n' }),
    { state: 'not_seen', sync_state: 'synced', server_note: 'n' });
});
