#!/usr/bin/env bash
# Read-only smoke check of FeePilot against a signet node. It creates, signs and broadcasts
# nothing. Run it with the API already started against the node (see docs/SIGNET.md).
#   scripts/signet-check.sh [txid]     txid: any signet transaction to analyze (optional)
# Needs: curl, jq. Reads BITCOIN_RPC_URL/USER/PASS and the API address from the environment.
set -euo pipefail
API="http://${FEEPILOT_BIND:-127.0.0.1:8080}"
RPC="${BITCOIN_RPC_URL:?set BITCOIN_RPC_URL}"
AUTH="${BITCOIN_RPC_USER:?set BITCOIN_RPC_USER}:${BITCOIN_RPC_PASS:?set BITCOIN_RPC_PASS}"
say() { printf '   %s\n' "$*"; }
rpc() { curl -fs -u "$AUTH" --data "{\"jsonrpc\":\"1.0\",\"id\":\"c\",\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC" | jq -c .result; }

echo "== Node"
INFO=$(rpc getblockchaininfo)
CHAIN=$(jq -r .chain <<<"$INFO")
[ "$CHAIN" = "signet" ] || { echo "the node is on '$CHAIN', not signet" >&2; exit 1; }
say "chain signet, blocks $(jq -r .blocks <<<"$INFO") of $(jq -r .headers <<<"$INFO")"
[ "$(jq -r .initialblockdownload <<<"$INFO")" = "false" ] || say "WARNING: still in initial block download; estimates will be missing"
[ "$(curl -fs "$API/health" | jq -r .status)" = "ok" ] || { echo "the API is not answering at $API" >&2; exit 1; }

echo "== Fee snapshot"
FEES=$(curl -fs "$API/v1/fees")
[ "$(jq -r .snapshot.network <<<"$FEES")" = "signet" ] || { echo "the API is not configured for signet (FEEPILOT_NETWORK=signet)" >&2; exit 1; }
jq -r '.snapshot.estimates[] | "   \(.blocks) blocks: \(.sat_per_vb // "none") sat/vB (\(.source))"' <<<"$FEES"
say "relay floor $(jq -r .snapshot.min_relay_fee_sat_per_vb <<<"$FEES") sat/vB, mempool floor $(jq -r .snapshot.mempool_min_fee_sat_per_vb <<<"$FEES") sat/vB"
if jq -e '[.snapshot.estimates[] | select(.source != "node")] | length > 0' <<<"$FEES" >/dev/null; then
  say "some estimates are not from the node (fallback or none). Unset FEEPILOT_FALLBACK_FEE_RATE to see only real ones."
fi

if [ -n "${1:-}" ]; then
  echo "== Analyze $1"
  curl -fs "$API/v1/analyze/$1" | jq -r '"   status \(.analysis.status), \(.analysis.vsize) vB, fee \(.analysis.fee_sat // "unknown") sat, target \(.analysis.target_fee_rate // "none") sat/vB\n   recommended: \(.recommended)\n   \(.rationale)"'
fi
echo "== Headers"
curl -sI "$API/" | grep -iE "^(content-security-policy|x-content-type-options|x-frame-options)" | cut -c1-70 | sed 's/^/   /'
echo "== OK (read-only)"
