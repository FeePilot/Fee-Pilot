// Pure helpers for the FeePilot UI. No DOM access, so they can be tested with `node --test`.

export const ROUTE_LABELS = {
  rbf: 'Replace-by-fee (RBF)',
  cpfp: 'Child-pays-for-parent (CPFP)',
  external_accelerator: 'External accelerator',
  wait: 'Wait',
};

export const ROUTE_BLURBS = {
  rbf: 'Re-send the transaction with a higher fee. You must be able to sign for its inputs.',
  cpfp: 'Spend an output you control in a high-fee child. Pulls the parent along.',
  external_accelerator: 'Pay a third party to prioritise the transaction.',
  wait: 'Do nothing and let the network catch up. Costs nothing.',
};

/** Job states in the order they normally happen. `obsolete` is a side exit. */
export const JOB_STEPS = [
  ['awaiting_signature', 'Awaiting signature'],
  ['broadcast', 'Broadcast'],
  ['confirmed', 'Confirmed'],
  ['settled', 'Settled'],
];

const ACTIVE = new Set(['awaiting_signature', 'broadcasting', 'broadcast', 'confirmed']);

/** Whether the tracker is still watching a job, i.e. the page should keep polling. */
export function isActive(state) {
  return ACTIVE.has(state);
}

export function isTxid(s) {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

/** Group digits so sat amounts are readable: 12345 -> "12,345". */
export function formatSats(n) {
  if (n === null || n === undefined) return '–';
  return Number(n).toLocaleString('en-US');
}

export function formatRate(r) {
  if (r === null || r === undefined || Number.isNaN(r)) return '–';
  return r >= 100 ? r.toFixed(0) : r.toFixed(1);
}

/** sat/vB of an analysed transaction, or null when the fee is unknown. */
export function feeRate(analysis) {
  if (analysis.fee_sat === null || analysis.fee_sat === undefined) return null;
  return analysis.fee_sat / Math.max(analysis.vsize, 1);
}

/** Query string for GET /v1/analyze/{txid}. Empty answers are left out, never sent as `false`. */
export function analyzeQuery(form) {
  const q = new URLSearchParams();
  q.set('urgency', form.urgency || 'normal');
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const budget = num(form.budget);
  if (budget !== null && budget >= 0) q.set('max_budget_sat', String(Math.trunc(budget)));
  if (form.canSign === 'true' || form.canSign === 'false') q.set('can_sign_inputs', form.canSign);
  if (form.controls === 'true' || form.controls === 'false') q.set('controls_output', form.controls);
  const value = num(form.outputValue);
  if (form.controls === 'true' && value !== null && value >= 0) {
    q.set('output_value_sat', String(Math.trunc(value)));
  }
  return q.toString();
}

/** How a route's eligibility should be shown: label, pill tone and the reason text. */
export function eligibilityView(option) {
  const e = option.eligibility;
  if (e.state === 'feasible') return { label: 'Feasible', tone: 'ok', reason: '' };
  if (e.state === 'infeasible') return { label: 'Not possible', tone: 'bad', reason: e.reason };
  return { label: 'Unknown', tone: 'warn', reason: `Missing: ${e.missing}` };
}

/** Which of the four page steps is current, given what the page is showing. */
export function currentStep({ job, recommendation }) {
  if (job) return job.state === 'awaiting_signature' ? 3 : 4;
  return recommendation ? 2 : 1;
}

/**
 * Position of a job on the timeline: index of the current step and whether the job left the
 * normal path. A reorg drops `confirmed` back to `broadcast`, which this follows naturally.
 */
export function timelineView(state) {
  if (state === 'obsolete') return { current: -1, obsolete: true };
  const i = JOB_STEPS.findIndex(([s]) => s === state);
  // `broadcasting` is a brief in-flight state between signing and broadcast.
  return { current: state === 'broadcasting' ? 0 : i, obsolete: false };
}

/** A human reading of one tracker history row. */
export function describeHistory(entry) {
  switch (entry.status) {
    case 'pending':
      return 'Waiting in the mempool';
    case 'confirmed':
      return `Confirmed (${entry.confirmations} confirmation${entry.confirmations === 1 ? '' : 's'})`;
    case 'replaced':
      return entry.detail ? `Replaced by ${entry.detail.slice(0, 12)}…` : 'Replaced by another transaction';
    case 'not_found':
      return 'No longer in the mempool and not confirmed';
    default:
      return entry.status;
  }
}

export function shortId(id) {
  return id && id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id || '';
}

/** Fill percentage for the fee-rate gauge: 100% is 1.5x the target, so the target mark sits at 2/3. */
export function gaugeView(rate, target) {
  if (rate === null || target === null || target === undefined || target <= 0) return null;
  const scale = target * 1.5;
  return {
    fill: Math.min(100, (rate / scale) * 100),
    mark: (target / scale) * 100,
    fine: rate >= target,
  };
}
