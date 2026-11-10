#!/usr/bin/env bash
# Deploys ParcelAnchor and RecordRegistry (docs/blockchain-flows.md, R3) to one EVM network with
# forge, and records the addresses in frontend/contracts/addresses.json under that chain id.
# Usage: scripts/deploy-anchors-registry.sh <localhost|baseSepolia|sepolia> [--verify]
# The deployer key is DEPLOYER_PRIVATE_KEY in blockchain/.env (localhost uses anvil's first account);
# nothing here prints it. --verify submits the sources to the chain's Etherscan-family explorer with
# BASESCAN_API_KEY or ETHERSCAN_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
VERIFY="${2:-}"
# .env first: it holds the deployer key, and its own RPC_URL must not be mistaken for the target.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
case "$NETWORK" in
    localhost)   CHAIN_ID=31337;    DEPLOY_RPC_URL="${HARDHAT_RPC_URL:-http://127.0.0.1:8545}" ;;
    baseSepolia) CHAIN_ID=84532;    DEPLOY_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}" ;;
    sepolia)     CHAIN_ID=11155111; DEPLOY_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" ;;
    *) echo "usage: $0 <localhost|baseSepolia|sepolia> [--verify]" >&2; exit 2 ;;
esac
if [ "$NETWORK" = localhost ]; then
    # anvil's and hardhat's first funded account; a public test key, not a secret.
    KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
else
    KEY="${DEPLOYER_PRIVATE_KEY:-}"
    [ -n "$KEY" ] || { echo "DEPLOYER_PRIVATE_KEY is not set in blockchain/.env" >&2; exit 1; }
fi
VERIFY_ARGS=()
if [ "$VERIFY" = "--verify" ]; then
    API_KEY="${BASESCAN_API_KEY:-${ETHERSCAN_API_KEY:-}}"
    [ -n "$API_KEY" ] || { echo "--verify needs BASESCAN_API_KEY or ETHERSCAN_API_KEY" >&2; exit 1; }
    VERIFY_ARGS=(--verify --etherscan-api-key "$API_KEY")
fi

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

# Deploys one contract and prints its address; the forge output goes to $LOG and is shown on failure.
deploy() {
    local name="$1" address=""
    if forge create "contracts/$name.sol:$name" --rpc-url "$DEPLOY_RPC_URL" --private-key "$KEY" --broadcast --json ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} >"$LOG" 2>&1; then
        address=$(grep -o '"deployedTo": *"0x[0-9a-fA-F]\{40\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{40\}')
        # Wait until it is mined: the next deploy reuses the nonce otherwise ("replacement transaction underpriced").
        local tx
        tx=$(grep -o '"transactionHash": *"0x[0-9a-fA-F]\{64\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{64\}')
        [ -z "$tx" ] || cast receipt "$tx" --rpc-url "$DEPLOY_RPC_URL" --confirmations 1 >/dev/null 2>&1 || true
    fi
    if [ -z "$address" ]; then
        echo "[$(date -u +%FT%TZ)] $name did not deploy on chain $CHAIN_ID:" >&2
        cat "$LOG" >&2
        return 1
    fi
    echo "[$(date -u +%FT%TZ)] $name deployed to $address on chain $CHAIN_ID" >&2
    printf '%s' "$address"
}

ANCHOR=$(deploy ParcelAnchor) || exit 1
REGISTRY=$(deploy RecordRegistry) || exit 1

# Merge, never overwrite: other chains' and the Solana entries stay as they are.
node -e '
const fs = require("fs");
const [file, chainId, anchor, registry] = process.argv.slice(1);
const addresses = JSON.parse(fs.readFileSync(file, "utf8"));
addresses[chainId] = { ...(addresses[chainId] || {}), ParcelAnchor: anchor, RecordRegistry: registry };
fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
console.error(`[${new Date().toISOString()}] ${file}: chain ${chainId} now lists ParcelAnchor ${anchor}, RecordRegistry ${registry}`);
' ../frontend/contracts/addresses.json "$CHAIN_ID" "$ANCHOR" "$REGISTRY"
