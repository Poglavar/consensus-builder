#!/usr/bin/env bash
# Deploys the agreement prediction markets (contracts/README-agreement-markets.md) next to an Agreement
# contract already deployed by scripts/deploy-agreement.sh: Gnosis Conditional Tokens and the LMSR market
# maker factory (with its Fixed192x64Math library) from Gnosis's published solc 0.5.10 builds in the
# npm packages of solidity-deps/, then AgreementOutcomeReporter and AgreementMarkets with forge.
# Each one is reused when it is already deployed there: given in the environment (CONDITIONAL_TOKENS,
# LMSR_FACTORY, AGREEMENT_REPORTER, AGREEMENT_MARKETS) or, on localhost, listed in
# frontend/contracts/addresses.json, and still has code and points at the same contracts.
# Usage: scripts/deploy-agreement-markets.sh <localhost|baseSepolia|sepolia>
# Collateral: Circle's USDC on Base Sepolia and Sepolia; on localhost contracts/test/TestUSDC.sol.
# Only localhost addresses are written to frontend/contracts/addresses.json; a public deployment prints
# its addresses, to be recorded deliberately once a frontend reads them.
# The deployer key is DEPLOYER_PRIVATE_KEY in blockchain/.env (localhost uses anvil's first account);
# nothing here prints it. Needs `pnpm install` in solidity-deps/ first.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
case "$NETWORK" in
    localhost)   CHAIN_ID=31337;    DEPLOY_RPC_URL="${HARDHAT_RPC_URL:-http://127.0.0.1:8545}"; COLLATERAL="" ;;
    # Circle's testnet USDC (developers.circle.com/stablecoins/usdc-contract-addresses; name USDC, 6 decimals on chain).
    baseSepolia) CHAIN_ID=84532;    DEPLOY_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"; COLLATERAL=0x036CbD53842c5426634e7929541eC2318f3dCF7e ;;
    sepolia)     CHAIN_ID=11155111; DEPLOY_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; COLLATERAL=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 ;;
    *) echo "usage: $0 <localhost|baseSepolia|sepolia>" >&2; exit 2 ;;
esac
if [ "$NETWORK" = localhost ]; then
    # anvil's and hardhat's first funded account; a public test key, not a secret.
    KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
else
    KEY="${DEPLOYER_PRIVATE_KEY:-}"
    [ -n "$KEY" ] || { echo "DEPLOYER_PRIVATE_KEY is not set in blockchain/.env" >&2; exit 1; }
fi
[ "$(cast chain-id --rpc-url "$DEPLOY_RPC_URL")" = "$CHAIN_ID" ] || { echo "$DEPLOY_RPC_URL is not chain $CHAIN_ID" >&2; exit 1; }
GNOSIS=solidity-deps/node_modules/@gnosis.pm
[ -d "$GNOSIS/conditional-tokens-market-makers/build/contracts" ] || { echo "run pnpm install in blockchain/solidity-deps first" >&2; exit 1; }
ADDRESSES=../frontend/contracts/addresses.json
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
stamp() { date -u +%FT%TZ; }
lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

# The address recorded for this chain under `name`, from the environment variable `var` or, on localhost, addresses.json.
recorded() {
    local var="$1" name="$2" address=""
    if [ -n "${!var:-}" ]; then
        address="${!var}"
    elif [ "$NETWORK" = localhost ]; then
        address=$(node -e 'const a = require(process.argv[1])[process.argv[2]] || {}; process.stdout.write(a[process.argv[3]] || "")' "$(pwd)/$ADDRESSES" "$CHAIN_ID" "$name")
    fi
    [ -z "$address" ] || cast to-check-sum-address "$address"
}
has_code() { [ -n "$1" ] && [ "$(cast code "$1" --rpc-url "$DEPLOY_RPC_URL")" != "0x" ]; }
# `cast call` of a view returning an address, lowercased for comparison.
view_address() { lower "$(cast call "$1" "$2" --rpc-url "$DEPLOY_RPC_URL")"; }

# forge create of one contract; prints the address, shows the forge output on failure.
deploy() {
    local source="$1" address=""
    shift
    if forge create "$source" --rpc-url "$DEPLOY_RPC_URL" --private-key "$KEY" --broadcast --json "$@" >"$LOG" 2>&1; then
        address=$(grep -o '"deployedTo": *"0x[0-9a-fA-F]\{40\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{40\}')
    fi
    if [ -z "$address" ]; then
        echo "[$(stamp)] $source did not deploy on chain $CHAIN_ID:" >&2
        cat "$LOG" >&2
        return 1
    fi
    echo "[$(stamp)] $source deployed to $address on chain $CHAIN_ID" >&2
    printf '%s' "$address"
}

# Deploys the creation bytecode of a published Gnosis truffle artifact, with Fixed192x64Math linked
# when a library address is given; prints the address once the receipt is in.
deploy_artifact() {
    local artifact="$1" library="${2:-}" code address=""
    code=$(node -e '
const [file, lib] = process.argv.slice(1);
let hex = require(file).bytecode;
if (lib) hex = hex.split("__Fixed192x64Math_______________________").join(lib.replace(/^0x/, "").toLowerCase());
if (/__/.test(hex)) throw new Error(file + " still has unlinked libraries");
process.stdout.write(hex);' "$(pwd)/$GNOSIS/$artifact" "$library")
    if cast send --rpc-url "$DEPLOY_RPC_URL" --private-key "$KEY" --json --create "$code" >"$LOG" 2>&1; then
        address=$(grep -o '"contractAddress": *"0x[0-9a-fA-F]\{40\}"' "$LOG" | head -1 | grep -o '0x[0-9a-fA-F]\{40\}')
    fi
    [ -z "$address" ] || address=$(cast to-check-sum-address "$address")
    if [ -z "$address" ] || ! has_code "$address"; then
        echo "[$(stamp)] $artifact did not deploy on chain $CHAIN_ID:" >&2
        cat "$LOG" >&2
        return 1
    fi
    echo "[$(stamp)] $(basename "$artifact" .json) (Gnosis build) deployed to $address on chain $CHAIN_ID" >&2
    printf '%s' "$address"
}

AGREEMENT=$(recorded AGREEMENT Agreement)
[ -n "$AGREEMENT" ] || AGREEMENT=$(node -e 'process.stdout.write((require(process.argv[1])[process.argv[2]] || {}).Agreement || "")' "$(pwd)/$ADDRESSES" "$CHAIN_ID")
has_code "$AGREEMENT" || { echo "no Agreement contract on chain $CHAIN_ID; run scripts/deploy-agreement.sh $NETWORK first" >&2; exit 1; }
echo "[$(stamp)] Agreement $AGREEMENT on chain $CHAIN_ID" >&2

if [ -z "$COLLATERAL" ]; then
    COLLATERAL=$(recorded COLLATERAL MarketCollateral)
    if has_code "$COLLATERAL" && [ "$(cast call "$COLLATERAL" 'decimals()(uint8)' --rpc-url "$DEPLOY_RPC_URL")" = 6 ]; then
        echo "[$(stamp)] reusing TestUSDC $COLLATERAL" >&2
    else
        COLLATERAL=$(deploy contracts/test/TestUSDC.sol:TestUSDC) || exit 1
    fi
fi

CONDITIONAL_TOKENS=$(recorded CONDITIONAL_TOKENS ConditionalTokens)
if has_code "$CONDITIONAL_TOKENS"; then
    echo "[$(stamp)] reusing ConditionalTokens $CONDITIONAL_TOKENS" >&2
else
    CONDITIONAL_TOKENS=$(deploy_artifact conditional-tokens-contracts/build/contracts/ConditionalTokens.json) || exit 1
fi

LMSR_FACTORY=$(recorded LMSR_FACTORY LMSRMarketMakerFactory)
if has_code "$LMSR_FACTORY"; then
    echo "[$(stamp)] reusing LMSRMarketMakerFactory $LMSR_FACTORY" >&2
else
    MATH=$(deploy_artifact conditional-tokens-market-makers/build/contracts/Fixed192x64Math.json) || exit 1
    LMSR_FACTORY=$(deploy_artifact conditional-tokens-market-makers/build/contracts/LMSRMarketMakerFactory.json "$MATH") || exit 1
fi

REPORTER=$(recorded AGREEMENT_REPORTER AgreementOutcomeReporter)
if has_code "$REPORTER" && [ "$(view_address "$REPORTER" 'agreement()(address)')" = "$(lower "$AGREEMENT")" ] \
    && [ "$(view_address "$REPORTER" 'conditionalTokens()(address)')" = "$(lower "$CONDITIONAL_TOKENS")" ]; then
    echo "[$(stamp)] reusing AgreementOutcomeReporter $REPORTER" >&2
else
    REPORTER=$(deploy contracts/AgreementOutcomeReporter.sol:AgreementOutcomeReporter --constructor-args "$AGREEMENT" "$CONDITIONAL_TOKENS") || exit 1
fi

MARKETS=$(recorded AGREEMENT_MARKETS AgreementMarkets)
if has_code "$MARKETS" && [ "$(view_address "$MARKETS" 'reporter()(address)')" = "$(lower "$REPORTER")" ] \
    && [ "$(view_address "$MARKETS" 'factory()(address)')" = "$(lower "$LMSR_FACTORY")" ] \
    && [ "$(view_address "$MARKETS" 'collateral()(address)')" = "$(lower "$COLLATERAL")" ]; then
    echo "[$(stamp)] reusing AgreementMarkets $MARKETS" >&2
else
    MARKETS=$(deploy contracts/AgreementMarkets.sol:AgreementMarkets --constructor-args "$AGREEMENT" "$REPORTER" "$CONDITIONAL_TOKENS" "$LMSR_FACTORY" "$COLLATERAL") || exit 1
fi

SUMMARY=$(node -e '
const [ct, factory, reporter, markets, collateral] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ ConditionalTokens: ct, LMSRMarketMakerFactory: factory, AgreementOutcomeReporter: reporter, AgreementMarkets: markets, MarketCollateral: collateral }));
' "$CONDITIONAL_TOKENS" "$LMSR_FACTORY" "$REPORTER" "$MARKETS" "$COLLATERAL")
if [ "$NETWORK" = localhost ]; then
    # Merge, never overwrite: other chains' and the Solana entries stay as they are.
    node -e '
const fs = require("fs");
const [file, chainId, summary] = process.argv.slice(1);
const addresses = JSON.parse(fs.readFileSync(file, "utf8"));
const add = JSON.parse(summary);
addresses[chainId] = { ...(addresses[chainId] || {}), ...add };
fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
console.error(`[${new Date().toISOString()}] ${file}: chain ${chainId} now lists the agreement market contracts`);
' "$(pwd)/$ADDRESSES" "$CHAIN_ID" "$SUMMARY"
else
    echo "[$(stamp)] chain $CHAIN_ID agreement market contracts (not written to addresses.json):" >&2
fi
echo "$SUMMARY"
