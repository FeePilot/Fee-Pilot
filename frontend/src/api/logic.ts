// Pure helpers behind the hooks, kept separate so they can be unit tested without React.

import type { ApiResult } from '@/lib/api/envelope';
import { DEFAULT_POLICY, type CacheEntry } from '@/lib/advisor';
import { isActive } from '@/lib/analysis';
import type { FeeSnapshot, FeesBody, FreshnessPolicy, Job } from './schemas';

export type FeeState = 'loading' | 'live' | 'degraded' | 'offline';

export type StoredFees = { snapshot: FeeSnapshot; policy: FreshnessPolicy };

export type FeesData = {
  fees: StoredFees | null;
  clockOffsetSecs: number;
  state: Exclude<FeeState, 'loading'>;
  error: string | null;
};

/** Server clock minus device clock, in seconds, at the moment a response arrived. */
export function clockOffset(
  serverTimeSecs: number,
  deviceNowMs: number,
): number {
  return serverTimeSecs - deviceNowMs / 1000;
}

/** "Now" on the server's clock, so snapshot age does not depend on the device clock being right. */
export function serverNowSecs(
  clockOffsetSecs: number,
  deviceNowMs: number = Date.now(),
): number {
  return deviceNowMs / 1000 + clockOffsetSecs;
}

/** Whether a stored cache entry can be shown as the last known fees. */
function fromCache(cache: CacheEntry | null): {
  fees: StoredFees | null;
  clockOffsetSecs: number;
} {
  if (!cache) return { fees: null, clockOffsetSecs: 0 };
  return {
    // The entry was validated structurally when parsed; the advisor only reads those fields.
    fees: {
      snapshot: cache.snapshot as unknown as FeeSnapshot,
      policy: cache.policy ?? DEFAULT_POLICY,
    },
    clockOffsetSecs: cache.clockOffsetSecs ?? 0,
  };
}

/** What the page can show before the first answer: the stored copy, marked as loading. */
export function initialFees(cache: CacheEntry | null) {
  return fromCache(cache);
}

/**
 * Turn the answer to `GET /v2/fees` (and whatever is stored) into what the UI shows.
 *  - 200 and `refresh.ok !== false`: `live`.
 *  - 200 with `refresh.ok === false`: `degraded`: the node is down and this is the saved snapshot.
 *  - network failure: `offline`, showing the stored copy.
 *  - any other error (rate limit, 502 with nothing saved...): `degraded`, with the stored copy if any.
 * `error` is a plain-language reason, or null when live.
 */
export function resolveFees(
  result: ApiResult<FeesBody>,
  cache: CacheEntry | null,
  deviceNowMs: number,
): FeesData {
  if (result.ok) {
    const { body } = result;
    const offset = clockOffset(body.server_time, deviceNowMs);
    const fees = body.snapshot
      ? { snapshot: body.snapshot, policy: body.policy }
      : null;
    if (body.refresh?.ok === false) {
      return {
        fees,
        clockOffsetSecs: offset,
        state: 'degraded',
        error: body.last_error?.message
          ? `${result.message} (${body.last_error.message})`
          : result.message,
      };
    }
    return { fees, clockOffsetSecs: offset, state: 'live', error: null };
  }
  const stored = fromCache(cache);
  if (result.status === 0) {
    return { ...stored, state: 'offline', error: result.message };
  }
  return { ...stored, state: 'degraded', error: result.message };
}

/** Cache entry to persist after a successful answer, or null when there is no snapshot to keep. */
export function cacheFromResult(
  result: ApiResult<FeesBody>,
  deviceNowMs: number,
): CacheEntry | null {
  if (!result.ok || !result.body.snapshot) return null;
  return {
    snapshot: result.body.snapshot as unknown as CacheEntry['snapshot'],
    policy: result.body.policy,
    clockOffsetSecs: clockOffset(result.body.server_time, deviceNowMs),
  };
}

export const JOB_POLL_MS = 4000;

/** How long to wait before asking about a job again; false to stop. Active jobs are polled. */
export function jobPollInterval(
  result: ApiResult<Job> | undefined,
): number | false {
  if (!result) return false;
  if (result.ok) return isActive(result.body.state) ? JOB_POLL_MS : false;
  // Keep trying through a dropped connection; stop on a real answer such as not_found.
  return result.status === 0 ? JOB_POLL_MS : false;
}
