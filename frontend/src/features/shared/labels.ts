export {
  describeHistory,
  eligibilityView,
  isActive,
  JOB_STEPS,
  ROUTE_BLURBS,
  ROUTE_LABELS,
  timelineView,
} from '@/lib/analysis';

/** A readable message for a failed API call; never a bare status code. */
export function errorText(r: { message: string; code: string }): string {
  const hint: Record<string, string> = {
    network_error:
      'Cannot reach the FeePilot API. Check that it is running and that you are online.',
    not_found: 'The API has no record of that.',
    rate_limited: 'Too many requests. Wait a moment and try again.',
    node_unreachable: 'The Bitcoin node is unreachable right now.',
  };
  return hint[r.code] ?? r.message;
}
