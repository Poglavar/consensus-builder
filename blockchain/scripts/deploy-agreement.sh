#!/usr/bin/env bash
# Deploys the Agreement contract (docs/blockchain-flows.md, R4) to one EVM network with forge: registers
# the AgreementDecision-v1 schema in the chain's EAS SchemaRegistry when it is not there yet (its uid is
# keccak256(schema, resolver, revocable), so the step is idempotent), deploys Agreement(eas, schemaUid),
# and records Agreement, EAS and the schema uid in frontend/contracts/addresses.json under the chain id.
# Usage: scripts/deploy-agreement.sh <localhost|baseSepolia|sepolia>
# localhost has no EAS: contracts/test/MockEAS.sol is deployed in its place and the schema uid is computed.
# The deployer key is DEPLOYER_PRIVATE_KEY in blockchain/.env (localhost uses anvil's first account);
# nothing here prints it.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
# .env first: it holds the deployer key, and its own RPC_URL must not be mistaken for the target.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
case "$NETWORK" in
    localhost)   CHAIN_ID=31337;    DEPLOY_RPC_URL="${HARDHAT_RPC_URL:-http://127.0.0.1:8545}"; EAS=""; REGISTRY="" ;;
    baseSepolia) CHAIN_ID=84532;    DEPLOY_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"; EAS=0x4200000000000000000000000000000000000021; REGISTRY=0x4200000000000000000000000000000000000020 ;;
    sepolia)     CHAIN_ID=11155111; DEPLOY_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; EAS=0xC2679fBD37d54388Ce493F1DB75320D236e1815e; REGISTRY=0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0 ;;
    *) echo "usage: $0 <localhost|baseSepolia|sepolia>" >&2; exit 2 ;;
esac
if [ "$NETWORK" = localhost ]; then
    # anvil's and hardhat's first funded account; a public test key, not a secret.
    KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
else
    KEY="${DEPLOYER_PRIVATE_KEY:-}"
    [ -n "$KEY" ] || { echo "DEPLOYER_PRIVATE_KEY is not set in blockchain/.env" >&2; exit 1; }
fi
# The schema the lens attests with (backend/oracle/lens-schemas.js, decision); the same text everywhere.
SCHEMA='string agreementCid, address sponsor, string decision, string evidenceRef, uint64 sourceObservedAt'
RESOLVER=0x0000000000000000000000000000000000000000
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
stamp() { date -u +%FT%TZ; }

# forge create of one contract; prints the address, shows the forge output on failure, waits for the receipt.
deploy() {
    local source="$1" address=""
    shift
    if forge create "$source" --rpc-url "$DEPLOY_RPC_URL" --private-key "$KEY" --broadcast --json "$@" >"$LOG" 2>&1; then
        address=$(grep -o '"deployedTo": *"0x[0-9a-fA-F]\{40\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{40\}')
        local tx
        tx=$(grep -o '"transactionHash": *"0x[0-9a-fA-F]\{64\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{64\}')
        [ -z "$tx" ] || cast receipt "$tx" --rpc-url "$DEPLOY_RPC_URL" --confirmations 1 >/dev/null 2>&1 || true
    fi
    if [ -z "$address" ]; then
        echo "[$(stamp)] $source did not deploy on chain $CHAIN_ID:" >&2
        cat "$LOG" >&2
        return 1
    fi
    echo "[$(stamp)] $source deployed to $address on chain $CHAIN_ID" >&2
    printf '%s' "$address"
}

SCHEMA_UID=$(cast keccak "$(cast abi-encode --packed 'f(string,address,bool)' "$SCHEMA" $RESOLVER true)")
if [ -z "$EAS" ]; then
    EAS=$(deploy contracts/test/MockEAS.sol:MockEAS) || exit 1
    echo "[$(stamp)] no EAS on chain $CHAIN_ID: MockEAS stands in; schema uid $SCHEMA_UID is not registered anywhere" >&2
else
    REGISTERED=$(cast call "$REGISTRY" 'getSchema(bytes32)((bytes32,address,bool,string))' "$SCHEMA_UID" --rpc-url "$DEPLOY_RPC_URL" | head -c 80)
    if printf '%s' "$REGISTERED" | grep -q '0x0000000000000000000000000000000000000000000000000000000000000000'; then
        echo "[$(stamp)] registering the AgreementDecision-v1 schema in $REGISTRY" >&2
        cast send "$REGISTRY" 'register(string,address,bool)(bytes32)' "$SCHEMA" $RESOLVER true --rpc-url "$DEPLOY_RPC_URL" --private-key "$KEY" >"$LOG" 2>&1 || { cat "$LOG" >&2; exit 1; }
    fi
    echo "[$(stamp)] AgreementDecision-v1 schema uid $SCHEMA_UID on chain $CHAIN_ID" >&2
fi

AGREEMENT=$(deploy contracts/Agreement.sol:Agreement --constructor-args "$EAS" "$SCHEMA_UID") || exit 1

# Merge, never overwrite: other chains' and the Solana entries stay as they are.
node -e '
const fs = require("fs");
const [file, chainId, agreement, eas, schemaUid] = process.argv.slice(1);
const addresses = JSON.parse(fs.readFileSync(file, "utf8"));
addresses[chainId] = { ...(addresses[chainId] || {}), Agreement: agreement, EAS: eas, AgreementDecisionSchema: schemaUid };
fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
console.error(`[${new Date().toISOString()}] ${file}: chain ${chainId} now lists Agreement ${agreement}, EAS ${eas}, schema ${schemaUid}`);
' ../frontend/contracts/addresses.json "$CHAIN_ID" "$AGREEMENT" "$EAS" "$SCHEMA_UID"
