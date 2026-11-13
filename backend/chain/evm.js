// The server's EVM chain access (docs/blockchain-flows.md, R3): the browser's adapter
// (frontend/js/chain/evm-adapter.js) bound to a JSON-RPC provider and, for agents, to the wallet of
// UGT_AGENT_EVM_PRIVATE_KEY. Contract addresses come from frontend/contracts/addresses.json, the RPC
// of each chain from EVM_RPC_URL_<chainId> or the public default below. Used by the MCP chain tools
// and the chain watcher (oracle/chain-records-job.mjs); the Agreement reader (R4) by the agreement
// index and its lifecycle oracle (agreements/onchain-evm.js) and the lens's EAS issuer (lens/evm-issuer.js),
// the agent's Agreement signer by the MCP agreement mint (agents/evm-agreement-minter.js).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const EvmAdapter = require('../../frontend/js/chain/evm-adapter.js');

export const { CHAINS, DEFAULT_CHAIN_ID, normalizeChainId, tokenUriOf, tokenMetadataOf } = EvmAdapter;
// Keyless public RPCs, used when EVM_RPC_URL_<chainId> is not set.
export const DEFAULT_RPC_URLS = Object.freeze({
    '84532': 'https://sepolia.base.org',
    '11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
    '31337': 'http://127.0.0.1:8545'
});
const ADDRESSES_URL = new URL('../../frontend/contracts/addresses.json', import.meta.url);

const failure = (code, message) => Object.assign(new Error(message), { code });
// stdout is the MCP transport in the stdio server, so the default log line goes to stderr.
const stderrLog = line => process.stderr.write(`${line}\n`);

let addressBookCache = null;
export function loadAddressBook() {
    addressBookCache ??= JSON.parse(readFileSync(ADDRESSES_URL, 'utf8'));
    return addressBookCache;
}

/**
 * One chain's settings: { chainId, name, rpcUrl, addresses: { ParcelAnchor, RecordRegistry } }.
 * Throws 'unknown-chain' for a chain the adapter does not know, 'no-contracts' when addresses.json has
 * no record registry or parcel anchor on it, 'no-rpc' without an RPC URL.
 */
export function chainConfig(chainId = DEFAULT_CHAIN_ID, env = process.env, { addressBook = loadAddressBook() } = {}) {
    const id = normalizeChainId(chainId);
    if (!id || !CHAINS[id]) throw failure('unknown-chain', `Not a supported EVM chain: ${chainId} (supported: ${Object.keys(CHAINS).join(', ')}).`);
    const entry = addressBook[id] || {};
    if (!entry.RecordRegistry || !entry.ParcelAnchor) {
        throw failure('no-contracts', `${CHAINS[id].name} (${id}) has no RecordRegistry or ParcelAnchor in frontend/contracts/addresses.json.`);
    }
    return { chainId: id, name: CHAINS[id].name, rpcUrl: rpcUrlOf(id, env), addresses: { ParcelAnchor: entry.ParcelAnchor, RecordRegistry: entry.RecordRegistry } };
}

// EVM_RPC_URL_<chainId>, else the public default; 'no-rpc' without either.
function rpcUrlOf(id, env) {
    const rpcUrl = env[`EVM_RPC_URL_${id}`] || DEFAULT_RPC_URLS[id];
    if (!rpcUrl) throw failure('no-rpc', `Set EVM_RPC_URL_${id} to read ${CHAINS[id].name}.`);
    return rpcUrl;
}

/**
 * The agreement contracts of one chain (docs/blockchain-flows.md, R4): { chainId, name, Agreement, EAS,
 * AgreementDecisionSchema } from addresses.json. Throws 'unknown-chain' for a chain the adapter does not
 * know and 'no-agreement' when addresses.json has no Agreement, EAS or decision schema on it.
 */
export function agreementAddresses(chainId, { addressBook = loadAddressBook() } = {}) {
    const id = normalizeChainId(chainId);
    if (!id || !CHAINS[id]) throw failure('unknown-chain', `Not a supported EVM chain: ${chainId} (supported: ${Object.keys(CHAINS).join(', ')}).`);
    const entry = addressBook[id] || {};
    if (!entry.Agreement || !entry.EAS || !entry.AgreementDecisionSchema) {
        throw failure('no-agreement', `${CHAINS[id].name} (${id}) has no Agreement, EAS or AgreementDecisionSchema in frontend/contracts/addresses.json.`);
    }
    return { chainId: id, name: CHAINS[id].name, Agreement: entry.Agreement, EAS: entry.EAS, AgreementDecisionSchema: entry.AgreementDecisionSchema };
}

/** agreementAddresses with the chain's RPC: { chainId, name, rpcUrl, addresses: { Agreement, EAS, AgreementDecisionSchema } }. */
export function agreementConfig(chainId, env = process.env, { addressBook } = {}) {
    const { chainId: id, name, ...addresses } = agreementAddresses(chainId, addressBook ? { addressBook } : {});
    return { chainId: id, name, rpcUrl: rpcUrlOf(id, env), addresses };
}

// Agreement.sol's reads: its Record field for field, keyOf, and the enumeration.
const AGREEMENT_RECORD_TUPLE = '(address sponsor, address lens, address payout, uint64 deadline, uint64 createdAt, uint256 requiredWei, '
    + 'uint256 escrowWei, uint8 status, bool openGround, uint8 decision, uint64 decisionAttestedAt, uint64 decisionObservedAt, '
    + 'bytes32 decisionAttestation, bytes32 decisionHash, uint64 executedAt, string cid)';
export const AGREEMENT_READ_ABI = Object.freeze([
    `function get(bytes32 key) view returns (${AGREEMENT_RECORD_TUPLE})`,
    'function exists(bytes32 key) view returns (bool)',
    'function keyOf(address sponsor, string cid) pure returns (bytes32)',
    'function count() view returns (uint256)',
    `function agreements(uint256 offset, uint256 limit) view returns (bytes32[] keys, ${AGREEMENT_RECORD_TUPLE}[] records)`
]);

/** A JSON-RPC provider for `chainId` (EVM_RPC_URL_<chainId> or the public default), pinned to that chain. */
export function evmProvider(chainId = DEFAULT_CHAIN_ID, { env = process.env } = {}) {
    const id = normalizeChainId(chainId);
    if (!id || !CHAINS[id]) throw failure('unknown-chain', `Not a supported EVM chain: ${chainId} (supported: ${Object.keys(CHAINS).join(', ')}).`);
    return providerFor({ chainId: id, rpcUrl: rpcUrlOf(id, env) });
}

/**
 * An ethers Contract over the chain's Agreement (AGREEMENT_READ_ABI: get, exists, keyOf, count,
 * agreements), read-only. `provider` and `addressBook` are injectable for tests.
 */
export function agreementReader(chainId = DEFAULT_CHAIN_ID, { env = process.env, provider = null, addressBook } = {}) {
    const config = agreementConfig(chainId, env, addressBook ? { addressBook } : {});
    return new ethers.Contract(config.addresses.Agreement, AGREEMENT_READ_ABI, provider || providerFor(config));
}

// A provider pinned to the chain id: no network detection, so an unreachable RPC fails the call
// instead of retrying detection forever.
function providerFor(config) {
    const network = ethers.Network.from(Number(config.chainId));
    return new ethers.JsonRpcProvider(config.rpcUrl, network, { staticNetwork: network });
}

/** A read-only adapter for `chainId`. `provider` and `addressBook` are injectable for tests. */
export function readAdapter(chainId = DEFAULT_CHAIN_ID, { env = process.env, log = stderrLog, provider = null, addressBook } = {}) {
    const config = chainConfig(chainId, env, addressBook ? { addressBook } : {});
    return EvmAdapter.createAdapter({ ethers, chainId: config.chainId, provider: provider || providerFor(config), addresses: config.addresses, log });
}

/**
 * The adapter signing with the agent's EVM key (UGT_AGENT_EVM_PRIVATE_KEY). Throws 'no-evm-key'
 * without it and 'invalid-evm-key' when it is not a private key; the key never appears in a message.
 */
export function signingAdapter(chainId = DEFAULT_CHAIN_ID, { env = process.env, log = stderrLog, provider = null, addressBook } = {}) {
    const config = chainConfig(chainId, env, addressBook ? { addressBook } : {});
    const connected = provider || providerFor(config);
    const signer = agentWallet(env, connected, config.name);
    return EvmAdapter.createAdapter({ ethers, chainId: config.chainId, provider: connected, signer, addresses: config.addresses, log });
}

// The agent's wallet (UGT_AGENT_EVM_PRIVATE_KEY) on `provider`; the key never appears in a message.
function agentWallet(env, provider, chainName) {
    const key = env.UGT_AGENT_EVM_PRIVATE_KEY;
    if (!key) throw failure('no-evm-key', `UGT_AGENT_EVM_PRIVATE_KEY is not set: there is no EVM wallet to sign on ${chainName} with.`);
    try { return new ethers.Wallet(key, provider); } catch (_) {
        throw failure('invalid-evm-key', 'UGT_AGENT_EVM_PRIVATE_KEY is not a valid EVM private key.');
    }
}

/**
 * The chain's Agreement contract signed by the agent's wallet (UGT_AGENT_EVM_PRIVATE_KEY), over the
 * browser's ABI (frontend/js/chain/evm-agreement.js AGREEMENT_ABI): { chainId, name, address (the
 * contract), wallet (the agent's checksummed address), contract }. Throws 'unknown-chain' /
 * 'no-agreement' / 'no-rpc' / 'no-evm-key' / 'invalid-evm-key'. `provider` and `addressBook` are injectable.
 */
export function agreementSigner(chainId, { env = process.env, provider = null, addressBook } = {}) {
    const config = agreementConfig(chainId, env, addressBook ? { addressBook } : {});
    const wallet = agentWallet(env, provider || providerFor(config), config.name);
    const { AGREEMENT_ABI } = require('../../frontend/js/chain/evm-agreement.js');
    return { chainId: config.chainId, name: config.name, address: config.addresses.Agreement, wallet: wallet.address,
        contract: new ethers.Contract(config.addresses.Agreement, AGREEMENT_ABI, wallet) };
}
