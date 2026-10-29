import { describe, it, expect } from 'vitest';
import type { ApiResult } from '@/lib/api/envelope';
import {
  cacheFromResult,
  clockOffset,
  initialFees,
  jobPollInterval,
  resolveFees,
  serverNowSecs,
} from './logic';
import type { FeesBody, Job } from './schemas';
import { feesFixture, jobFixture, snapshotFixture } from './fixtures';

const ok = <T>(body: T, message = 'OK'): ApiResult<T> => ({
  ok: true,
  status: 200,
  message,
  body,
});
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  status,
  code,
  message: `failed ${code}`,
});
const NOW_MS = 1_700_000_000_000;

describe('clock offset', () => {
  it('is server time minus device time and round-trips through serverNowSecs', () => {
    const off = clockOffset(1_700_000_100, NOW_MS);
    expect(off).toBe(100);
    expect(serverNowSecs(off, NOW_MS)).toBe(1_700_000_100);
    expect(clockOffset(1_699_999_900, NOW_MS)).toBe(-100);
  });
});

describe('resolveFees', () => {
  it('is live for a normal refresh', () => {
    const d = resolveFees(ok<FeesBody>(feesFixture()), null, NOW_MS);
    expect(d.state).toBe('live');
    expect(d.error).toBeNull();
    expect(d.fees?.snapshot.fetched_at).toBe(1_700_000_000);
    expect(d.clockOffsetSecs).toBe(feesFixture().server_time - NOW_MS / 1000);
  });

  it('is live when the answer carries no refresh block (fees/latest)', () => {
    const { refresh: _r, ...rest } = feesFixture();
    expect(resolveFees(ok<FeesBody>(rest), null, NOW_MS).state).toBe('live');
  });

  it('is degraded on a 200 with refresh.ok=false and keeps the saved snapshot', () => {
    const body = feesFixture({
      refresh: { ok: false, served_from_cache: true, code: 'node_unreachable' },
      last_error: { at: 1_700_000_050, message: 'fee refresh failed' },
    });
    const d = resolveFees(
      ok<FeesBody>(body, 'The node could not be reached.'),
      null,
      NOW_MS,
    );
    expect(d.state).toBe('degraded');
    expect(d.fees).not.toBeNull();
    expect(d.error).toMatch(/node could not be reached/);
  });

  it('is offline on a network failure and falls back to the stored snapshot and offset', () => {
    const cache = {
      snapshot: snapshotFixture() as never,
      policy: { recent_secs: 1, stale_secs: 2 },
      clockOffsetSecs: 7,
    };
    const d = resolveFees(fail(0, 'network_error'), cache, NOW_MS);
    expect(d.state).toBe('offline');
    expect(d.fees?.policy).toEqual({ recent_secs: 1, stale_secs: 2 });
    expect(d.clockOffsetSecs).toBe(7);
  });

  it('is offline with nothing to show when nothing is stored', () => {
    const d = resolveFees(fail(0, 'network_error'), null, NOW_MS);
    expect([d.state, d.fees, d.clockOffsetSecs]).toEqual(['offline', null, 0]);
  });

  it('is degraded for other errors, still showing what is stored', () => {
    const cache = {
      snapshot: snapshotFixture() as never,
      policy: { recent_secs: 1, stale_secs: 2 },
    };
    const d = resolveFees(fail(429, 'rate_limited'), cache, NOW_MS);
    expect(d.state).toBe('degraded');
    expect(d.fees).not.toBeNull();
    expect(d.error).toContain('rate_limited');
  });

  it('initialFees reads the stored copy', () => {
    expect(initialFees(null).fees).toBeNull();
  });
});

describe('cacheFromResult', () => {
  it('stores snapshot, policy and offset on success only', () => {
    const c = cacheFromResult(ok<FeesBody>(feesFixture()), NOW_MS);
    expect(c?.policy).toEqual(feesFixture().policy);
    expect(c?.clockOffsetSecs).toBe(feesFixture().server_time - NOW_MS / 1000);
    expect(cacheFromResult(fail(0, 'network_error'), NOW_MS)).toBeNull();
    expect(
      cacheFromResult(ok<FeesBody>(feesFixture({ snapshot: null })), NOW_MS),
    ).toBeNull();
  });
});

describe('jobPollInterval', () => {
  it('polls active jobs every 4 s and stops for settled/obsolete', () => {
    for (const state of [
      'awaiting_signature',
      'broadcasting',
      'broadcast',
      'confirmed',
    ] as const) {
      expect(jobPollInterval(ok<Job>(jobFixture({ state })))).toBe(4000);
    }
    for (const state of ['settled', 'obsolete'] as const) {
      expect(jobPollInterval(ok<Job>(jobFixture({ state })))).toBe(false);
    }
  });
  it('keeps polling through a dropped connection but stops on a real error', () => {
    expect(jobPollInterval(fail(0, 'network_error'))).toBe(4000);
    expect(jobPollInterval(fail(404, 'not_found'))).toBe(false);
    expect(jobPollInterval(undefined)).toBe(false);
  });
});
