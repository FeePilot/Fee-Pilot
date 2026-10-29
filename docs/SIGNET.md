# Running FeePilot on signet

Signet is a public test network with worthless coins. It is the first place the fee cache and the
offline advisor meet estimates that come from a live network instead of a fixed fallback. Regtest
cannot do that: it has no estimates at all. Signet is not a realistic fee market, though: it has
little real fee pressure, and public services disagree about it (see `ROADMAP.md`, F6b). Use it to
check plumbing, labels and freshness, not to tune fee behaviour.

You do not have to sync a signet node just to read fee estimates. F6b plans an optional
third-party HTTP fee source (Blockstream Esplora or mempool.space) for that. A node is still needed
to analyse transactions and build PSBTs.

**Status:** the code treats signet like any other network, and `scripts/signet-check.sh` is the
read-only smoke test. As of this writing the check has **not** been run against a live signet node
(syncing one was outside the development environment), so treat signet support as untested until
you have run it.

## 0. No node, fees only (optional)

To see the fee snapshot and offline advisor on signet without syncing a node, point the fee source
at a public API in `.env`:

```
FEEPILOT_NETWORK=signet
FEEPILOT_FEE_API_KIND=esplora
FEEPILOT_FEE_API_URL=https://blockstream.info/signet/api
# or: FEEPILOT_FEE_API_KIND=mempool_space  FEEPILOT_FEE_API_URL=https://mempool.space/signet/api
```

Only the snapshot comes from the API. Estimates are labelled `third_party`, nothing is borrowed from
the fallback rate, and the relay and mempool floors show as unknown. Analysing transactions and
building PSBTs still need a node (the API is never sent a txid). FeePilot cannot tell whether the
URL really is signet, so check it matches `FEEPILOT_NETWORK`. Esplora worked live on 2026-10-28;
mempool.space did not answer FeePilot from the development machine (see `ROADMAP.md`, F6b).

## 1. A signet node

```bash
bitcoind -signet -daemon -txindex=1 -rpcuser=feepilot -rpcpassword=<a real password>
bitcoin-cli -signet getblockchaininfo     # wait until initialblockdownload is false
```

Signet syncs in minutes to a few hours depending on the connection. `-txindex=1` is needed so
confirmed transactions can be inspected. Fee estimates need the node to have seen enough blocks and
mempool traffic; for the first hour or so `estimatesmartfee` may answer "Insufficient data".

## 2. Point FeePilot at it

In `.env` (RPC port for signet is 38332):

```
FEEPILOT_NETWORK=signet
BITCOIN_RPC_URL=http://127.0.0.1:38332
BITCOIN_RPC_USER=feepilot
BITCOIN_RPC_PASS=<the same password>
# Leave the fallback unset so a missing estimate shows as "none" instead of a made-up rate.
# FEEPILOT_FALLBACK_FEE_RATE=
```

Start `cargo run -p feepilot-api` and `cargo run -p feepilot-tracker` as usual.

## 3. Check it

```bash
set -a; . ./.env; set +a
scripts/signet-check.sh                 # node, fee snapshot, security headers
scripts/signet-check.sh <signet-txid>   # also analyze a transaction
```

The script refuses to continue if the node or the API is not on signet. It does not create, sign
or broadcast anything.

## What to look at

- The fee snapshot should show `node` as the source for at least the 2 and 6 block targets. Each
  `fallback` or `none` means the node has no estimate for that target yet.
- Stop the node, then refresh in the UI: the card should switch to Offline mode and keep the saved
  snapshot with its age.
- Create a stuck transaction from a signet wallet (a faucet funds it), analyze it, and walk the
  RBF or CPFP flow with your own wallet signing the PSBT.

## Before exposing it publicly

- Put it behind a reverse proxy with TLS, and rate-limit there as well: the built-in limiter keys on
  the connecting address, which behind a proxy is the proxy.
- Use a dedicated, least-privilege RPC user and keep the node's RPC port off the network.
- Keep `FEEPILOT_RETENTION_DAYS` at a value you are comfortable with (default 30).
- The UI shows a red warning on mainnet: FeePilot is an early build.
