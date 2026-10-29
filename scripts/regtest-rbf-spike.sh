#!/usr/bin/env bash
# Phase 0 risk spike: prove the PSBT-based RBF flow works on regtest.
#   1. create a low-fee, RBF-signalling payment that stays unconfirmed
#   2. build an UNSIGNED replacement PSBT (what FeePilot would hand to a wallet)
#   3. sign it with the wallet (stands in for the user's signer), finalize, broadcast
#   4. mine a block and confirm the replacement, not the original, confirmed
set -euo pipefail

DATADIR="${FEEPILOT_REGTEST_DIR:-$(dirname "$0")/../.regtest}"
RPCUSER="${BITCOIN_RPC_USER:-feepilot}"
RPCPASS="${BITCOIN_RPC_PASS:-change-me}"
CLI=(bitcoin-cli -regtest -datadir="$DATADIR" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS")
S=("${CLI[@]}" -rpcwallet=sender)
R=("${CLI[@]}" -rpcwallet=receiver)

"$(dirname "$0")/regtest-setup.sh" >/dev/null
"${CLI[@]}" -named createwallet wallet_name=receiver >/dev/null 2>&1 || "${CLI[@]}" loadwallet receiver >/dev/null 2>&1 || true

DEST=$("${R[@]}" getnewaddress)
ORIG=$("${S[@]}" -named send outputs="{\"$DEST\":0.01}" fee_rate=1 options='{"replaceable":true}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["txid"])')
echo "original txid:    $ORIG"
"${CLI[@]}" getmempoolentry "$ORIG" | python3 -c 'import sys,json;e=json.load(sys.stdin);print("original fee/vsize:",e["fees"]["base"],e["vsize"],"bip125-replaceable:",e["bip125-replaceable"])'

PSBT=$("${S[@]}" -named psbtbumpfee txid="$ORIG" options='{"fee_rate":20}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["psbt"]);print("origfee",d["origfee"],"newfee",d["fee"],file=sys.stderr)')
SIGNED=$("${S[@]}" walletprocesspsbt "$PSBT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["psbt"])')
HEX=$("${CLI[@]}" finalizepsbt "$SIGNED" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["complete"];print(d["hex"])')
NEW=$("${CLI[@]}" sendrawtransaction "$HEX")
echo "replacement txid: $NEW"

"${CLI[@]}" getmempoolentry "$ORIG" >/dev/null 2>&1 && { echo "FAIL: original still in mempool"; exit 1; }
"${CLI[@]}" generatetoaddress 1 "$("${S[@]}" getnewaddress)" >/dev/null
CONF=$("${CLI[@]}" gettransaction "$NEW" 2>/dev/null || "${R[@]}" gettransaction "$NEW")
echo "$CONF" | python3 -c 'import sys,json;c=json.load(sys.stdin)["confirmations"];assert c>=1,c;print("replacement confirmations:",c)'
echo "OK: RBF replacement via PSBT confirmed; original was evicted."
