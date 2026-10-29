// Pure helpers for the analyse / job-tracking UI. No DOM access.

import type {
  Eligibility,
  JobState,
  RouteKind,
  TxAnalysis,
  Urgency,
} from '@/api/schemas';
import { isTxid } from './format';

export { isTxid };

export const ROUTE_LABELS: Record<RouteKind, string> = {
  rbf: 'Replace-by-fee (RBF)',
  cpfp: 'Child-pays-for-parent (CPFP)',
  external_accelerator: 'External accelerator',
  wait: 'Wait',
};

export const ROUTE_BLURBS: Record<RouteKind, string> = {
  rbf: 'Re-send the transaction with a higher fee. You must be able to sign for its inputs.',
  cpfp: 'Spend an output you control in a high-fee child. Pulls the parent along.',
  external_accelerator: 'Pay a third party to prioritise the transaction.',
  wait: 'Do nothing and let the network catch up. Costs nothing.',
};

/** Job states in the order they normally happen. `obsolete` is a side exit. */
export const JOB_STEPS: readonly (readonly [JobState, string])[] = [
  ['awaiting_signature', 'Awaiting signature'],
  ['broadcast', 'Broadcast'],
  ['confirmed', 'Confirmed'],
  ['settled', 'Settled'],
];

const ACTIVE: ReadonlySet<string> = new Set([
  'awaiting_signature',
  'broadcasting',
  'broadcast',
  'confirmed',
]);

/** Whether the tracker is still watching a job, i.e. the page should keep polling. */
export function isActive(state: string): boolean {
  return ACTIVE.has(state);
}

/** sat/vB of an analysed transaction, or null when the fee is unknown. */
export function feeRate(
  analysis: Pick<TxAnalysis, 'fee_sat' | 'vsize'>,
): number | null {
  if (analysis.fee_sat === null || analysis.fee_sat === undefined) return null;
  return analysis.fee_sat / Math.max(analysis.vsize, 1);
}

/** The analyse form as strings, the way inputs hold them. Everything but `urgency` may be empty. */
export type AnalyzeForm = {
  urgency?: Urgency | '';
  budget?: string | number | null;
  canSign?: string | boolean | null;
  controls?: string | boolean | null;
  outputValue?: string | number | null;
};

export type AnalyzeInput = AnalyzeForm & { txid: string };

/** 'true'/'yes' and 'false'/'no' are answers; anything else ('', 'unknown') is not told yet. */
function tri(v: string | boolean | null | undefined): 'true' | 'false' | null {
  if (v === true || v === 'true' || v === 'yes') return 'true';
  if (v === false || v === 'false' || v === 'no') return 'false';
  return null;
}

/** Query string for GET /v2/analyze/{txid}. Empty answers are left out, never sent as `false`. */
export function analyzeQuery(form: AnalyzeForm): string {
  const q = new URLSearchParams();
  q.set('urgency', form.urgency || 'normal');
  const num = (v: string | number | null | undefined): number | null =>
    v === '' || v === null || v === undefined ? null : Number(v);
  const budget = num(form.budget);
  if (budget !== null && budget >= 0)
    q.set('max_budget_sat', String(Math.trunc(budget)));
  const can = tri(form.canSign);
  const controls = tri(form.controls);
  if (can !== null) q.set('can_sign_inputs', can);
  if (controls !== null) q.set('controls_output', controls);
  const value = num(form.outputValue);
  if (controls === 'true' && value !== null && value >= 0) {
    q.set('output_value_sat', String(Math.trunc(value)));
  }
  return q.toString();
}

export type Tone = 'ok' | 'bad' | 'warn';

/** How a route's eligibility should be shown: label, pill tone and the reason text. */
export function eligibilityView(option: { eligibility: Eligibility }): {
  label: string;
  tone: Tone;
  reason: string;
} {
  const e = option.eligibility;
  switch (e.state) {
    case 'feasible':
      return { label: 'Feasible', tone: 'ok', reason: '' };
    case 'infeasible':
      return { label: 'Not possible', tone: 'bad', reason: e.reason };
    case 'unknown':
      return {
        label: 'Unknown',
        tone: 'warn',
        reason: `Missing: ${e.missing}`,
      };
  }
}

export type StepNumber = 1 | 2 | 3 | 4;

/** Which of the four page steps is current, given what the page is showing. */
export function currentStep({
  job,
  recommendation,
}: {
  job: { state: JobState } | null | undefined;
  recommendation: unknown;
}): StepNumber {
  if (job) return job.state === 'awaiting_signature' ? 3 : 4;
  return recommendation ? 2 : 1;
}

/**
 * Position of a job on the timeline: index of the current step and whether the job left the
 * normal path. A reorg drops `confirmed` back to `broadcast`, which this follows naturally.
 */
export function timelineView(state: string): {
  current: number;
  obsolete: boolean;
} {
  if (state === 'obsolete') return { current: -1, obsolete: true };
  const i = JOB_STEPS.findIndex(([s]) => s === state);
  // `broadcasting` is a brief in-flight state between signing and broadcast.
  return { current: state === 'broadcasting' ? 0 : i, obsolete: false };
}

/** A human reading of one tracker history row. */
export function describeHistory(entry: {
  status: string;
  confirmations?: number;
  detail?: string | null;
}): string {
  switch (entry.status) {
    case 'pending':
      return 'Waiting in the mempool';
    case 'confirmed': {
      const n = entry.confirmations ?? 0;
      return `Confirmed (${n} confirmation${n === 1 ? '' : 's'})`;
    }
    case 'replaced':
      return entry.detail
        ? `Replaced by ${entry.detail.slice(0, 12)}…`
        : 'Replaced by another transaction';
    case 'not_found':
      return 'No longer in the mempool and not confirmed';
    default:
      return entry.status;
  }
}

/** Fill percentage for the fee-rate gauge: 100% is 1.5x the target, so the target mark sits at 2/3. */
export function gaugeView(
  rate: number | null,
  target: number | null | undefined,
): { fill: number; mark: number; fine: boolean } | null {
  if (rate === null || target === null || target === undefined || target <= 0)
    return null;
  const scale = target * 1.5;
  return {
    fill: Math.min(100, (rate / scale) * 100),
    mark: (target / scale) * 100,
    fine: rate >= target,
  };
}
