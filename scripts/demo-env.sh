# Shared by the demo scripts. Source it; it sets CLI/S/R and the service settings.
DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATADIR="${FEEPILOT_REGTEST_DIR:-$DEMO_ROOT/.regtest}"
RPCUSER="${BITCOIN_RPC_USER:-feepilot}"
RPCPASS="${BITCOIN_RPC_PASS:-change-me}"
CLI=(bitcoin-cli -regtest -datadir="$DATADIR" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS")
S=("${CLI[@]}" -rpcwallet=sender)
R=("${CLI[@]}" -rpcwallet=receiver)

export BITCOIN_RPC_URL="${BITCOIN_RPC_URL:-http://127.0.0.1:18443}"
export BITCOIN_RPC_USER="$RPCUSER" BITCOIN_RPC_PASS="$RPCPASS"
export DATABASE_URL="${DATABASE_URL:-postgres://feepilot:feepilot@localhost:5432/feepilot}"
export FEEPILOT_NETWORK=regtest FEEPILOT_FALLBACK_FEE_RATE="${FEEPILOT_FALLBACK_FEE_RATE:-20}"
export FEEPILOT_BIND="${FEEPILOT_BIND:-127.0.0.1:8080}"
# Serve the React app if it has been built (`cd frontend && pnpm build`), else the original UI.
if [ -z "${FEEPILOT_WEB_DIR:-}" ]; then
  if [ -f "$DEMO_ROOT/frontend/dist/app-shell.html" ]; then
    FEEPILOT_WEB_DIR="$DEMO_ROOT/frontend/dist"
  else
    FEEPILOT_WEB_DIR="$DEMO_ROOT/web"
  fi
fi
export FEEPILOT_WEB_DIR
API="http://$FEEPILOT_BIND"
