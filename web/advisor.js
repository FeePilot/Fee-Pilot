// Offline fee advisor. Pure functions over a cached fee snapshot, so they work with no API.
// A cached snapshot is never presented as live: every result carries its age and freshness.

export const DEFAULT_POLICY = { recent_secs: 600, stale_secs: 3600 };

/** Confirmation target (blocks) used for each urgency, matching the snapshot targets. */
export const URGENCY_TARGET = { high: 2, normal: 6, low: 144 };

export const FRESHNESS_LABELS = {
  recent: 'Recent',
  past_window: 'Past the freshness window',
  very_stale: 'Very stale',
  missing: 'No snapshot',
};

/** Age of a snapshot in whole seconds; a clock that ran backwards counts as 0. */
export function ageSecs(snapshot, nowSecs) {
  return Math.max(0, Math.floor(nowSecs - snapshot.fetched_at));
}

/** recent | past_window | very_stale | missing. */
export function freshness(snapshot, nowSecs, policy = DEFAULT_POLICY) {
  if (!snapshot) return 'missing';
  const age = ageSecs(snapshot, nowSecs);
  if (age <= policy.recent_secs) return 'recent';
  if (age <= policy.stale_secs) return 'past_window';
  return 'very_stale';
}

/** "just now", "4 min", "2 h 5 min", "3 d". */
export function formatAge(secs) {
  if (secs < 60) return secs < 5 ? 'just now' : `${secs} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Total fee in sats for a size, rounded up; null when the size is unknown or invalid. */
export function totalFee(ratePerVb, vsize) {
  if (ratePerVb === null || ratePerVb === undefined) return null;
  if (!Number.isFinite(vsize) || vsize <= 0) return null;
  return Math.ceil(ratePerVb * vsize);
}

/**
 * Advice for one urgency from a cached snapshot.
 * Never invents a number: a missing snapshot or estimate yields `rate: null` and a reason.
 * A stale snapshot lowers confidence; it does not prove the fee is too low, so the rate is
 * not adjusted.
 */
export function advise({ snapshot, urgency, vsize = null, nowSecs, policy = DEFAULT_POLICY }) {
  const state = freshness(snapshot, nowSecs, policy);
  const out = {
    freshness: state,
    age_secs: snapshot ? ageSecs(snapshot, nowSecs) : null,
    urgency,
    target_blocks: URGENCY_TARGET[urgency] ?? URGENCY_TARGET.normal,
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
  const est = snapshot.estimates.find((e) => e.blocks === out.target_blocks);
  if (!est || est.sat_per_vb === null || est.sat_per_vb === undefined) {
    out.notes.push('The snapshot has no estimate for this target.');
    return out;
  }
  out.rate = est.sat_per_vb;
  out.source = est.source;
  out.total_sats = totalFee(est.sat_per_vb, vsize);
  if (out.total_sats === null) out.notes.push('Transaction size unknown, so no total fee. Enter it to get one.');
  out.confidence = { recent: 'good', past_window: 'reduced', very_stale: 'low' }[state];
  if (est.source === 'fallback') {
    out.confidence = 'low';
    out.notes.push('This is the operator fallback rate, not a market estimate.');
  }
  if (est.source === 'third_party') {
    // Someone else's estimate: never better than "reduced", and always named.
    if (out.confidence === 'good') out.confidence = 'reduced';
    out.notes.push(`Third-party estimate from ${snapshot.source || 'a public service'}, not from your own node.`);
    if (est.approximate) {
      out.approximate = true;
      out.notes.push(`The service has no exact ${out.target_blocks}-block figure, so the nearest level was used.`);
    }
  }
  if (state !== 'recent') {
    out.notes.push('Fee conditions may have changed since this snapshot. Refresh before you pay.');
  }
  if (urgency === 'high' && state !== 'recent') {
    out.notes.push('High urgency with older data: check a live source before relying on this.');
  }
  return out;
}

/** Human label for an estimate's source, e.g. "third party (approximate)". */
export function sourceLabel(est) {
  const base = { node: 'node', fallback: 'fallback rate', third_party: 'third party', unavailable: 'none' }[est.source] ?? est.source;
  return est.approximate ? `${base} (approximate)` : base;
}

/** Limits the offline copy that is kept in browser storage. */
export const STORE_KEY = 'feepilot.fees.v1';

/** What to persist after a successful fetch; only the fields the advisor needs. */
export function toCacheEntry(response) {
  if (!response || !response.snapshot) return null;
  return { snapshot: response.snapshot, policy: response.policy ?? DEFAULT_POLICY };
}

/** Parse a stored entry defensively; anything malformed is treated as no cache. */
export function parseCacheEntry(text) {
  try {
    const v = JSON.parse(text);
    const s = v && v.snapshot;
    if (!s || typeof s.fetched_at !== 'number' || !Array.isArray(s.estimates)) return null;
    const p = v.policy;
    const policy = p && Number.isFinite(p.recent_secs) && Number.isFinite(p.stale_secs) ? p : DEFAULT_POLICY;
    return { snapshot: s, policy };
  } catch {
    return null;
  }
}
