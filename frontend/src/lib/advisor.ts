// Offline fee advisor. Pure functions over a cached fee snapshot, so they work with no API.
// A cached snapshot is never presented as live: every result carries its age and freshness.

import type { EstimateSource, FreshnessPolicy, Urgency } from '@/api/schemas';
import { formatAge } from './format';

export { formatAge };

export type EstimateLike = {
  blocks: number;
  sat_per_vb: number | null;
  source: EstimateSource;
  approximate?: boolean;
};

/** The part of a fee snapshot the advisor needs (a full `FeeSnapshot` fits). */
export type SnapshotLike = {
  fetched_at: number;
  estimates: readonly EstimateLike[];
  source?: string;
};

export type Freshness = 'recent' | 'past_window' | 'very_stale' | 'missing';
export type Confidence = 'good' | 'reduced' | 'low' | 'none';

export const DEFAULT_POLICY: FreshnessPolicy = {
  recent_secs: 600,
  stale_secs: 3600,
};

/** Confirmation target (blocks) used for each urgency, matching the snapshot targets. */
export const URGENCY_TARGET: Record<Urgency, number> = {
  high: 2,
  normal: 6,
  low: 144,
};

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  recent: 'Recent',
  past_window: 'Past the freshness window',
  very_stale: 'Very stale',
  missing: 'No snapshot',
};

/** Age of a snapshot in whole seconds; a clock that ran backwards counts as 0. */
export function ageSecs(
  snapshot: Pick<SnapshotLike, 'fetched_at'>,
  nowSecs: number,
): number {
  return Math.max(0, Math.floor(nowSecs - snapshot.fetched_at));
}

export function freshness(
  snapshot: Pick<SnapshotLike, 'fetched_at'> | null | undefined,
  nowSecs: number,
  policy: FreshnessPolicy = DEFAULT_POLICY,
): Freshness {
  if (!snapshot) return 'missing';
  const age = ageSecs(snapshot, nowSecs);
  if (age <= policy.recent_secs) return 'recent';
  if (age <= policy.stale_secs) return 'past_window';
  return 'very_stale';
}

/** Total fee in sats for a size, rounded up; null when the size is unknown or invalid. */
export function totalFee(
  ratePerVb: number | null | undefined,
  vsize: number | null | undefined,
): number | null {
  if (ratePerVb === null || ratePerVb === undefined) return null;
  if (
    vsize === null ||
    vsize === undefined ||
    !Number.isFinite(vsize) ||
    vsize <= 0
  )
    return null;
  return Math.ceil(ratePerVb * vsize);
}

export type Advice = {
  freshness: Freshness;
  age_secs: number | null;
  urgency: Urgency;
  target_blocks: number;
  rate: number | null;
  source: EstimateSource | null;
  total_sats: number | null;
  confidence: Confidence;
  approximate: boolean;
  notes: string[];
};

export type AdviseInput = {
  snapshot: SnapshotLike | null | undefined;
  urgency: Urgency;
  vsize?: number | null;
  nowSecs: number;
  policy?: FreshnessPolicy;
};

/**
 * Advice for one urgency from a cached snapshot.
 * Never invents a number: a missing snapshot or estimate yields `rate: null` and a reason.
 * A stale snapshot lowers confidence; it does not prove the fee is too low, so the rate is
 * not adjusted.
 */
export function advise({
  snapshot,
  urgency,
  vsize = null,
  nowSecs,
  policy = DEFAULT_POLICY,
}: AdviseInput): Advice {
  const state = freshness(snapshot, nowSecs, policy);
  const target = URGENCY_TARGET[urgency] ?? URGENCY_TARGET.normal;
  const out: Advice = {
    freshness: state,
    age_secs: snapshot ? ageSecs(snapshot, nowSecs) : null,
    urgency,
    target_blocks: target,
    rate: null,
    source: null,
    total_sats: null,
    confidence: 'none',
    approximate: false,
    notes: [],
  };
  if (!snapshot) {
    out.notes.push('No fee snapshot is stored. Connect once to fetch one.');
    return out;
  }
  const est = snapshot.estimates.find((e) => e.blocks === target);
  if (est?.sat_per_vb === undefined || est.sat_per_vb === null) {
    out.notes.push('The snapshot has no estimate for this target.');
    return out;
  }
  out.rate = est.sat_per_vb;
  out.source = est.source;
  out.total_sats = totalFee(est.sat_per_vb, vsize);
  if (out.total_sats === null) {
    out.notes.push(
      'Transaction size unknown, so no total fee. Enter it to get one.',
    );
  }
  const byState = {
    recent: 'good',
    past_window: 'reduced',
    very_stale: 'low',
    missing: 'none',
  } as const;
  out.confidence = byState[state];
  if (est.source === 'fallback') {
    out.confidence = 'low';
    out.notes.push(
      'This is the operator fallback rate, not a market estimate.',
    );
  }
  if (est.source === 'third_party') {
    // Someone else's estimate: never better than "reduced", and always named.
    if (out.confidence === 'good') out.confidence = 'reduced';
    out.notes.push(
      `Third-party estimate from ${snapshot.source || 'a public service'}, not from your own node.`,
    );
    if (est.approximate) {
      out.approximate = true;
      out.notes.push(
        `The service has no exact ${target}-block figure, so the nearest level was used.`,
      );
    }
  }
  if (state !== 'recent') {
    out.notes.push(
      'Fee conditions may have changed since this snapshot. Refresh before you pay.',
    );
  }
  if (urgency === 'high' && state !== 'recent') {
    out.notes.push(
      'High urgency with older data: check a live source before relying on this.',
    );
  }
  return out;
}

/** Human label for an estimate's source, e.g. "third party (approximate)". */
export function sourceLabel(
  est: Pick<EstimateLike, 'source' | 'approximate'>,
): string {
  const names: Record<EstimateSource, string> = {
    node: 'node',
    fallback: 'fallback rate',
    third_party: 'third party',
    unavailable: 'none',
  };
  const base = names[est.source] ?? est.source;
  return est.approximate ? `${base} (approximate)` : base;
}

/** Key for the offline copy kept in browser storage. */
export const STORE_KEY = 'feepilot.fees.v1';

export type CacheEntry = {
  snapshot: SnapshotLike & Record<string, unknown>;
  policy: FreshnessPolicy;
  /** Server clock minus device clock (seconds) when the snapshot was fetched. Optional: older entries lack it. */
  clockOffsetSecs?: number;
};

/** What to persist after a successful fetch; only the fields the advisor needs. */
export function toCacheEntry(
  response:
    | {
        snapshot: CacheEntry['snapshot'] | null;
        policy?: FreshnessPolicy | null;
      }
    | null
    | undefined,
  clockOffsetSecs?: number,
): CacheEntry | null {
  if (!response?.snapshot) return null;
  const entry: CacheEntry = {
    snapshot: response.snapshot,
    policy: response.policy ?? DEFAULT_POLICY,
  };
  if (clockOffsetSecs !== undefined && Number.isFinite(clockOffsetSecs)) {
    entry.clockOffsetSecs = clockOffsetSecs;
  }
  return entry;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a stored entry defensively; anything malformed is treated as no cache. */
export function parseCacheEntry(
  text: string | null | undefined,
): CacheEntry | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) return null;
    const s = v.snapshot;
    if (
      !isRecord(s) ||
      typeof s.fetched_at !== 'number' ||
      !Array.isArray(s.estimates)
    )
      return null;
    const p = v.policy;
    const policy =
      isRecord(p) &&
      Number.isFinite(p.recent_secs) &&
      Number.isFinite(p.stale_secs)
        ? ({
            recent_secs: Number(p.recent_secs),
            stale_secs: Number(p.stale_secs),
          } satisfies FreshnessPolicy)
        : DEFAULT_POLICY;
    const entry: CacheEntry = { snapshot: s as CacheEntry['snapshot'], policy };
    if (
      typeof v.clockOffsetSecs === 'number' &&
      Number.isFinite(v.clockOffsetSecs)
    ) {
      entry.clockOffsetSecs = v.clockOffsetSecs;
    }
    return entry;
  } catch {
    return null;
  }
}
