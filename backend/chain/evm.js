// The server's EVM chain access (docs/blockchain-flows.md, R3): the browser's adapter
// (frontend/js/chain/evm-adapter.js) bound to a JSON-RPC provider and, for agents, to the wallet of
// UGT_AGENT_EVM_PRIVATE_KEY. Contract addresses come from frontend/contracts/addresses.json, the RPC
// of each chain from EVM_RPC_URL_<chainId> or the public default below. Used by the MCP chain tools
// and the chain watcher (oracle/chain-records-job.mjs).
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
    const rpcUrl = env[`EVM_RPC_URL_${id}`] || DEFAULT_RPC_URLS[id];
    if (!rpcUrl) throw failure('no-rpc', `Set EVM_RPC_URL_${id} to read ${CHAINS[id].name}.`);
    return { chainId: id, name: CHAINS[id].name, rpcUrl, addresses: { ParcelAnchor: entry.ParcelAnchor, RecordRegistry: entry.RecordRegistry } };
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
    const key = env.UGT_AGENT_EVM_PRIVATE_KEY;
    if (!key) throw failure('no-evm-key', `UGT_AGENT_EVM_PRIVATE_KEY is not set: there is no EVM wallet to sign on ${config.name} with.`);
    const connected = provider || providerFor(config);
    let signer;
    try { signer = new ethers.Wallet(key, connected); } catch (_) {
        throw failure('invalid-evm-key', 'UGT_AGENT_EVM_PRIVATE_KEY is not a valid EVM private key.');
    }
    return EvmAdapter.createAdapter({ ethers, chainId: config.chainId, provider: connected, signer, addresses: config.addresses, log });
}
