#!/usr/bin/env bash
# Creates a deliberately under-paid, RBF-signalling payment on regtest and prints what the
# web UI asks for: the txid, which output is the sender's change, and which pays the receiver.
set -euo pipefail
. "$(dirname "$0")/demo-env.sh"

"$(dirname "$0")/regtest-setup.sh" >/dev/null
"${CLI[@]}" -named createwallet wallet_name=receiver >/dev/null 2>&1 || "${CLI[@]}" loadwallet receiver >/dev/null 2>&1 || true

DEST=$("${R[@]}" getnewaddress)
TXID=$("${S[@]}" -named send outputs="{\"$DEST\":0.01}" fee_rate=1 options='{"replaceable":true}' | jq -r .txid)
RAW=$("${CLI[@]}" getrawtransaction "$TXID" 1)
PAY_VOUT=$(jq -r --arg a "$DEST" '.vout[] | select(.scriptPubKey.address==$a) | .n' <<<"$RAW")
CHANGE_VOUT=$(jq -r --arg a "$DEST" '.vout[] | select(.scriptPubKey.address!=$a) | .n' <<<"$RAW")
RECV_ADDR=$("${R[@]}" getnewaddress)

cat <<OUT
stuck txid:        $TXID
receiver pays out: vout $PAY_VOUT ($DEST)
sender change:     vout $CHANGE_VOUT
a receiver address to send a CPFP child to: $RECV_ADDR
OUT
echo "TXID=$TXID CHANGE_VOUT=$CHANGE_VOUT PAY_VOUT=$PAY_VOUT RECV_ADDR=$RECV_ADDR" > "$DEMO_ROOT/.regtest/demo.env"
