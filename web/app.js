// FeePilot web UI. Talks only to feepilot-api; no keys, no signing: the user's wallet signs.
import { orderQueue, idbBackend, memoryBackend, describeRecord, syncPayload, applyResult } from './queue.js';
import {
  advise, freshness, sourceLabel, ageSecs, formatAge, parseCacheEntry, toCacheEntry, FRESHNESS_LABELS, STORE_KEY,
  DEFAULT_POLICY,
} from './advisor.js';
import {
  ROUTE_LABELS, ROUTE_BLURBS, JOB_STEPS, isActive, isTxid, formatSats, formatRate, feeRate,
  analyzeQuery, eligibilityView, currentStep, timelineView, describeHistory, shortId, gaugeView,
} from './lib.js';

const POLL_MS = 4000;
const $ = (id) => document.getElementById(id);

const state = {
  form: null,          // what the user typed on step 1
  recommendation: null, // GET /v1/analyze response
  job: null,           // current recovery job
  created: null,       // POST /v1/jobs/* response (PSBT, fees); only known in this session
  history: [],
  poll: null,
  offline: false,       // the API could not be reached on the last check
  fees: null,           // { snapshot, policy } from the API or browser storage
  feeError: '',
  advisor: { urgency: 'normal', vsize: '' },
  orders: [],           // offline queue records
  orderError: '',
  syncing: false,
  syncMsg: '',
};

/** Build a DOM node. Children are text or nodes; text is never parsed as HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Replace a container's children, skipping null/false slots (replaceChildren would print "null"). */
function mount(root, ...kids) {
  root.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error('Cannot reach the FeePilot API. Is it running?');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const postJson = (path, data) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

// ---------------------------------------------------------------- chrome

function setSteps() {
  const now = currentStep({ job: state.job, recommendation: state.recommendation });
  document.querySelectorAll('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.className = n < now ? 'done' : n === now ? 'current' : '';
    if (n === now) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

function showNetwork(network) {
  const el = $('network');
  el.hidden = false;
  el.textContent = network;
  el.className = `pill ${network === 'mainnet' ? 'bad' : 'info'}`;
  const safety = $('safety');
  if (network === 'mainnet') {
    safety.hidden = false;
    safety.className = 'banner bad';
    safety.textContent = 'This is mainnet. FeePilot is an early build: test on regtest or signet before using real funds.';
  } else {
    safety.hidden = true;
  }
}

async function checkHealth() {
  const el = $('health');
  try {
    await api('/health');
    el.textContent = 'API online';
    el.className = 'health up';
    setOffline(false);
  } catch {
    el.textContent = 'API offline';
    el.className = 'health down';
    setOffline(true);
  }
}

function copyButton(getText, label = 'Copy') {
  const btn = h('button', { class: 'btn small', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select and copy manually';
    }
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
  return btn;
}

// ---------------------------------------------------------------- step 1 -> 2

function readForm() {
  return {
    txid: $('txid').value.trim().toLowerCase(),
    urgency: $('urgency').value,
    budget: $('budget').value,
    canSign: $('can-sign').value,
    controls: $('controls').value,
    outputValue: $('out-value').value,
  };
}

async function analyze(form) {
  stopPolling();
  state.job = null;
  state.created = null;
  state.history = [];
  $('handoff').hidden = true;
  $('track').hidden = true;
  const rec = await api(`/v1/analyze/${form.txid}?${analyzeQuery(form)}`);
  state.form = form;
  state.recommendation = rec;
  showNetwork(rec.analysis.network);
  renderCompare();
  setSteps();
  $('compare').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function statusPill(a) {
  const tone = { pending: 'warn', confirmed: 'ok', replaced: 'bad', not_found: 'bad' }[a.status] || '';
  const label = { pending: 'Pending', confirmed: 'Confirmed', replaced: 'Replaced', not_found: 'Not found' }[a.status] || a.status;
  return h('span', { class: `pill ${tone}` }, label);
}

function renderGauge(a) {
  const rate = feeRate(a);
  const g = gaugeView(rate, a.target_fee_rate);
  if (!g) return h('p', { class: 'hint' }, 'Fee rate or the current fee estimate is unknown, so routes that depend on them stay unknown.');
  return h('div', { class: 'gauge' },
    h('div', { class: 'gauge-bar', role: 'img', 'aria-label': `Fee rate ${formatRate(rate)} sat/vB against a target of ${formatRate(a.target_fee_rate)}` },
      h('div', { class: `gauge-fill${g.fine ? ' fine' : ''}`, style: `width:${g.fill}%` }),
      h('div', { class: 'gauge-target', style: `left:${g.mark}%` })),
    h('div', { class: 'gauge-labels' },
      h('span', {}, `Paying ${formatRate(rate)} sat/vB`),
      h('span', {}, `Next-block target ${formatRate(a.target_fee_rate)} sat/vB`)));
}

function fact(value, label) {
  return h('div', { class: 'fact' }, h('b', {}, value), h('span', {}, label));
}

function routeCard(opt, rec, pending) {
  const view = eligibilityView(opt);
  const isRec = rec.recommended === opt.kind;
  const notSupported = opt.kind === 'external_accelerator';
  const canAct = pending && view.tone === 'ok' && (opt.kind === 'rbf' || opt.kind === 'cpfp');
  const cost = [];
  if (opt.network_fee_sat !== null && opt.network_fee_sat !== undefined) {
    cost.push(h('div', { class: 'cost' }, 'Extra network fee ', h('b', {}, `${formatSats(opt.network_fee_sat)} sats`)));
  }
  if (opt.service_fee_sat !== null && opt.service_fee_sat !== undefined) {
    cost.push(h('div', { class: 'cost' }, 'Service charge ', h('b', {}, `${formatSats(opt.service_fee_sat)} sats`)));
  } else if (opt.kind !== 'wait' && opt.network_fee_sat !== null && opt.network_fee_sat !== undefined) {
    cost.push(h('div', { class: 'cost' }, 'Service charge ', h('b', {}, 'none')));
  }
  return h('article', { class: `route${isRec ? ' rec' : ''}${notSupported ? ' dim' : ''}` },
    h('header', {},
      h('h3', {}, ROUTE_LABELS[opt.kind] || opt.kind),
      isRec ? h('span', { class: 'pill ok' }, 'Recommended') : h('span', { class: `pill ${view.tone}` }, notSupported ? 'Not yet supported' : view.label)),
    h('div', { class: 'cost' }, ROUTE_BLURBS[opt.kind]),
    cost,
    view.reason && !notSupported ? h('div', { class: 'reason' }, view.reason) : null,
    opt.notes.length ? h('ul', {}, opt.notes.map((n) => h('li', {}, n))) : null,
    canAct ? h('div', { class: 'actions' },
      h('button', { class: `btn small${isRec ? ' primary' : ''}`, type: 'button', onclick: () => openBuilder(opt.kind) }, 'Build this recovery')) : null);
}

function renderCompare() {
  const rec = state.recommendation;
  const a = rec.analysis;
  const pending = a.status === 'pending';
  const root = $('compare');
  root.hidden = false;
  mount(root, 
    h('h2', {}, '2. Compare recovery routes'),
    h('div', { class: 'txline' }, statusPill(a), h('code', {}, a.txid)),
    !pending ? h('div', { class: `banner ${a.status === 'confirmed' ? 'ok' : 'info'}`, style: 'margin-top:12px' },
      a.status === 'confirmed' ? `Already confirmed with ${a.confirmations} confirmation${a.confirmations === 1 ? '' : 's'}. Nothing to recover.`
        : a.status === 'replaced' ? 'This transaction was replaced by another one spending the same inputs. Look up the replacement instead.'
          : 'This node does not know the transaction: it may have been evicted, or never broadcast.') : null,
    h('div', { class: 'facts' },
      fact(a.fee_sat === null ? '–' : `${formatSats(a.fee_sat)} sats`, 'Fee paid'),
      fact(`${formatSats(a.vsize)} vB`, 'Size'),
      fact(a.signals_rbf === null ? 'Unknown' : a.signals_rbf ? 'Yes' : 'No', 'Signals RBF'),
      fact(`${a.unconfirmed_ancestors} / ${a.unconfirmed_descendants}`, 'Unconfirmed parents / children')),
    pending ? renderGauge(a) : null,
    h('p', { class: 'rationale' }, rec.rationale),
    h('h3', {}, 'Routes'),
    h('div', { class: 'routes' }, rec.options.map((o) => routeCard(o, rec, pending))),
    h('div', { id: 'builder' }),
  );
}

// ---------------------------------------------------------------- step 2 -> 3

function openBuilder(kind) {
  const box = $('builder');
  const error = h('span', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Build unsigned PSBT');
  const fields = kind === 'rbf'
    ? [
      h('label', { class: 'field' }, h('span', {}, 'Your change output (vout index)'),
        h('input', { id: 'f-vout', type: 'number', min: '0', step: '1', required: true, value: '1', inputmode: 'numeric' }),
        h('span', { class: 'hint' }, 'The output that pays you back. The fee increase is taken from it.')),
    ]
    : [
      h('label', { class: 'field' }, h('span', {}, 'Output you control (vout index)'),
        h('input', { id: 'f-vout', type: 'number', min: '0', step: '1', required: true, value: '0', inputmode: 'numeric' })),
      h('label', { class: 'field' }, h('span', {}, 'Send the remainder to (your address)'),
        h('input', { id: 'f-dest', class: 'mono', required: true, spellcheck: 'false', placeholder: 'bcrt1…, tb1…, bc1…' })),
    ];

  const form = h('form', { class: 'build', autocomplete: 'off' },
    h('h3', {}, kind === 'rbf' ? 'Build the replacement' : 'Build the child transaction'),
    h('div', { class: 'grid' }, fields),
    h('p', { class: 'hint' }, 'FeePilot builds this from public chain data. Nothing is signed or sent yet.'),
    h('div', { class: 'row' }, submit, error));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const f = state.form;
      const vout = Number($('f-vout').value);
      const base = { txid: f.txid, urgency: f.urgency };
      const budget = f.budget === '' ? null : Number(f.budget);
      if (budget !== null) base.max_budget_sat = budget;
      const created = kind === 'rbf'
        ? await postJson('/v1/jobs/rbf', { ...base, change_vout: vout })
        : await postJson('/v1/jobs/cpfp', { ...base, vout, destination: $('f-dest').value.trim() });
      state.created = created;
      await loadJob(created.job_id);
      location.hash = `job=${created.job_id}`;
    } catch (e) {
      error.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
  mount(box, form);
  form.querySelector('input').focus();
}

// ---------------------------------------------------------------- step 3: hand-off

function renderHandoff() {
  const job = state.job;
  const root = $('handoff');
  if (job.state !== 'awaiting_signature') {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const c = state.created && state.created.job_id === job.id ? state.created : null;
  const error = h('span', { class: 'error', role: 'alert' });
  const signed = h('textarea', { id: 'signed', spellcheck: 'false', placeholder: 'Paste the signed PSBT (base64) here', 'aria-label': 'Signed PSBT' });
  const approve = h('input', { id: 'approve', type: 'checkbox' });
  const send = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Approve and broadcast');
  const sync = () => { send.disabled = !(approve.checked && signed.value.trim()); };
  approve.addEventListener('change', sync);
  signed.addEventListener('input', sync);

  const form = h('form', {},
    h('h3', {}, 'Then paste it back signed'),
    signed,
    h('label', { class: 'check' }, approve,
      h('span', {}, 'I approve broadcasting this transaction. I understand it spends my coins and FeePilot cannot undo it.')),
    h('div', { class: 'row' }, send, error));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    send.disabled = true;
    try {
      await postJson(`/v1/jobs/${job.id}/submit`, { signed_psbt: signed.value.trim() });
      await loadJob(job.id);
    } catch (e) {
      error.textContent = e.message;
      sync();
    }
  });

  const psbt = job.unsigned_psbt;
  mount(root, 
    h('h2', {}, '3. Sign in your own wallet'),
    h('p', { class: 'hint', style: 'margin:0 0 12px' },
      'This PSBT is unsigned. Open it in a wallet that holds the keys (Sparrow, Bitcoin Core, a hardware signer), sign it, and bring the signed PSBT back. FeePilot will refuse a signed PSBT whose inputs, outputs or amounts differ from this one.'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Route'), h('dd', {}, ROUTE_LABELS[job.route] || job.route),
      h('dt', {}, 'Original transaction'), h('dd', { class: 'mono' }, job.txid),
      c ? [h('dt', {}, 'New fee'), h('dd', {}, `${formatSats(c.fee_sat)} sats`)] : null,
      h('dt', {}, 'Extra network fee'), h('dd', {}, `${formatSats(job.extra_fee_sat)} sats`),
      c ? [h('dt', {}, 'What it does'), h('dd', {}, c.description)] : null,
      h('dt', {}, 'Job'), h('dd', { class: 'mono' }, job.id)),
    h('h3', {}, 'Unsigned PSBT'),
    h('textarea', { readonly: true, 'aria-label': 'Unsigned PSBT', onfocus: (e) => e.target.select() }, psbt),
    h('div', { class: 'copyrow' }, copyButton(() => psbt, 'Copy PSBT'), downloadButton(psbt, job.id)),
    h('details', {},
      h('summary', {}, 'Sign with Bitcoin Core (regtest)'),
      h('pre', { class: 'helpcode' }, `bitcoin-cli -rpcwallet=<wallet> walletprocesspsbt "${psbt.slice(0, 24)}…"\n# copy the "psbt" field of the result and paste it below\n# or run: scripts/demo-sign.sh <psbt>`)),
    form);
}

function downloadButton(psbt, id) {
  const url = URL.createObjectURL(new Blob([psbt], { type: 'text/plain' }));
  return h('a', { class: 'btn small', href: url, download: `feepilot-${id.slice(0, 8)}.psbt` }, 'Download .psbt');
}

// ---------------------------------------------------------------- step 4: tracking

function renderTrack() {
  const job = state.job;
  const root = $('track');
  if (job.state === 'awaiting_signature') {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const view = timelineView(job.state);
  const items = JOB_STEPS.map(([key, label], i) => {
    const cls = view.obsolete ? '' : i < view.current ? 'done' : i === view.current ? 'current' : '';
    return h('li', { class: cls, 'aria-current': cls === 'current' ? 'step' : false }, label);
  });
  const active = isActive(job.state);
  const rows = state.history.map((e) => h('tr', {},
    h('td', {}, new Date(e.observed_at).toLocaleString()),
    h('td', {}, describeHistory(e)),
    h('td', { class: 'mono', title: e.txid }, shortId(e.txid))));

  const banner = {
    broadcast: ['info', 'Broadcast. Waiting for a miner to include it. This can take minutes to hours depending on the fee rate.'],
    confirmed: ['ok', 'Confirmed. Not final yet: FeePilot keeps watching in case of a reorg.'],
    settled: ['ok', 'Settled. It has enough confirmations that a reorg is no longer a practical concern.'],
    obsolete: ['warn', 'This job is obsolete: the original transaction confirmed or was replaced by someone else before you signed.'],
    broadcasting: ['info', 'Broadcasting…'],
  }[job.state];

  mount(root, 
    h('div', { class: 'row', style: 'margin:0 0 14px;justify-content:space-between' },
      h('h2', { style: 'margin:0' }, '4. Track the outcome'),
      active ? h('span', { class: 'live' }, 'Live') : null),
    banner ? h('div', { class: `banner ${banner[0]}` }, banner[1]) : null,
    h('ol', { class: 'timeline', 'aria-label': 'Job progress' }, items),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Route'), h('dd', {}, ROUTE_LABELS[job.route] || job.route),
      h('dt', {}, 'Original'), h('dd', { class: 'mono' }, job.txid),
      job.recovery_txid ? [h('dt', {}, 'Recovery'), h('dd', { class: 'mono' }, job.recovery_txid)] : null,
      h('dt', {}, 'Extra fee'), h('dd', {}, `${formatSats(job.extra_fee_sat)} sats`),
      h('dt', {}, 'Job'), h('dd', { class: 'mono' }, job.id)),
    h('h3', {}, 'History'),
    rows.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'What changed'), h('th', {}, 'Transaction'))),
        h('tbody', {}, rows)))
      : h('p', { class: 'empty' }, 'No changes recorded yet. The tracker records an entry whenever a status changes.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: newRecovery }, 'Start another recovery')));
}

function newRecovery() {
  stopPolling();
  state.job = null;
  state.created = null;
  state.recommendation = null;
  state.history = [];
  history.replaceState(null, '', location.pathname);
  for (const id of ['compare', 'handoff', 'track']) $(id).hidden = true;
  setSteps();
  $('txid').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadJob(id) {
  const [job, hist] = await Promise.all([api(`/v1/jobs/${id}`), api(`/v1/jobs/${id}/history`)]);
  const first = !state.job || state.job.id !== id;
  state.job = job;
  state.history = hist;
  renderHandoff();
  renderTrack();
  setSteps();
  if (first) (job.state === 'awaiting_signature' ? $('handoff') : $('track')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  isActive(job.state) ? startPolling(id) : stopPolling();
}

function startPolling(id) {
  if (state.poll) return;
  state.poll = setInterval(async () => {
    try {
      const [job, hist] = await Promise.all([api(`/v1/jobs/${id}`), api(`/v1/jobs/${id}/history`)]);
      const changed = job.state !== state.job.state || hist.length !== state.history.length;
      state.job = job;
      state.history = hist;
      if (changed) {
        // Don't clobber a half-typed signed PSBT while still waiting for the signature.
        if (job.state !== 'awaiting_signature') renderTrack();
        setSteps();
      }
      if (!isActive(job.state)) stopPolling();
    } catch { /* transient; try again on the next tick */ }
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(state.poll);
  state.poll = null;
}

// ---------------------------------------------------------------- wiring

async function restoreFromHash() {
  const m = location.hash.match(/^#job=([0-9a-f-]{36})$/i);
  if (!m) return;
  try {
    await loadJob(m[1]);
    const a = await api(`/v1/analyze/${state.job.txid}`).catch(() => null);
    if (a) showNetwork(a.analysis.network);
  } catch (e) {
    $('find-error').textContent = `Could not load that job: ${e.message}`;
  }
}

$('controls').addEventListener('change', () => {
  $('out-value-field').hidden = $('controls').value !== 'true';
});

$('find-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('find-error');
  err.textContent = '';
  const form = readForm();
  if (!isTxid(form.txid)) {
    err.textContent = 'A txid is 64 hexadecimal characters.';
    return;
  }
  const btn = $('analyze');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  try {
    await analyze(form);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
});


// ---------------------------------------------------------------- fee guidance (works offline)

const nowSecs = () => Math.floor(Date.now() / 1000);

function loadStoredFees() {
  try {
    const text = localStorage.getItem(STORE_KEY);
    return text ? parseCacheEntry(text) : null;
  } catch {
    return null; // storage can be blocked; the page works without it
  }
}

function storeFees(entry) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entry));
  } catch { /* ignore */ }
}

function setOffline(value) {
  const was = state.offline;
  state.offline = value;
  const banner = $('offline');
  banner.hidden = !value;
  if (value) {
    banner.textContent = 'Offline mode: the FeePilot API is unreachable. You can plan with the saved fee snapshot below, but nothing can be broadcast, and nothing here confirms that a payment was sent or received.';
  }
  if (was !== value) {
    renderFees();
    if (!value) reconnect();
    renderOrders();
  }
}

/** Back online: refresh the fee snapshot first, then reconcile the queued notes. */
async function reconnect() {
  await refreshFees();
  await syncOrders();
}

async function refreshFees() {
  state.feeError = '';
  try {
    const res = await api('/v1/fees');
    const entry = toCacheEntry(res);
    if (entry) {
      state.fees = entry;
      storeFees(entry);
    }
  } catch (e) {
    state.feeError = e.message;
  }
  renderFees();
}

function renderFees() {
  const root = $('fees');
  const entry = state.fees;
  const policy = entry ? entry.policy : DEFAULT_POLICY;
  const snap = entry ? entry.snapshot : null;
  const now = nowSecs();
  const fresh = freshness(snap, now, policy);
  const a = advise({ snapshot: snap, urgency: state.advisor.urgency, vsize: Number(state.advisor.vsize) || null, nowSecs: now, policy });
  const tone = { recent: 'ok', past_window: 'warn', very_stale: 'bad', missing: 'warn' }[fresh];

  const urgency = h('select', { id: 'adv-urgency', onchange: (e) => { state.advisor.urgency = e.target.value; renderFees(); } },
    ...[['high', 'High: ~2 blocks'], ['normal', 'Normal: ~6 blocks'], ['low', 'Low: ~1 day']].map(([v, l]) =>
      h('option', { value: v, selected: state.advisor.urgency === v }, l)));
  const size = h('input', {
    id: 'adv-vsize', type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'unknown',
    value: state.advisor.vsize,
    onchange: (e) => { state.advisor.vsize = e.target.value; renderFees(); },
  });

  mount(root,
    h('div', { class: 'row between' },
      h('h2', {}, 'Fee guidance'),
      h('span', { class: `pill ${state.offline ? 'warn' : 'info'}` }, state.offline ? 'Offline mode' : 'Online')),
    snap
      ? h('p', { class: 'hint' },
        `Snapshot taken ${new Date(snap.fetched_at * 1000).toLocaleString()} (${formatAge(ageSecs(snap, now))} ago) on ${snap.network}, source: ${snap.source}. `,
        h('span', { class: `pill ${tone}` }, FRESHNESS_LABELS[fresh]),
        state.offline ? ' Saved copy, not live.' : '')
      : h('p', { class: 'hint' }, 'No fee snapshot yet. Connect once to fetch one.'),
    state.feeError && !state.offline ? h('p', { class: 'error' }, `Could not refresh: ${state.feeError}`) : null,
    h('div', { class: 'grid' },
      h('label', { class: 'field' }, h('span', {}, 'Urgency'), urgency),
      h('label', { class: 'field' }, h('span', {}, 'Transaction size (vB)'), size)),
    a.rate === null
      ? h('p', { class: 'note' }, a.notes.join(' '))
      : h('div', { class: 'advice' },
        h('div', { class: 'big' }, `${formatRate(a.rate)} sat/vB`),
        h('div', { class: 'note' },
          `Aim for the ${a.target_blocks}-block estimate. Confidence: ${a.confidence}.`,
          a.total_sats !== null ? ` Total about ${formatSats(a.total_sats)} sats.` : ''),
        a.notes.map((n) => h('div', { class: 'note' }, n))),
    snap && h('details', {},
      h('summary', {}, 'All cached estimates'),
      h('table', { class: 'rates' },
        ...snap.estimates.map((e) => h('tr', {},
          h('td', {}, `${e.blocks} blocks`),
          h('td', { class: 'mono' }, e.sat_per_vb === null ? '–' : `${formatRate(e.sat_per_vb)} sat/vB`),
          h('td', {}, sourceLabel(e)))),
        h('tr', {}, h('td', {}, 'Relay minimum'), h('td', { class: 'mono' }, `${formatRate(snap.min_relay_fee_sat_per_vb)} sat/vB`), h('td', {}, 'floor, not a target')),
        h('tr', {}, h('td', {}, 'Mempool minimum'), h('td', { class: 'mono' }, `${formatRate(snap.mempool_min_fee_sat_per_vb)} sat/vB`), h('td', {}, 'floor, not a target')))),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: refreshFees }, 'Refresh snapshot')));
}

state.fees = loadStoredFees();
renderFees();
refreshFees();
setInterval(renderFees, 30000);
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', checkHealth);

if ('serviceWorker' in navigator) {
  // Lets the page itself open with no network. Failure is harmless.
  navigator.serviceWorker.register('sw.js').catch(() => {});
}


// ---------------------------------------------------------------- offline orders (F3)

const queue = (() => {
  // IndexedDB keeps records across restarts; fall back to memory if the browser blocks it.
  try {
    if (globalThis.indexedDB) return orderQueue(idbBackend());
  } catch { /* fall through */ }
  return orderQueue(memoryBackend());
})();
let queueFallback = false;

async function queueCall(fn) {
  try {
    return await fn(queue);
  } catch {
    if (!queueFallback) {
      queueFallback = true;
      state.orderError = 'Browser storage is blocked, so records last only until you close this page.';
    }
    return fn(queueMemory);
  }
}
const queueMemory = orderQueue(memoryBackend());

async function loadOrders() {
  state.orders = (await queueCall((q) => q.list())) || [];
  renderOrders();
}

async function addOrder(ev) {
  ev.preventDefault();
  const form = ev.target;
  const res = await queueCall((q) => q.add({
    amountSat: form.elements.amount.value,
    memo: form.elements.memo.value,
    txid: form.elements.otxid.value,
  }));
  if (!res.ok) {
    state.orderError = res.error;
    renderOrders();
    return;
  }
  state.orderError = queueFallback ? state.orderError : '';
  form.reset();
  await loadOrders();
}

/** Send queued notes to the API and store its reading of each. Safe to repeat: the server dedupes. */
async function syncOrders() {
  if (state.syncing) return;
  const { orders } = syncPayload(state.orders);
  if (orders.length === 0) {
    state.syncMsg = 'Nothing to sync.';
    renderOrders();
    return;
  }
  state.syncing = true;
  state.syncMsg = 'Syncing…';
  renderOrders();
  try {
    const res = await postJson('/v1/orders/sync', { orders });
    for (const r of res.results) {
      const row = state.orders.find((o) => o.idempotency_key === r.idempotency_key);
      if (row) await queueCall((q) => q.update(row.id, applyResult(r)));
    }
    const conflicts = res.results.filter((r) => r.outcome === 'conflict').length;
    state.syncMsg = `Synced ${res.results.length} note${res.results.length === 1 ? '' : 's'}${conflicts ? `, ${conflicts} in conflict` : ''}.`;
  } catch (e) {
    state.syncMsg = `Could not sync: ${e.message} Your notes are still saved here.`;
  } finally {
    state.syncing = false;
    await loadOrders();
  }
}

async function removeOrder(id) {
  await queueCall((q) => q.remove(id));
  await loadOrders();
}

function renderOrders() {
  const root = $('orders');
  mount(root,
    h('h2', {}, 'Offline orders'),
    h('p', { class: 'hint' }, 'Note a payment you plan to make or say you made, even with no connection. It stays on this device as "awaiting verification" until it can be checked. A note is not proof of payment.'),
    h('form', { id: 'order-form', autocomplete: 'off', onsubmit: addOrder },
      h('div', { class: 'grid' },
        h('label', { class: 'field' }, h('span', {}, 'Amount (sats)'),
          h('input', { name: 'amount', type: 'number', min: '1', step: '1', inputmode: 'numeric', required: true })),
        h('label', { class: 'field' }, h('span', {}, 'Memo (optional)'),
          h('input', { name: 'memo', maxlength: '140' })),
        h('label', { class: 'field' }, h('span', {}, 'Txid (optional)'),
          h('input', { name: 'otxid', class: 'mono', maxlength: '64', spellcheck: 'false', placeholder: '64 hex characters' }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', type: 'submit' }, 'Save note'),
        h('button', { class: 'btn small', type: 'button', disabled: state.syncing || state.offline, onclick: syncOrders },
          state.offline ? 'Sync (needs connection)' : 'Sync now'),
        state.orderError ? h('span', { class: 'error', role: 'alert' }, state.orderError) : null,
        state.syncMsg ? h('span', { class: 'note', role: 'status' }, state.syncMsg) : null)),
    state.orders.length === 0
      ? h('p', { class: 'hint' }, 'No notes yet.')
      : h('ul', { class: 'orders' }, ...state.orders.map((r) => {
        const d = describeRecord(r);
        return h('li', {},
          h('div', { class: 'row between' },
            h('strong', {}, `${formatSats(r.amount_sat)} sats`),
            h('span', { class: 'pill warn' }, d.state)),
          r.memo ? h('div', {}, r.memo) : null,
          r.txid ? h('div', { class: 'mono' }, shortId(r.txid)) : null,
          h('div', { class: 'note' }, `${new Date(r.created_at * 1000).toLocaleString()} · ${d.synced ? 'synced' : 'on this device only'}. ${r.server_note || d.note}`),
          h('button', { class: 'btn small', type: 'button', onclick: () => removeOrder(r.id) }, 'Delete note'));
      })));
}

renderOrders();
loadOrders();

// Allow ?txid=… to prefill (used by the demo script).
const prefill = new URLSearchParams(location.search).get('txid');
if (prefill && isTxid(prefill)) $('txid').value = prefill;

checkHealth();
setInterval(checkHealth, 15000);
setSteps();
restoreFromHash();
