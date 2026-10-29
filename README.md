# FeePilot

**Offline fee awareness, payment continuity and transaction recovery for Bitcoin.**

FeePilot helps users and merchants choose a sensible fee before they broadcast, keep working through connectivity gaps, and recover when a transaction gets stuck. It evolves the original ConfirmShield recovery concept with an offline-first fee-awareness layer. Full scope: [`FeePilot.pdf`](FeePilot.pdf) (project documentation v2.0).



**Recovery (built).** Give FeePilot a txid and it analyzes the transaction's state, fee rate and mempool context, then compares the feasible recovery routes (**RBF** or **CPFP**, with **external accelerators** planned for later) with explicit costs and uncertainty. It guides you through authorizing the chosen route, then tracks the outcome until confirmation.

**Fee awareness and offline continuity (next).** When online, FeePilot saves a timestamped fee snapshot. When offline, it still shows that snapshot with its age and a freshness warning, and lets a merchant keep local order records marked *Awaiting verification*. On reconnecting it refreshes the estimates, syncs the records without duplicates, and checks transaction status before recommending or doing anything.

> **Core promise:** help users choose a reasonable fee, keep records through outages, and carry out a feasible recovery strategy for an unconfirmed Bitcoin transaction, with clear costs and limitations. FeePilot never claims to control miners, guarantee confirmation, or turn cached data into live data.

Status: **recovery track done, fee-awareness track next** (v0.1). Built: FeePilot analyzes a txid against Bitcoin Core, ranks RBF, CPFP and Wait by cost, urgency and budget, carries out an RBF or CPFP recovery on regtest (unsigned PSBT out, your wallet signs, verified PSBT in), and then tracks the job: it tells a replaced transaction from an evicted one, follows confirmations, survives reorgs, and notifies you. A web UI walks through the whole flow, and `scripts/demo.sh` runs it end to end on regtest. Not built yet: the fee snapshot cache, offline advisor, offline order queue, sync and reconciliation, and hardening (see the roadmap below).

## Who it's for
- Everyday users whose payments are taking too long.
- Merchants who need visibility into pending customer payments.
- Technical users who want to compare fee bumping with paid acceleration.
- Merchants on unreliable internet who need records and fee context during an outage.

## How it works

**Online / offline / reconnect** *(built)*

- **Online:** refresh fee estimates for several confirmation targets and save a snapshot (network, timestamp, units, relay and mempool minimums, source).
- **Offline:** show the last snapshot with its age and a freshness warning, pick a cached estimate for your urgency, and estimate the total fee only when the transaction size is known (total fee = sat/vB x vsize). Merchants can create local order records that stay *Awaiting verification*.
- **Reconnected:** refresh the estimates, sync local records idempotently, inspect the transaction, then warn, wait, RBF or CPFP, with explicit authorization before anything is signed or broadcast.

**Recovery flow** *(built)*

1. **Submit**: enter a txid, optionally an urgency and a maximum budget.
2. **Analyze**: fetch the transaction, fee rate, mempool ancestors/descendants and current fee estimates.
3. **Check eligibility**: is RBF possible? Is there a spendable output for CPFP? Will a provider accept it?
4. **Compare**: see each route's network fee, provider charge, requirements, risks and unknowns.
5. **Authorize**: FeePilot builds an *unsigned* PSBT; you sign it in your own wallet. Paid accelerator requests need explicit consent.
6. **Submit & monitor**: broadcast/submit, then track pending → replaced → confirmed.

| Route | Use when | Needs |
|---|---|---|
| RBF | A valid higher-fee replacement can be built | Signing authority over the original inputs; replacement fee rules |
| CPFP | You control an output of the stuck tx | Signing authority over that output; package fee competitive |
| Accelerator *(planned, not in MVP)* | A provider accepts the tx | Provider access, price consent. No inclusion guarantee |
| Wait | Nothing is feasible or worth the cost | None; FeePilot explains why |

## Safety principles
- **No private keys in the backend.** Candidates are unsigned PSBTs; signing happens in a wallet or signer.
- **No broadcast or payment without explicit approval.**
- **Evidence-based recommendations.** Unknown facts are reported as unknown, never assumed eligible.
- **Offline truthfulness.** A saved estimate, local order, QR code or user-supplied txid is not proof of broadcast, receipt or confirmation. Cached data is always labelled with its age and is never shown as live.
- **Observation limits.** A transaction missing from one node may exist elsewhere: FeePilot says "not seen by this source", never "does not exist".
- **No network mix-ups.** Snapshots and jobs carry their network; mainnet, testnet and regtest data are never blended.
- **Cost transparency.** Bitcoin network fees and provider service charges are always shown separately, with a final quote before payment.
- **Reorg-aware.** One confirmation is not treated as final.
- **Privacy.** Minimal stored identifiers, rate-limited public endpoints, defined retention.

## Repository layout

```
Cargo.toml                 Rust workspace
crates/
  feepilot-core/           Pure domain logic: types, RBF/CPFP fee math, strategy engine (tested)
  feepilot-bitcoin/        BitcoinDataSource (Core RPC) + SigningBoundary (PSBT) traits
  feepilot-providers/      AcceleratorProvider trait + adapters
  feepilot-api/            Axum HTTP API: analysis, recovery jobs, PostgreSQL job store
  feepilot-store/          Persistence for jobs, fee snapshots and order notes: PgStore (PostgreSQL) and MemStore (tests)
  feepilot-tracker/        Worker: status tracking, history, reorgs, notifications
migrations/                PostgreSQL schema
scripts/regtest-setup.sh   Spin up a funded Bitcoin Core regtest node
frontend/                  React web app (Vite + TypeScript), built to frontend/dist and served by the API
docs/                      ARCHITECTURE.md, ROADMAP.md, SIGNET.md
docker-compose.yml         Local PostgreSQL
```

More detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Getting started

Prerequisites: Rust (stable), Bitcoin Core (`bitcoind`, `bitcoin-cli`), Docker (for PostgreSQL).

```bash
cp .env.example .env              # then set a real RPC password
docker compose up -d postgres     # PostgreSQL on :5432 (or point DATABASE_URL at your own)
./scripts/regtest-setup.sh        # throwaway regtest node + funded wallet
cargo test                        # unit tests (no node or database needed)
cargo test --workspace -- --ignored --test-threads=1   # live regtest + PostgreSQL tests
set -a; . ./.env; set +a          # export the settings
cargo run -p feepilot-api         # API on 127.0.0.1:8080; applies migrations on start
cargo run -p feepilot-tracker     # tracking worker: polls active jobs, records history, notifies
# web app: cd frontend && pnpm install && pnpm build, then open http://127.0.0.1:8080/ (FEEPILOT_WEB_DIR=frontend/dist is in .env.example)
```

Settings for the offline advisor, rate limit and retention are documented in `.env.example`. Running on signet: [`docs/SIGNET.md`](docs/SIGNET.md).

Or see the whole thing at once on regtest: `scripts/demo.sh ui` (browser) or `scripts/demo.sh` (scripted).

Try it:
```bash
curl localhost:8080/health
curl "localhost:8080/v1/analyze/<txid>?can_sign_inputs=true&urgency=normal&max_budget_sat=5000"
# -> analysis, per-route eligibility and cost, recommended route and rationale
```

Recover a stuck transaction (regtest):
```bash
# 1. You sent it: replace it with a higher-fee version. change_vout is your change output.
curl -X POST localhost:8080/v1/jobs/rbf -H 'content-type: application/json' \
  -d '{"txid":"<txid>","change_vout":1,"urgency":"normal","max_budget_sat":5000}'
# or you received it: spend your output in a fee-paying child.
curl -X POST localhost:8080/v1/jobs/cpfp -H 'content-type: application/json' \
  -d '{"txid":"<txid>","vout":0,"destination":"<your address>"}'
# -> { job_id, psbt, fee_sat, extra_fee_sat, ... }

# 2. Sign "psbt" in your own wallet (e.g. Sparrow, or `bitcoin-cli walletprocesspsbt`), then:
curl -X POST localhost:8080/v1/jobs/<job_id>/submit -H 'content-type: application/json' \
  -d '{"signed_psbt":"<signed psbt>"}'
# -> state "broadcast" and the new recovery_txid
curl localhost:8080/v1/jobs/<job_id>      # current state
curl localhost:8080/v1/jobs/<job_id>/history   # every status change the tracker saw
```
Job states: `awaiting_signature` -> `broadcast` -> `confirmed` -> `settled` (6 confirmations by default),
or `obsolete` if the original confirmed or was replaced by someone else first. A reorg drops
`confirmed` back to `broadcast`. Set `FEEPILOT_WEBHOOK_URL` to receive each state change as JSON.
FeePilot refuses to broadcast a signed PSBT whose inputs, outputs, amounts or sequences differ from the one it issued.

Use regtest (or signet) while developing. Do not point an early build at mainnet funds.

## Tech stack
Rust · Axum · Tokio · PostgreSQL (SQLx, to be wired in) · Bitcoin Core RPC · Bitcoin Core regtest / Polar for repeatable RBF/CPFP experiments.

## Roadmap

Two tracks, from [`FeePilot.pdf`](FeePilot.pdf) v2.0. Details, acceptance criteria and open decisions: [`docs/ROADMAP.md`](docs/ROADMAP.md).

**Track R: Recovery (done)**

| Phase | Deliverable | Status |
|---|---|---|
| R0. Foundations | Workspace, CI, regtest scripts, schema, RBF spike | Done |
| R1. Analysis | Txid lookup and analysis | Done |
| R2. Decision engine | RBF/CPFP/Wait comparison with reasons | Done |
| R3. Test recovery | End-to-end RBF, then CPFP, on regtest | Done |
| R4. Tracking | Pending, replaced, confirmed and reorged states | Done |
| R5. Frontend and demo | Full user flow, scripted demo | Done |

**Track F: Fee awareness and offline continuity (done, except the optional F7)**

| Phase | Deliverable | Done when |
|---|---|---|
| F1. Fee cache (done) | Online fee snapshots, persisted | Estimates fetched for configured targets; timestamp, network and units stored; missing estimates handled |
| F2. Offline advisor (done) | Offline fee screen, urgency and freshness | Saved values shown offline with age; uncertainty explained; total fee computed when vsize is known |
| F3. Offline queue (done) | Local order and payment-attempt records | Records survive restart; unique IDs; stay *Awaiting verification* |
| F4. Reconnect and verify (done) | Refresh, idempotent sync, txid inspection | No duplicates on re-sync; "not seen by this node" is not "absent" |
| F5. Offline demo (done) | Demo script covering offline and reconnect, then recovery | Scripted end-to-end run |
| F6. Hardening (done) | Rate limits, retention, security headers, signet guide and check | Safe to show publicly. The signet check has not been run on a live signet yet |
| F7. Accelerator (optional) | One provider, if access permits | Terms checked, service fee shown, consent obtained. A bonus, not a dependency |

## Scope
**In (MVP):** txid analysis, RBF/CPFP guided workflows, strategy comparison, status tracking, fee snapshot cache, offline fee advisor, offline order queue, sync and reconciliation *(all built)*.
**Later:** external accelerator integration (paid; deferred).
**Out:** guaranteeing confirmation or presenting a cached fee as the current one, broadcasting on-chain transactions while every device is offline, treating a local order, QR code or user-supplied txid as proof of payment, a full offline Bitcoin or ecash protocol (including offline double-spend prevention), mining simulation, operating a pool, automatic signing/spending, universal wallet support from day one.

## Limitations
A txid is enough to *inspect* a transaction but not to authorize RBF or CPFP. Fee estimates are probabilistic and time-sensitive, and cached estimates cannot show the live fee market while disconnected. "Offline" here means offline-first records and cached information, not trustless offline settlement. Regtest is repeatable but does not reproduce real fee-market pressure. Different nodes and miners apply different policies. The first version supports a narrow, well-tested set of scenarios.

## License
MIT (see `Cargo.toml`; add a `LICENSE` file before publishing).
