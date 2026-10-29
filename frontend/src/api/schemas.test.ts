import { describe, it, expect } from 'vitest';
import {
  feesBodySchema,
  historySchema,
  jobCreatedSchema,
  jobSchema,
  recommendationSchema,
  syncBodySchema,
  eligibilitySchema,
} from './schemas';
import {
  feesFixture,
  historyFixture,
  jobCreatedFixture,
  jobFixture,
  recommendationFixture,
  snapshotFixture,
  syncFixture,
} from './fixtures';

describe('feesBodySchema', () => {
  it('parses a fresh refresh', () => {
    const r = feesBodySchema.parse(feesFixture());
    expect(r.snapshot?.estimates).toHaveLength(3);
    expect(r.refresh?.ok).toBe(true);
  });

  it('parses a degraded answer with last_error and a refresh code', () => {
    const r = feesBodySchema.parse(
      feesFixture({
        refresh: {
          ok: false,
          served_from_cache: true,
          code: 'node_unreachable',
        },
        last_error: { at: 1_700_000_040, message: 'fee refresh failed' },
      }),
    );
    expect(r.refresh?.code).toBe('node_unreachable');
    expect(r.last_error?.message).toBe('fee refresh failed');
  });

  it('parses /fees/latest, which has no refresh, and a null snapshot', () => {
    const { refresh: _r, ...latest } = feesFixture();
    expect(feesBodySchema.parse(latest).refresh).toBeUndefined();
    expect(
      feesBodySchema.parse(feesFixture({ snapshot: null })).snapshot,
    ).toBeNull();
  });

  it('defaults `approximate` for snapshots stored before the field existed', () => {
    const raw = JSON.parse(JSON.stringify(feesFixture())) as {
      snapshot: { estimates: Record<string, unknown>[] };
    };
    raw.snapshot.estimates.forEach((e) => delete e.approximate);
    expect(feesBodySchema.parse(raw).snapshot?.estimates[0]?.approximate).toBe(
      false,
    );
  });

  it('accepts third-party estimates', () => {
    const snap = snapshotFixture({
      source: 'mempool.space',
      estimates: [
        { blocks: 6, sat_per_vb: 3, source: 'third_party', approximate: true },
      ],
    });
    expect(
      feesBodySchema.parse(feesFixture({ snapshot: snap })).snapshot
        ?.estimates[0]?.source,
    ).toBe('third_party');
  });

  it('rejects malformed bodies', () => {
    expect(feesBodySchema.safeParse({}).success).toBe(false);
    expect(
      feesBodySchema.safeParse({ ...feesFixture(), server_time: 'now' })
        .success,
    ).toBe(false);
    expect(
      feesBodySchema.safeParse({ ...feesFixture(), policy: { recent_secs: 1 } })
        .success,
    ).toBe(false);
    const badSource = {
      ...feesFixture(),
      snapshot: {
        ...snapshotFixture(),
        estimates: [{ blocks: 2, sat_per_vb: 1, source: 'oracle' }],
      },
    };
    expect(feesBodySchema.safeParse(badSource).success).toBe(false);
    expect(
      feesBodySchema.safeParse({
        ...feesFixture(),
        snapshot: { ...snapshotFixture(), network: 'Mainnet' },
      }).success,
    ).toBe(false);
    expect(
      feesBodySchema.safeParse({ ...feesFixture(), last_error: undefined })
        .success,
    ).toBe(false);
  });
});

describe('recommendationSchema', () => {
  it('parses all three eligibility shapes', () => {
    const r = recommendationSchema.parse(recommendationFixture());
    expect(r.options.map((o) => o.eligibility.state)).toEqual([
      'feasible',
      'unknown',
      'infeasible',
      'feasible',
    ]);
    expect(r.recommended).toBe('rbf');
  });
  it('rejects an unknown route, a missing reason and a bad status', () => {
    expect(
      recommendationSchema.safeParse({
        ...recommendationFixture(),
        recommended: 'bump',
      }).success,
    ).toBe(false);
    expect(eligibilitySchema.safeParse({ state: 'infeasible' }).success).toBe(
      false,
    );
    expect(eligibilitySchema.safeParse({ state: 'maybe' }).success).toBe(false);
    const bad = recommendationFixture();
    expect(
      recommendationSchema.safeParse({
        ...bad,
        analysis: { ...bad.analysis, status: 'mined' },
      }).success,
    ).toBe(false);
  });
});

describe('job schemas', () => {
  it('parses a created job, a job and its history', () => {
    expect(jobCreatedSchema.parse(jobCreatedFixture()).job_id).toBeTruthy();
    expect(
      jobSchema.parse(
        jobFixture({ state: 'broadcast', recovery_txid: 'b'.repeat(64) }),
      ).recovery_txid,
    ).toHaveLength(64);
    expect(historySchema.parse(historyFixture())).toHaveLength(2);
    expect(historySchema.parse([])).toEqual([]);
  });
  it('rejects unknown job states and malformed history', () => {
    expect(
      jobSchema.safeParse({ ...jobFixture(), state: 'done' }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({ ...jobFixture(), recovery_txid: undefined })
        .success,
    ).toBe(false);
    expect(
      jobCreatedSchema.safeParse({ ...jobCreatedFixture(), fee_sat: '1761' })
        .success,
    ).toBe(false);
    expect(historySchema.safeParse([{ txid: 'x' }]).success).toBe(false);
    expect(historySchema.safeParse({}).success).toBe(false);
  });
});

describe('syncBodySchema', () => {
  it('parses results with and without an observation', () => {
    expect(
      syncBodySchema.parse(syncFixture()).results[0]?.observation
        ?.fee_below_target,
    ).toBe(true);
    expect(
      syncBodySchema.parse(
        syncFixture({
          outcome: 'conflict',
          state: 'awaiting_verification',
          observation: null,
        }),
      ).results[0]?.observation,
    ).toBeNull();
    expect(
      syncBodySchema.parse(syncFixture({ state: 'replaced' })).results[0]
        ?.state,
    ).toBe('replaced');
  });
  it('rejects unknown outcomes and states', () => {
    expect(
      syncBodySchema.safeParse({
        results: [{ ...syncFixture().results[0], outcome: 'merged' }],
      }).success,
    ).toBe(false);
    expect(
      syncBodySchema.safeParse({
        results: [{ ...syncFixture().results[0], state: 'conflict' }],
      }).success,
    ).toBe(false);
    expect(syncBodySchema.safeParse({}).success).toBe(false);
  });
});
