import { describe, it, expect } from 'vitest';
import {
  analyzeQuery,
  eligibilityView,
  currentStep,
  timelineView,
  describeHistory,
  gaugeView,
  feeRate,
  isActive,
  isTxid,
  ROUTE_LABELS,
} from './analysis';

describe('analysis', () => {
  it('analyzeQuery leaves unanswered questions out instead of sending false', () => {
    const q = new URLSearchParams(
      analyzeQuery({
        urgency: 'high',
        budget: '5000',
        canSign: '',
        controls: '',
        outputValue: '',
      }),
    );
    expect(q.get('urgency')).toBe('high');
    expect(q.get('max_budget_sat')).toBe('5000');
    expect(q.has('can_sign_inputs')).toBe(false);
    expect(q.has('controls_output')).toBe(false);
  });

  it('analyzeQuery sends explicit answers and only keeps the output value when controlled', () => {
    const yes = new URLSearchParams(
      analyzeQuery({
        urgency: 'normal',
        budget: '',
        canSign: 'false',
        controls: 'true',
        outputValue: '90000',
      }),
    );
    expect(yes.get('can_sign_inputs')).toBe('false');
    expect(yes.get('controls_output')).toBe('true');
    expect(yes.get('output_value_sat')).toBe('90000');
    const no = new URLSearchParams(
      analyzeQuery({
        urgency: 'normal',
        budget: '',
        canSign: '',
        controls: 'false',
        outputValue: '90000',
      }),
    );
    expect(no.has('output_value_sat')).toBe(false);
    expect(
      new URLSearchParams(analyzeQuery({ canSign: 'unknown' })).has(
        'can_sign_inputs',
      ),
    ).toBe(false);
  });

  it('a budget of zero is a real budget', () => {
    expect(
      new URLSearchParams(analyzeQuery({ urgency: 'low', budget: '0' })).get(
        'max_budget_sat',
      ),
    ).toBe('0');
    expect(
      new URLSearchParams(analyzeQuery({ urgency: 'low', budget: 0 })).get(
        'max_budget_sat',
      ),
    ).toBe('0');
  });

  it('eligibility reads like the engine reports it', () => {
    expect(eligibilityView({ eligibility: { state: 'feasible' } })).toEqual({
      label: 'Feasible',
      tone: 'ok',
      reason: '',
    });
    expect(
      eligibilityView({
        eligibility: { state: 'infeasible', reason: 'over budget' },
      }).tone,
    ).toBe('bad');
    const unknown = eligibilityView({
      eligibility: { state: 'unknown', missing: 'signing ability' },
    });
    expect(unknown.tone).toBe('warn');
    expect(unknown.reason).toMatch(/signing ability/);
  });

  it('page step follows the job and recommendation', () => {
    expect(currentStep({ job: null, recommendation: null })).toBe(1);
    expect(currentStep({ job: null, recommendation: {} })).toBe(2);
    expect(
      currentStep({ job: { state: 'awaiting_signature' }, recommendation: {} }),
    ).toBe(3);
    expect(
      currentStep({ job: { state: 'broadcast' }, recommendation: null }),
    ).toBe(4);
  });

  it('timeline follows a reorg back from confirmed to broadcast', () => {
    expect(timelineView('confirmed').current).toBe(2);
    expect(timelineView('broadcast').current).toBe(1);
    expect(timelineView('broadcasting').current).toBe(0);
    expect(timelineView('obsolete')).toEqual({ current: -1, obsolete: true });
  });

  it('polling stops once a job is settled or obsolete', () => {
    for (const s of [
      'awaiting_signature',
      'broadcasting',
      'broadcast',
      'confirmed',
    ])
      expect(isActive(s)).toBe(true);
    for (const s of ['settled', 'obsolete']) expect(isActive(s)).toBe(false);
  });

  it('history descriptions', () => {
    expect(describeHistory({ status: 'confirmed', confirmations: 1 })).toBe(
      'Confirmed (1 confirmation)',
    );
    expect(describeHistory({ status: 'confirmed', confirmations: 3 })).toBe(
      'Confirmed (3 confirmations)',
    );
    expect(
      describeHistory({ status: 'replaced', detail: 'ab'.repeat(32) }),
    ).toMatch(/^Replaced by abababababab…/);
    expect(describeHistory({ status: 'replaced', detail: null })).toBe(
      'Replaced by another transaction',
    );
    expect(describeHistory({ status: 'pending' })).toBe(
      'Waiting in the mempool',
    );
    expect(describeHistory({ status: 'not_found' })).toMatch(/not confirmed/);
    expect(describeHistory({ status: 'weird' })).toBe('weird');
  });

  it('gauge: target mark at two thirds, full bar is capped', () => {
    const g = gaugeView(5, 20);
    expect(g).not.toBeNull();
    expect(Math.abs((g?.mark ?? 0) - 66.666)).toBeLessThan(0.01);
    expect(g?.fine).toBe(false);
    expect(gaugeView(100, 20)?.fill).toBe(100);
    expect(gaugeView(null, 20)).toBeNull();
    expect(gaugeView(5, null)).toBeNull();
  });

  it('fee rate and validation', () => {
    expect(feeRate({ fee_sat: 141, vsize: 141 })).toBe(1);
    expect(feeRate({ fee_sat: null, vsize: 141 })).toBeNull();
    expect(isTxid('a'.repeat(64))).toBe(true);
    expect(isTxid('xyz')).toBe(false);
    expect(ROUTE_LABELS.rbf).toMatch(/RBF/);
  });
});
