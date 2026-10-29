#!/usr/bin/env bash
# Creates stuck-transaction scenarios on ANY regtest node (Polar, or the demo node).
# Settings come from the same variables FeePilot uses; the sender wallet defaults to Polar's "".
#   BITCOIN_RPC_URL (default http://127.0.0.1:18443)  BITCOIN_RPC_USER  BITCOIN_RPC_PASS
#   SENDER_WALLET (default "")   RECEIVER_WALLET (default receiver)
# Each scenario spends its own coin, so no scenario is an unconfirmed ancestor of another.
# Nothing is mined after the scenarios are created; the transactions stay pending.
set -euo pipefail

URL="${BITCOIN_RPC_URL:-http://127.0.0.1:18443}"
HOSTPORT="${URL#*://}"; HOSTPORT="${HOSTPORT%%/*}"
CLI=(bitcoin-cli -regtest -rpcconnect="${HOSTPORT%:*}" -rpcport="${HOSTPORT##*:}"
     -rpcuser="${BITCOIN_RPC_USER:-feepilot}" -rpcpassword="${BITCOIN_RPC_PASS:-change-me}")
SW="${SENDER_WALLET-}"; RW="${RECEIVER_WALLET:-receiver}"
S=("${CLI[@]}" "-rpcwallet=$SW"); R=("${CLI[@]}" "-rpcwallet=$RW")

[ "$("${CLI[@]}" getblockchaininfo | jq -r .chain)" = regtest ] || { echo "not a regtest node" >&2; exit 1; }
"${CLI[@]}" -named createwallet wallet_name="$RW" >/dev/null 2>&1 || "${CLI[@]}" loadwallet "$RW" >/dev/null 2>&1 || true

# Need 4 separate mature coins.
MATURE() { "${S[@]}" listunspent 1 | jq '[.[] | select(.spendable and .amount>1)] | length'; }
if [ "$(MATURE)" -lt 4 ]; then
  echo "funding the sender wallet (mining 105 blocks)..." >&2
  "${CLI[@]}" generatetoaddress 105 "$("${S[@]}" getnewaddress)" >/dev/null
fi
mapfile -t COINS < <("${S[@]}" listunspent 1 | jq -r '[.[] | select(.spendable and .amount>1)][0:4][] | "\(.txid):\(.vout)"')

# name, fee_rate (sat/vB), replaceable
send_one() {
  local coin="$1" rate="$2" rbf="$3" dest txid raw pay change
  dest=$("${R[@]}" getnewaddress)
  txid=$("${S[@]}" -named send outputs="{\"$dest\":0.01}" fee_rate="$rate" \
    options="{\"inputs\":[{\"txid\":\"${coin%:*}\",\"vout\":${coin#*:}}],\"add_inputs\":false,\"replaceable\":$rbf}" | jq -r .txid)
  raw=$("${CLI[@]}" getrawtransaction "$txid" 1)
  pay=$(jq -r --arg a "$dest" '.vout[]|select(.scriptPubKey.address==$a)|.n' <<<"$raw")
  change=$(jq -r --arg a "$dest" '.vout[]|select(.scriptPubKey.address!=$a)|.n' <<<"$raw")
  printf '%s|%s|%s|%s|%s\n' "$txid" "$change" "$pay" "$dest" "$(jq -r '.vsize' <<<"$raw")"
}

echo
printf '%-34s %-9s %-7s %s\n' SCENARIO "CHANGE" "PAYS-ME" TXID
row() { IFS='|' read -r txid change pay dest vsize <<<"$2"; printf '%-34s vout %-4s vout %-2s %s\n' "$1" "$change" "$pay" "$txid"; }
A=$(send_one "${COINS[0]}" 1  true);  row "A  RBF: low fee, signals RBF"   "$A"
B=$(send_one "${COINS[1]}" 1  true);  row "B  CPFP: low fee, you receive"   "$B"
C=$(send_one "${COINS[2]}" 1  false); row "C  Low fee, no RBF signal"       "$C"
D=$(send_one "${COINS[3]}" 30 true);  row "D  Healthy fee (should say Wait)" "$D"

echo
echo "CPFP destination (an address of the receiver wallet to send the child to):"
echo "  $("${R[@]}" getnewaddress)"
echo
echo "Sign with: bitcoin-cli ... -rpcwallet=\"$SW\" walletprocesspsbt <psbt>   (RBF: sender)"
echo "           bitcoin-cli ... -rpcwallet=$RW walletprocesspsbt <psbt>      (CPFP: receiver)"
