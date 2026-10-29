# Architecture

```
            ┌──────────┐   txid + prefs   ┌──────────────┐
  user ───▶ │   web    │ ───────────────▶ │ feepilot-api │
            └──────────┘ ◀─────────────── └──────┬───────┘
                 ▲        analysis / jobs        │
                 │ PSBT to sign            ┌─────┴──────────────────────────┐
            wallet / signer                │ feepilot-core (pure)           │
                                           │  types · fee math · strategy   │
                                           └─────┬───────────────┬──────────┘
                                   ┌─────────────┴───┐     ┌─────┴────────────┐
                                   │ feepilot-bitcoin│     │ feepilot-providers│
                                   │ Core RPC, PSBT  │     │ accelerator APIs  │
                                   └─────────────────┘     └───────────────────┘
                 PostgreSQL ◀── feepilot-api / feepilot-tracker (polls, records history)
```

| Crate | Responsibility |
|---|---|
| `feepilot-core` | Pure domain logic: `TxAnalysis`, eligibility, RBF/CPFP fee math, strategy engine. No I/O. |
| `feepilot-bitcoin` | `BitcoinDataSource` (Core RPC) and `SigningBoundary` (unsigned PSBT out, signed PSBT in). |
| `feepilot-providers` | `AcceleratorProvider` trait + adapters. |
| `feepilot-api` | Axum HTTP API. |
| `feepilot-store` | Job persistence (`JobStore`): PostgreSQL and in-memory implementations. |
| `feepilot-tracker` | Worker: pending → replaced/confirmed/settled, reorg-aware, notifies. |

## Invariants
1. No private keys in the backend. Ever.
2. Nothing is broadcast or paid for without explicit user approval.
3. A route is recommended only with sufficient evidence; unknown ⇒ `Unknown`, never `Feasible`.
4. Network fees and provider service charges are always reported separately.
5. A single confirmation is not finality; track depth and reorgs.

## Eligibility and ranking (implemented in `feepilot-core::strategy`)

Each route is `Feasible`, `Infeasible` (with a reason) or `Unknown` (with what is missing).
`Unknown` is never recommended.

| Route | Feasible when | Unknown when | Infeasible when |
|---|---|---|---|
| RBF | tx pending and user can sign for its inputs | user hasn't said if they can sign; fee or fee estimate missing | user cannot sign; cost over budget |
| CPFP | tx pending and user controls an output that can pay the child fee | user hasn't said if they control an output; fee or fee estimate missing | no controlled output; output below child fee + dust; cost over budget |
| Accelerator | not supported yet | always | |
| Wait | always | | |

Notes
- Bitcoin Core v28+ defaults to full-RBF (v30 removed the option), so a tx that does not signal
  BIP125 is still `Feasible` for RBF, with a warning that other nodes and miners may not accept it.
- **Ranking:** the target fee rate is scaled by urgency (low 0.5x, normal 1x, high 1.5x). A tx
  already at or above it is not stuck, so `Wait`. Otherwise, the cheapest feasible route within
  budget wins, with ties going to RBF.
- Costs are the *extra* network fee: RBF is `new fee - old fee`; CPFP is the child's fee.
  RBF assumes a same-size replacement; CPFP assumes a 110 vB child and ignores unconfirmed
  ancestors (surfaced as a note).

## API

| Endpoint | Purpose |
|---|---|
| `GET /v1/analyze/{txid}` | `{ analysis, options[], recommended, rationale }`. Optional query: `urgency` (`low\|normal\|high`), `max_budget_sat`, `can_sign_inputs`, `controls_output`, `output_value_sat`. |
| `POST /v1/jobs/rbf` | `{ txid, change_vout, urgency?, max_budget_sat? }` -> unsigned replacement PSBT and a job. |
| `POST /v1/jobs/cpfp` | `{ txid, vout, destination, urgency?, max_budget_sat? }` -> unsigned child PSBT and a job. |
| `POST /v1/jobs/{id}/submit` | `{ signed_psbt }` -> verifies, broadcasts once, returns the job with `recovery_txid`. |
| `GET /v1/jobs/{id}` | Job state: `awaiting_signature`, `broadcasting`, `broadcast`, `confirmed`, `settled`, `obsolete`. |
| `GET /v1/jobs/{id}/history` | Status changes recorded by the tracker, oldest first. |
| `GET /v1/fees` | Refresh: take a fee snapshot from the node, store it and return `{ snapshot, last_error, policy }`. A refresh within `FEEPILOT_FEE_REFRESH_MIN_SECS` of the last snapshot is served from the cache. 502 if the node is down (the last good snapshot is kept and the error recorded). |
| `GET /v1/fees/latest` | The stored snapshot without contacting the node, the latest refresh error if the last attempt failed, and the freshness `policy`. 404 until a refresh has succeeded once. |
| `POST /v1/orders/sync` | `{ orders: [{ id, idempotency_key, amount_sat, memo, txid?, created_at, schema_version }] }` -> per-order `outcome` (`created`, `existing`, `conflict`), `state`, a plain-language `note` and the node `observation`. Up to 100 per call. |

Job endpoints return 422 when the route is infeasible, over budget, unnecessary (tx not stuck)
or the PSBT is wrong; 409 when a job was already submitted; 502 when the node is unreachable.

## Recovery flow and its safety checks

1. The engine must find the requested route `Feasible` for the user's urgency and budget.
2. **RBF** rebuilds the stuck tx from public chain data with the user's chosen *change output*
   reduced by the fee increase. It needs no wallet access. The fee is at least the BIP125
   minimum (original fee + 1 sat/vB on the replacement size, with a 2 vB margin) and the
   change must stay above dust. Inputs are forced to signal replaceability.
   Limits: outputs without a standard address (e.g. OP_RETURN) and duplicate-address
   outputs are not supported yet; the fee increase must fit in the one change output.
3. **CPFP** spends the user's output of the pending parent into the user's chosen destination,
   paying the child fee that lifts the package to the target rate.
4. The unsigned PSBT (with UTXO data attached) is stored in the job and returned.
5. On submit, the signed PSBT is finalized and compared with the stored one: every input
   outpoint and sequence, and every output value and script, must be identical. Only then is
   it broadcast. A claim step (`awaiting_signature` -> `broadcasting`) makes double
   submission impossible, and a failed attempt returns the job to `awaiting_signature`.

## Tracking

`feepilot-tracker` polls every active job (`awaiting_signature`, `broadcast`, `confirmed`).
For each it observes the original transaction and, once broadcast, the recovery transaction,
and appends to `tx_status_history` only when status, confirmations or detail changed.

- **Replaced vs evicted.** If the node no longer has the original, the tracker first checks
  whether the recovery transaction is in the mempool or chain (then the recovery replaced it),
  and otherwise asks the node which mempool transaction spends the job's stored input
  outpoints (`gettxspendingprevout`). A spender means `replaced` (with its txid recorded);
  no spender means the transaction was dropped and is recorded as `not_found`. A replacement
  that has already confirmed and was not ours cannot be attributed without a spent-output
  index; it shows as `not_found`.
- **Outcome.** RBF succeeds when the replacement confirms, CPFP when the parent confirms.
  1+ confirmations is `confirmed`; `FEEPILOT_SETTLE_DEPTH` (default 6) is `settled`, after which
  the job is no longer watched. If a reorg removes the confirmations, the job returns to
  `broadcast` and the history shows it.
- **Obsolete.** An unsigned job whose original confirmed, or was replaced by someone else, is
  marked `obsolete`; so is an RBF job whose original confirmed before the replacement did.
- **Safety.** State changes are compare-and-set, so a tracker working from a stale snapshot
  cannot overwrite a job the user has just submitted. A failure on one job is logged and
  does not stop the others.
- **Notifications.** Every state change is logged; if `FEEPILOT_WEBHOOK_URL` is set it is also
  POSTed as JSON `{ job_id, txid, recovery_txid, route, from, to, confirmations }`. Delivery is
  best-effort: one attempt, 5 s timeout, no retries. The job and its history are the record.

## Web UI

`frontend/` is a React + TypeScript app (Vite, built to `frontend/dist`), served by `feepilot-api`
when `FEEPILOT_WEB_DIR` is set (API routes always win; `/app/...` gets the app shell, unknown paths
get the real 404). It talks to the enveloped `/v2` API. It holds no secrets: it shows the unsigned
PSBT, takes the wallet-signed PSBT back, and requires an explicit approval tick before submitting
the job. State lives in the API; a job is addressable as `/app/jobs/<id>` so a reload resumes (old
`/#job=<id>` links redirect there). It polls the job and its history while the job is active.

## Fee awareness and offline continuity

- **Snapshots** (`feepilot-core::snapshot`, `GET /v1/fees`): `estimatesmartfee` for 2, 6 and 144 blocks
  plus the relay and mempool minimum fees, converted from BTC/kvB to sat/vB with test vectors. Each
  estimate is labelled `node`, `fallback` (the configured `FEEPILOT_FALLBACK_FEE_RATE`) or
  `unavailable`; a missing estimate is never invented. Snapshots live in `fee_snapshots`; a failed
  refresh stores an error row and never replaces the last good snapshot.
- **HTTP fee source** (`feepilot-bitcoin::http_fees`, optional): with `FEEPILOT_FEE_API_URL` set,
  snapshots come from Esplora (exact block keys) or mempool.space (named levels, flagged
  approximate) instead of the node. 10 s timeout, 64 KB body cap, no fallback rate, floors unknown;
  a failure or a response with no usable rate is a failed refresh and the last good snapshot stays.
  Only fees use it: analysis and PSBTs still go to Core RPC.
- **Offline advisor** (`frontend/src/lib/advisor.ts`): pure functions over the cached snapshot. Freshness is
  `recent`, `past_window`, `very_stale` or `missing` by age against the policy
  (`FEEPILOT_FRESH_SECS`, `FEEPILOT_STALE_SECS`, served with the snapshot). Urgency picks the 2, 6 or
  144 block estimate; total fee is rate x size only when the size is known. Stale data lowers
  confidence and adds a warning; it does not alter the rate. The browser keeps the last snapshot in
  `localStorage` and a service worker lets the page itself open with no network.
- **Offline queue** (`frontend/src/lib/queue.ts`): records live in IndexedDB (memory fallback with a warning).
  Each has a client UUID, a separate idempotency key, the state `awaiting_verification`, and is
  described as "not proof of payment".
- **Reconnect** (`POST /v1/orders/sync`): the page refreshes the snapshot first, then syncs. The first
  payload stored under a key wins; the same payload again is `existing`; a different one is a
  `conflict` and the stored record is kept. Records with a txid are checked against the node:
  mempool or block -> `seen`, a conflicting spender -> `replaced`, unknown -> `not_seen` ("does not
  mean it does not exist"), node down -> still `awaiting_verification`. Pending transactions are
  compared with the current fee target.

## Hardening

- Per-client token-bucket rate limit on `/v1/` (`FEEPILOT_RATE_LIMIT_PER_MIN`, default 120, 429 with
  `Retry-After`). Forwarded headers are not trusted; limit at the proxy too.
- CSP (`script-src 'self'`), `nosniff`, `no-referrer`, frame denial on every response; `no-store` on API
  responses.
- Logs carry job ids, not txids, order keys, memos, PSBTs or addresses. The one exception is the error
  logged when a broadcast succeeded but could not be recorded, so the txid is recoverable.
- Retention: the tracker deletes fee history, order notes and finished jobs older than
  `FEEPILOT_RETENTION_DAYS` (default 30, 0 keeps all) every hour. The newest good snapshot per network
  and any unfinished job are kept.
- Signet: see [`SIGNET.md`](SIGNET.md). The smoke check exists but has not been run on a live signet.

## Demo

`scripts/demo.sh` starts the regtest node, API and tracker, creates a stuck payment, plays the offline
story (snapshot, node stopped so the refresh fails and the last snapshot is kept, an offline note,
node restarted, re-sync without duplicates, a reported conflict), then runs
analyze -> RBF -> sign -> broadcast -> confirm -> settle over the API. `scripts/demo.sh ui` stops
before the user steps and prints the address of the web UI. `demo-sign.sh` stands in for the user's
wallet and `demo-mine.sh` for a miner; both are regtest-only.
