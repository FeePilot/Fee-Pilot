#!/usr/bin/env bash
# Stand-in for "sign it in your own wallet": signs a PSBT with whichever demo wallet
# (sender, then receiver) can fully sign it, and prints the signed PSBT. Regtest only.
# Usage: scripts/demo-sign.sh <unsigned psbt>
set -euo pipefail
. "$(dirname "$0")/demo-env.sh"
PSBT="${1:?usage: demo-sign.sh <psbt>}"
for W in sender receiver; do
  OUT=$("${CLI[@]}" -rpcwallet=$W walletprocesspsbt "$PSBT" 2>/dev/null) || continue
  if [ "$(jq -r .complete <<<"$OUT")" = "true" ]; then jq -r .psbt <<<"$OUT"; exit 0; fi
done
echo "no demo wallet could fully sign this PSBT" >&2
exit 1
