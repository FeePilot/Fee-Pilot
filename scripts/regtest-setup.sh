#!/usr/bin/env bash
# Starts a throwaway Bitcoin Core regtest node and funds a wallet.
# Phase 3 will extend this to create a deliberately low-fee, RBF-signalling stuck tx.
set -euo pipefail

DATADIR="${FEEPILOT_REGTEST_DIR:-$(dirname "$0")/../.regtest}"
RPCUSER="${BITCOIN_RPC_USER:-feepilot}"
RPCPASS="${BITCOIN_RPC_PASS:-change-me}"
CLI=(bitcoin-cli -regtest -datadir="$DATADIR" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS")

mkdir -p "$DATADIR"
if ! "${CLI[@]}" getblockchaininfo >/dev/null 2>&1; then
  bitcoind -regtest -daemon -datadir="$DATADIR" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS" \
    -fallbackfee=0.00001 -txindex=1
  until "${CLI[@]}" getblockchaininfo >/dev/null 2>&1; do sleep 0.5; done
fi

"${CLI[@]}" -named createwallet wallet_name=sender >/dev/null 2>&1 || "${CLI[@]}" loadwallet sender >/dev/null 2>&1 || true
ADDR=$("${CLI[@]}" -rpcwallet=sender getnewaddress)
"${CLI[@]}" generatetoaddress 101 "$ADDR" >/dev/null
echo "regtest ready; sender balance: $("${CLI[@]}" -rpcwallet=sender getbalance) BTC"
