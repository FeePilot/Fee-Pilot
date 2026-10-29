#!/usr/bin/env bash
# Demo on regtest (offline continuity, then recovery).
#   scripts/demo.sh        scripted run: fee snapshot -> node goes away -> offline note -> reconnect and
#                          reconcile -> stuck tx -> analyze -> RBF -> sign -> broadcast -> settled
#   scripts/demo.sh ui     start everything, create a stuck tx and print the web UI address
# Needs: bitcoind, bitcoin-cli, jq, curl, a reachable PostgreSQL (DATABASE_URL), cargo.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/demo-env.sh
MODE="${1:-auto}"

for tool in bitcoind bitcoin-cli jq curl cargo; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
say()  { printf '   %s\n' "$*"; }

step "Building and starting FeePilot (regtest node, API, tracker)"
cargo build -q -p feepilot-api -p feepilot-tracker
scripts/regtest-setup.sh >/dev/null
mkdir -p .regtest
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
FEEPILOT_TRACK_INTERVAL_SECS=2 target/debug/feepilot-api     >.regtest/api.log     2>&1 & PIDS+=($!)
FEEPILOT_TRACK_INTERVAL_SECS=2 target/debug/feepilot-tracker >.regtest/tracker.log 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -fs "$API/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs "$API/health" >/dev/null || { echo "API did not start; see .regtest/api.log" >&2; exit 1; }
say "API and web UI: $API"

step "Creating a stuck payment (1 sat/vB, RBF-signalling)"
scripts/demo-stuck-tx.sh | sed 's/^/   /'
. .regtest/demo.env

if [ "$MODE" = "ui" ]; then
  step "Ready"
  if [ -f "$FEEPILOT_WEB_DIR/app-shell.html" ]; then APP_URL="$API/app?txid=$TXID"; else APP_URL="$API/?txid=$TXID"; fi
  say "Open:      $APP_URL"
  say "RBF:       choose \"I sent it\" -> Yes, then change output = vout $CHANGE_VOUT"
  say "CPFP:      choose \"I received it\" -> Yes, output vout $PAY_VOUT, destination $RECV_ADDR"
  say "Sign:      scripts/demo-sign.sh <psbt>   (stands in for your wallet)"
  say "Confirm:   scripts/demo-mine.sh 1   then   scripts/demo-mine.sh 5  to settle"
  say "Ctrl-C stops the API and tracker."
  wait
  exit 0
fi

step "A. Fee snapshot while online"
FEES=$(curl -fs "$API/v1/fees")
jq -r '.snapshot.estimates[] | "   \(.blocks) blocks: \(.sat_per_vb // "none") sat/vB (\(.source))"' <<<"$FEES"
say "regtest has no market estimates, so the configured fallback is recorded as such"
say "relay floor $(jq -r .snapshot.min_relay_fee_sat_per_vb <<<"$FEES") sat/vB (a floor, not a target)"

step "B. Connectivity is lost (the node is stopped)"
"${CLI[@]}" stop >/dev/null
while pgrep -f "bitcoind.*${DATADIR}" >/dev/null 2>&1; do sleep 0.5; done
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/fees")
say "refresh attempt: HTTP $CODE (expected 502)"
[ "$CODE" = "502" ] || { echo "expected the refresh to fail with 502" >&2; exit 1; }
LATEST=$(curl -fs "$API/v1/fees/latest")
[ "$(jq -r .snapshot.fetched_at <<<"$LATEST")" = "$(jq -r .snapshot.fetched_at <<<"$FEES")" ] \
  || { echo "the last good snapshot was lost" >&2; exit 1; }
say "last good snapshot kept; the failed refresh is recorded: $(jq -r .last_error.message <<<"$LATEST")"

step "C. An offline note is recorded (awaiting verification, not proof of payment)"
KEY=$(cat /proc/sys/kernel/random/uuid); CID=$(cat /proc/sys/kernel/random/uuid)
NOTE=$(jq -n --arg k "$KEY" --arg c "$CID" --arg tx "$TXID" \
  '{orders:[{id:$c, idempotency_key:$k, amount_sat:50000, memo:"demo order", txid:$tx, created_at:1, schema_version:1}]}')
R1=$(curl -fs -X POST "$API/v1/orders/sync" -H 'content-type: application/json' -d "$NOTE")
say "$(jq -r '.results[0] | "outcome \(.outcome), state \(.state)"' <<<"$R1")"
say "$(jq -r '.results[0].note' <<<"$R1")"
[ "$(jq -r '.results[0].state' <<<"$R1")" = "awaiting_verification" ] || { echo "expected awaiting_verification" >&2; exit 1; }

step "D. Reconnect: restart the node, refresh the snapshot"
bitcoind -regtest -daemon -datadir="$DATADIR" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS" \
  -fallbackfee=0.00001 -txindex=1 >/dev/null
until "${CLI[@]}" getblockchaininfo >/dev/null 2>&1; do sleep 0.5; done
"${CLI[@]}" loadwallet sender >/dev/null 2>&1 || true
"${CLI[@]}" loadwallet receiver >/dev/null 2>&1 || true
FEES2=$(curl -fs "$API/v1/fees")
[ "$(jq -r .last_error <<<"$(curl -fs "$API/v1/fees/latest")")" = "null" ] || { echo "error not cleared" >&2; exit 1; }
say "snapshot refreshed at $(jq -r .snapshot.fetched_at <<<"$FEES2"); the error is cleared"

step "E. Reconcile: the same note again, then a conflicting one"
R2=$(curl -fs -X POST "$API/v1/orders/sync" -H 'content-type: application/json' -d "$NOTE")
say "re-sync: $(jq -r '.results[0] | "outcome \(.outcome), state \(.state)"' <<<"$R2")"
say "$(jq -r '.results[0].note' <<<"$R2")"
say "$(jq -r '.results[0].observation | "paying \(.fee_rate_sat_vb) sat/vB vs target \(.target_fee_rate_sat_vb); below target: \(.fee_below_target)"' <<<"$R2")"
[ "$(jq -r '.results[0].outcome' <<<"$R2")" = "existing" ] || { echo "expected no duplicate" >&2; exit 1; }
BAD=$(jq '.orders[0].amount_sat = 1' <<<"$NOTE")
R3=$(curl -fs -X POST "$API/v1/orders/sync" -H 'content-type: application/json' -d "$BAD")
say "different payload, same key: $(jq -r '.results[0].outcome' <<<"$R3") (the stored note is kept)"
[ "$(jq -r '.results[0].outcome' <<<"$R3")" = "conflict" ] || { echo "expected a conflict" >&2; exit 1; }

step "Recovery: 1. Analyze"
REC=$(curl -fs "$API/v1/analyze/$TXID?urgency=normal&max_budget_sat=20000&can_sign_inputs=true")
jq -r '"   status: \(.analysis.status), paying \(.analysis.fee_sat / .analysis.vsize | . * 10 | round / 10) sat/vB, target \(.analysis.target_fee_rate) sat/vB"' <<<"$REC"
jq -r '.options[] | "   \(.kind): \(.eligibility.state), extra network fee \(.network_fee_sat // "n/a") sat"' <<<"$REC"
say "recommended: $(jq -r .recommended <<<"$REC")"

step "Recovery: 2. Build the unsigned RBF replacement"
JOB=$(curl -fs -X POST "$API/v1/jobs/rbf" -H 'content-type: application/json' \
  -d "{\"txid\":\"$TXID\",\"change_vout\":$CHANGE_VOUT,\"urgency\":\"normal\",\"max_budget_sat\":20000}")
JOB_ID=$(jq -r .job_id <<<"$JOB")
say "job $JOB_ID, new fee $(jq -r .fee_sat <<<"$JOB") sat (+$(jq -r .extra_fee_sat <<<"$JOB") sat)"
say "$(jq -r .description <<<"$JOB")"

step "Recovery: 3. Sign (the demo wallet stands in for the user's own wallet)"
SIGNED=$(scripts/demo-sign.sh "$(jq -r .psbt <<<"$JOB")")
say "signed PSBT: ${SIGNED:0:40}…"

step "Recovery: 4. Approve and broadcast"
SUB=$(curl -fs -X POST "$API/v1/jobs/$JOB_ID/submit" -H 'content-type: application/json' -d "{\"signed_psbt\":\"$SIGNED\"}")
say "state: $(jq -r .state <<<"$SUB"), recovery txid $(jq -r .recovery_txid <<<"$SUB")"

wait_for() { # state, tries
  for _ in $(seq 1 "$2"); do
    [ "$(curl -fs "$API/v1/jobs/$JOB_ID" | jq -r .state)" = "$1" ] && return 0
    sleep 1
  done
  echo "timed out waiting for state $1 (see .regtest/tracker.log)" >&2; return 1
}

step "Recovery: 5. A miner includes it; the tracker follows"
scripts/demo-mine.sh 1 | sed 's/^/   /'
wait_for confirmed 30
say "state: confirmed"
scripts/demo-mine.sh 5 | sed 's/^/   /'
wait_for settled 30
say "state: settled"

step "History recorded by the tracker"
curl -fs "$API/v1/jobs/$JOB_ID/history" | jq -r '.[] | "   \(.observed_at)  \(.status) (\(.confirmations) conf)  \(.txid[0:12])…\(if .detail then "  -> " + .detail[0:12] + "…" else "" end)"'
step "Done. Offline continuity reconciled without duplicates; the original was replaced and settled."
