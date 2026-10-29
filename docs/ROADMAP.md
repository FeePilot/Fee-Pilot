# Implementation roadmap

Source of truth for scope: [`FeePilot.pdf`](../FeePilot.pdf) (project documentation v2.0, October 2026),
which evolves the original recovery-first concept (ConfirmShield) with an offline-first
fee-awareness layer. This file turns it into buildable phases.

Two tracks:

- **Track R: Recovery** is the original scope. It is **done** and demo-able. It covers the doc's
  recovery workflow (§5C), strategy engine (§8), tracking, and the regtest recovery demo.
- **Track F: Fee awareness and offline continuity** is what v2.0 adds and what comes **next**.
  It covers fee snapshots, the offline advisor, the offline order queue, and reconnect and verify.

Each phase ends with a demo-able, tested result. External accelerators stay **deferred past the MVP**
(they need paid access and fees); the MVP covers RBF, CPFP and Wait.

## Track R: Recovery (done)

| Phase | Deliverable | Status |
|---|---|---|
| R0. Foundations | Workspace, CI, regtest scripts, schema, RBF spike | Done |
| R1. Analysis | `CoreRpc::analyze`, `GET /v1/analyze/{txid}` | Done |
| R2. Decision engine | Eligibility rules, ranking, API schema for RBF / CPFP / Wait | Done |
| R3. Test recovery | PSBT-based RBF, then CPFP, with explicit signing | Done |
| R4. Tracking | Worker, history table, reorg handling, notification | Done |
| R5. Frontend and recovery demo | txid -> analysis -> compare -> PSBT hand-off -> history; `scripts/demo.sh` | Done |

Doc phase 5 ("Recovery demo") is satisfied by R3 to R5. The doc's phase 4 item "inspect txids" is
satisfied by R1 and R4; the rest of that phase is F4 below.

## Track F: Fee awareness and offline continuity (F1-F6b done; F7 optional)

The doc's priority is a polished offline fee-awareness experience plus safe reconciliation, with
recovery added after the cache and reconnect behaviour work. Recovery was built first, so Track F is
the main remaining MVP work.

| Phase | Deliverable | Done when |
|---|---|---|
| F1. Fee cache (**done**) | Fee snapshot service: fetch estimates for several targets, validate, timestamp and persist. `GET /v1/fees` (refresh) and `GET /v1/fees/latest`. | Stores `network`, `fetched_at`, target estimates, units, relay and mempool minimum fees, source, error and schema version. Missing estimates (regtest has none) are explicit `None`s, never invented. Unit conversion (BTC/kvB to sat/vB) has test vectors. |
| F2. Offline advisor (**done**) | Freshness policy and an offline fee screen. Pick a cached estimate by urgency; compute total fee = rate x vsize when the vsize is known, otherwise show a range or say it is unknown. | Freshness states (recent, past the window, very stale or missing, high urgency with stale data) are configurable and tested with simulated snapshot ages. The UI shows Offline mode, the snapshot time and age, and never presents cached data as live. |
| F3. Offline queue (**done**) | Local order and payment-attempt records. | Each record has a unique local ID and the state `awaiting_verification`; records survive refresh and restart; a record is never shown as proof of payment. |
| F4. Reconnect and verify (**done**) | Idempotent sync of queued records, snapshot refresh, txid inspection. | Re-syncing the same records creates no duplicates; conflict states are reported; "not seen by this node" is never worded as "does not exist". |
| F5. Offline demo (**done**) | Extend `scripts/demo.sh` with the doc's demo script (§12): snapshot, simulate losing connectivity, offline record, reconnect, reconcile, then recovery. | Scripted end-to-end run passes. |
| F6. Hardening (**done**, see note) | Rate limits, retention, log and identifier minimisation, signet run, docs. | Safe to show publicly. |
| F6b. HTTP fee source (**built**, see note) | Optional third-party fee source for the snapshot, so signet fee data needs no local node. Esplora `fee-estimates` (Blockstream) first, mempool.space `fees/recommended` as the second adapter. | `FEEPILOT_FEE_API_URL` selects it; the snapshot labels each estimate `third_party` and names the service as `source`; unmapped or malformed values become `unavailable`; a failed call keeps the last good snapshot. Node RPC stays the source for analysis and PSBTs. |
| F7. Accelerator (optional) | One provider integration, only if access permits. | Terms and eligibility verified, service fee shown separately, consent obtained, provider response reported accurately. A bonus, not a dependency. |

**F6 note:** rate limit, security headers, log minimisation, retention and the signet guide and
check script are built and tested. The signet *run* itself has not been done: `scripts/signet-check.sh`
is ready, but no signet node was available. Run it before calling the project safe to show publicly.

### Details and decisions

**F1. Fee cache**
- Bitcoin Core: `estimatesmartfee` at several confirmation targets (for example 2, 6 and 144 blocks
  for fast, medium and economy), plus `getmempoolinfo` (`mempoolminfee`, `minrelaytxfee`).
- Do not confuse the minimum relay fee with a rate likely to confirm quickly.
- On regtest `estimatesmartfee` returns no estimate. The configured `FEEPILOT_FALLBACK_FEE_RATE` must
  then be recorded as the source (`fallback`), so the UI can say so.
- Persist in PostgreSQL. A refresh that fails is recorded as an error and does not overwrite the
  last good snapshot.

**F2. Offline advisor**
- Freshness windows are configuration, not constants. A fixed percentage uplift is not a substitute
  for fresh data. An old snapshot lowers confidence; it does not prove the fee is too low.
- The offline copy lives in the browser, so the UI keeps working when the API is unreachable:
  the last snapshot plus the pre-computed options per urgency.
- Offline mode supports planning, record keeping and cached information. It cannot broadcast and
  proves nothing about broadcast, receipt or confirmation.

**F3. Offline queue**
- Local-first: browser storage for the web prototype (IndexedDB preferred over `localStorage` for
  records). SQLite is the option if a desktop or local service is chosen later.
- Order schema: client-generated UUID, created time, amount and memo, optional txid, state, sync
  state, idempotency key, schema version. Minimise identifiers.
- Out of scope: offline double-spend prevention, an offline ecash protocol, treating a QR code or a
  user-supplied txid as proof.

**F4. Reconnect and verify**
- Server-side sync endpoint keyed by the idempotency key; a repeat returns the existing result.
- Reuse `analyze` and the tracker for txid inspection. Wording stays "not seen by this source".
- Before any recommendation or broadcast after reconnecting, refresh the snapshot and re-check the
  transaction status; compare the actual fee rate with current estimates.

**F6b status (built).** `HttpFeeSource` (`feepilot-bitcoin::http_fees`) is selected with
`FEEPILOT_FEE_API_URL` and `FEEPILOT_FEE_API_KIND` (`esplora` default, or `mempool_space`).
Estimates are labelled `third_party`, mempool.space levels are flagged `approximate`, the fallback
rate is not applied, the floors are unknown, and a response with no usable rate is an error so the
last good snapshot stays. The UI names the source and caps confidence at "reduced".
Verified: unit tests (parsers, a local fake server for success, 503, non-JSON, oversized, no usable
rate and unreachable) and a live read-only run on 2026-10-28.
- **Esplora (Blockstream): worked live.** The snapshot came back with source `esplora`, 50.013
  sat/vB for 2 and 6 blocks and 0.1 for 144 (earlier the same service gave about 230, so it moves).
- **mempool.space: not verified live through FeePilot.** The request timed out from the dev machine
  (our client waited its full timeout) while `curl` to the same URL succeeded in 2 to 3 seconds
  on some tries and hung on others. The host resolves to two addresses and the failures look like a
  network-path problem on this machine, but that was not confirmed. The adapter was checked only
  against its documented response shape and the JSON seen once from `curl`
  (`fastestFee`, `halfHourFee`, `hourFee`, `economyFee`, `minimumFee`). Treat it as unproven until
  it has run live from the machine you will deploy on.
- Not done: the UI card was not re-screenshotted with a third-party snapshot, and no automated
  test runs the real services (they would be flaky and depend on third parties).

**F6b. HTTP fee source** (original plan, kept for the reasoning)
- Why: syncing a signet node only to read fee estimates is heavy. Fee estimates need no txid, so
  a public API is acceptable for the snapshot. It is not acceptable for transaction analysis (it
  would leak txids and cannot build PSBTs), so those stay on Core RPC.
- Services checked on 2026-10-28 from the dev machine (plain HTTPS GET, no key):

  | Service | Signet endpoint | Response shape | Checked |
  |---|---|---|---|
  | Blockstream Esplora | `https://blockstream.info/signet/api/fee-estimates` | JSON object keyed by confirmation target in blocks (`"2"`, `"6"`, `"144"`, ...), sat/vB. Maps directly onto our 2, 6 and 144 targets. | HTTP 200 |
  | mempool.space | `https://mempool.space/signet/api/v1/fees/recommended` | `fastestFee`, `halfHourFee`, `hourFee`, `economyFee`, `minimumFee`, sat/vB. Named levels, so the mapping to blocks is approximate (fastest -> 2, hour -> 6, economy -> 144). | HTTP 200 |

- Both are third-party and may rate-limit or change. Neither is a guarantee: the snapshot labels
  them and never presents them as node data.
- Observed oddity: at the time of the check the two disagreed sharply (Blockstream returned about
  230 sat/vB for most targets and 0.1 for 1008; mempool.space returned 1 sat/vB everywhere).
  Signet has little real fee pressure, so these numbers test the plumbing, labels and freshness
  logic, not a realistic market. Do not tune the freshness windows or urgency multipliers from
  signet data alone.
- Some other mempool.space calls timed out from the dev machine during the check: a mainnet fee
  endpoint (tried only for comparison, not planned) and two signet routes we do not need
  (`/signet/api/mempool`, `/signet/api/v1/fees/mempool-blocks`). The planned signet endpoints
  answered, but each was fetched only once, so the adapter must treat a timeout as a failed refresh.
- Mapping rule: use the exact block key when the service provides it (Esplora); for named levels use
  the nearest level and record the approximation in the snapshot.
- Verification plan: unit tests with captured responses (normal, missing keys, non-numeric, empty);
  a live read-only run against signet; UI check that the card shows the third-party source.

### Open decisions (doc §14)

| Question | Proposal |
|---|---|
| Supported networks | Regtest and signet for development; mainnet read-only analysis until F6 |
| Fee source for signet | Third-party HTTP fee source (F6b) instead of syncing a signet node; Esplora first. Local signet node stays an option |
| RPC methods and fields for snapshots | As in F1; pin to the tested Bitcoin Core version and map units explicitly |
| Initial freshness policy | Defaults of 10 minutes (recent) and 1 hour (stale), configurable; tune with tests |
| Local persistence | Browser IndexedDB for the web prototype; revisit if a desktop build is chosen |
| Order schema and idempotency | As in F3; finalise before building F4 |
| Signing boundary | Already documented and enforced in R3: unsigned PSBT out, verified signed PSBT in, no keys in the backend |

## Success metrics (doc §13) and how we measure them

| Metric | Where it is measured |
|---|---|
| Share of online refreshes that give a valid, timestamped snapshot | F1 tests and a counter in the refresh log |
| Fee units and total-fee correctness | F1 and F2 test vectors |
| Freshness labels for simulated ages | F2 tests |
| Offline records reconciled without duplicates | F4 tests |
| Explainability of analysis and recommendations | R2 scenario matrix (done); UI review |
| Regtest recovery demo completes | `scripts/demo.sh` (done); extended in F5 |
| Analysis time; network fee vs provider charge understanding | Timing in the API logs; UI shows them separately (done) |
| Accuracy of tracked state transitions | R4 live tests (done) |

## Later (post-MVP)

Accelerator providers, only after confirming API access, terms and pricing; needs a
consent-and-quote step.

Accelerator placeholders stay in the code (`AcceleratorProvider` trait, an `Unknown` route option)
so adding a provider later needs no redesign. Until then the UI shows "external accelerators: not
yet supported".
