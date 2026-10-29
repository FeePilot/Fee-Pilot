import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeQuery, eligibilityView, currentStep, timelineView, describeHistory, gaugeView,
  feeRate, isActive, isTxid, formatSats, formatRate,
} from './lib.js';

test('analyzeQuery leaves unanswered questions out instead of sending false', () => {
  const q = new URLSearchParams(analyzeQuery({ urgency: 'high', budget: '5000', canSign: '', controls: '', outputValue: '' }));
  assert.equal(q.get('urgency'), 'high');
  assert.equal(q.get('max_budget_sat'), '5000');
  assert.equal(q.has('can_sign_inputs'), false);
  assert.equal(q.has('controls_output'), false);
});

test('analyzeQuery sends explicit answers and only keeps the output value when controlled', () => {
  const yes = new URLSearchParams(analyzeQuery({ urgency: 'normal', budget: '', canSign: 'false', controls: 'true', outputValue: '90000' }));
  assert.equal(yes.get('can_sign_inputs'), 'false');
  assert.equal(yes.get('controls_output'), 'true');
  assert.equal(yes.get('output_value_sat'), '90000');
  const no = new URLSearchParams(analyzeQuery({ urgency: 'normal', budget: '', canSign: '', controls: 'false', outputValue: '90000' }));
  assert.equal(no.has('output_value_sat'), false);
});

test('a budget of zero is a real budget', () => {
  assert.equal(new URLSearchParams(analyzeQuery({ urgency: 'low', budget: '0' })).get('max_budget_sat'), '0');
});

test('eligibility reads like the engine reports it', () => {
  assert.deepEqual(eligibilityView({ eligibility: { state: 'feasible' } }), { label: 'Feasible', tone: 'ok', reason: '' });
  assert.equal(eligibilityView({ eligibility: { state: 'infeasible', reason: 'over budget' } }).tone, 'bad');
  const unknown = eligibilityView({ eligibility: { state: 'unknown', missing: 'signing ability' } });
  assert.equal(unknown.tone, 'warn');
  assert.match(unknown.reason, /signing ability/);
});

test('page step follows the job and recommendation', () => {
  assert.equal(currentStep({ job: null, recommendation: null }), 1);
  assert.equal(currentStep({ job: null, recommendation: {} }), 2);
  assert.equal(currentStep({ job: { state: 'awaiting_signature' }, recommendation: {} }), 3);
  assert.equal(currentStep({ job: { state: 'broadcast' }, recommendation: null }), 4);
});

test('timeline follows a reorg back from confirmed to broadcast', () => {
  assert.equal(timelineView('confirmed').current, 2);
  assert.equal(timelineView('broadcast').current, 1);
  assert.equal(timelineView('broadcasting').current, 0);
  assert.deepEqual(timelineView('obsolete'), { current: -1, obsolete: true });
});

test('polling stops once a job is settled or obsolete', () => {
  for (const s of ['awaiting_signature', 'broadcast', 'confirmed']) assert.equal(isActive(s), true);
  for (const s of ['settled', 'obsolete']) assert.equal(isActive(s), false);
});

test('history descriptions', () => {
  assert.equal(describeHistory({ status: 'confirmed', confirmations: 1 }), 'Confirmed (1 confirmation)');
  assert.equal(describeHistory({ status: 'confirmed', confirmations: 3 }), 'Confirmed (3 confirmations)');
  assert.match(describeHistory({ status: 'replaced', detail: 'ab'.repeat(32) }), /^Replaced by abababababab…/);
  assert.equal(describeHistory({ status: 'replaced', detail: null }), 'Replaced by another transaction');
});

test('gauge: target mark at two thirds, full bar is capped', () => {
  const g = gaugeView(5, 20);
  assert.ok(Math.abs(g.mark - 66.666) < 0.01);
  assert.equal(g.fine, false);
  assert.equal(gaugeView(100, 20).fill, 100);
  assert.equal(gaugeView(null, 20), null);
  assert.equal(gaugeView(5, null), null);
});

test('formatting and validation', () => {
  assert.equal(feeRate({ fee_sat: 141, vsize: 141 }), 1);
  assert.equal(feeRate({ fee_sat: null, vsize: 141 }), null);
  assert.equal(formatSats(12345), '12,345');
  assert.equal(formatSats(null), '–');
  assert.equal(formatRate(1.234), '1.2');
  assert.equal(formatRate(250.4), '250');
  assert.equal(isTxid('a'.repeat(64)), true);
  assert.equal(isTxid('xyz'), false);
});
