// Realistic response bodies written by hand from the Rust structs. Shared by the API tests.

import type {
  FeesBody,
  FeeSnapshot,
  HistoryEntry,
  Job,
  JobCreated,
  Recommendation,
  SyncBody,
} from './schemas';

export const TXID = 'f'.repeat(64);
export const JOB_ID = '3f2b8c1e-5d7a-4c1b-9e0a-1a2b3c4d5e6f';

export function snapshotFixture(over: Partial<FeeSnapshot> = {}): FeeSnapshot {
  return {
    schema_version: 1,
    network: 'regtest',
    fetched_at: 1_700_000_000,
    unit: 'sat/vB',
    estimates: [
      { blocks: 2, sat_per_vb: 25, source: 'node', approximate: false },
      { blocks: 6, sat_per_vb: 12.5, source: 'node', approximate: false },
      {
        blocks: 144,
        sat_per_vb: null,
        source: 'unavailable',
        approximate: false,
      },
    ],
    min_relay_fee_sat_per_vb: 1,
    mempool_min_fee_sat_per_vb: 1,
    source: 'bitcoin-core',
    ...over,
  };
}

export function feesFixture(over: Partial<FeesBody> = {}): FeesBody {
  return {
    snapshot: snapshotFixture(),
    last_error: null,
    policy: { recent_secs: 600, stale_secs: 3600 },
    server_time: 1_700_000_030,
    refresh: { ok: true, served_from_cache: false, code: null },
    ...over,
  };
}

export function recommendationFixture(): Recommendation {
  return {
    analysis: {
      txid: TXID,
      network: 'regtest',
      status: 'pending',
      confirmations: 0,
      vsize: 141,
      fee_sat: 141,
      signals_rbf: true,
      unconfirmed_ancestors: 0,
      unconfirmed_descendants: 0,
      target_fee_rate: 12.5,
    },
    options: [
      {
        kind: 'rbf',
        eligibility: { state: 'feasible' },
        network_fee_sat: 1620,
        service_fee_sat: null,
        notes: [],
      },
      {
        kind: 'cpfp',
        eligibility: {
          state: 'unknown',
          missing: 'whether you control an output',
        },
        network_fee_sat: null,
        service_fee_sat: null,
        notes: ['Needs an output you control.'],
      },
      {
        kind: 'external_accelerator',
        eligibility: { state: 'infeasible', reason: 'No provider configured' },
        network_fee_sat: null,
        service_fee_sat: null,
        notes: [],
      },
      {
        kind: 'wait',
        eligibility: { state: 'feasible' },
        network_fee_sat: 0,
        service_fee_sat: null,
        notes: [],
      },
    ],
    recommended: 'rbf',
    rationale: 'RBF is the cheapest route you can sign for.',
  };
}

export function jobCreatedFixture(): JobCreated {
  return {
    job_id: JOB_ID,
    route: 'rbf',
    psbt: 'cHNidP8BAAoCAAAAAAAAAAAA',
    fee_sat: 1761,
    extra_fee_sat: 1620,
    description: 'Replaces the stuck transaction with one paying 12.5 sat/vB.',
    next_step:
      'Sign the PSBT in your wallet, then POST {"signed_psbt": ...} to /v1/jobs/{job_id}/submit',
  };
}

export function jobFixture(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    txid: TXID,
    route: 'rbf',
    state: 'awaiting_signature',
    unsigned_psbt: 'cHNidP8BAAoCAAAAAAAAAAAA',
    extra_fee_sat: 1620,
    recovery_txid: null,
    ...over,
  };
}

export function historyFixture(): HistoryEntry[] {
  return [
    {
      txid: TXID,
      status: 'pending',
      confirmations: 0,
      detail: null,
      observed_at: '2026-10-28T10:00:00Z',
    },
    {
      txid: TXID,
      status: 'replaced',
      confirmations: 0,
      detail: 'a'.repeat(64),
      observed_at: '2026-10-28T10:05:00Z',
    },
  ];
}

export function syncFixture(
  over: Partial<SyncBody['results'][number]> = {},
): SyncBody {
  return {
    results: [
      {
        idempotency_key: '11111111-1111-4111-8111-111111111111',
        outcome: 'created',
        state: 'seen',
        note: 'This node sees the transaction in its mempool. It is unconfirmed.',
        observation: {
          status: 'pending',
          confirmations: 0,
          fee_rate_sat_vb: 1,
          target_fee_rate_sat_vb: 12.5,
          fee_below_target: true,
        },
        ...over,
      },
    ],
  };
}
