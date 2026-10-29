#!/usr/bin/env bash
# Mines N regtest blocks (default 1): "a miner picks up the transaction".
set -euo pipefail
. "$(dirname "$0")/demo-env.sh"
"${CLI[@]}" generatetoaddress "${1:-1}" "$("${S[@]}" getnewaddress)" >/dev/null
echo "mined ${1:-1} block(s); height $("${CLI[@]}" getblockcount)"
