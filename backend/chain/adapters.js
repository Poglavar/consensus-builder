// The server's chain adapters by chain key (docs/blockchain-flows.md, R2/R3): a decimal EVM chain id
// ('84532') binds frontend/js/chain/evm-adapter.js (chain/evm.js); a Solana key ('solana-devnet')
// binds frontend/js/chain/solana-adapter.js to SOLANA_RPC_URL and, for agents, to the keypair file
// UGT_AGENT_KEYPAIR, confirming by polling (agents/solana-send.js). The chain watcher and the MCP
// record tools take any of them through readAdapter / signingAdapter.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Keypair, Transaction } from '@solana/web3.js';
import * as web3 from '@solana/web3.js';
import { CHAINS as EVM_CHAINS, normalizeChainId, readAdapter as evmReadAdapter, signingAdapter as evmSigningAdapter } from './evm.js';
import { createRpcConnection } from '../solana/rpc.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';

const require = createRequire(import.meta.url);
require('../../frontend/js/solana/ugt-client.js').configure({ web3 });
const SolanaAdapter = require('../../frontend/js/chain/solana-adapter.js');

export const SOLANA_CHAIN_KEYS = Object.freeze(Object.keys(SolanaAdapter.CLUSTERS).map(SolanaAdapter.chainKeyOf));
const DEFAULT_SOLANA_RPC = 'https://api.devnet.solana.com';
const failure = (code, message) => Object.assign(new Error(message), { code });
const stderrLog = line => process.stderr.write(`${line}\n`);

/** A chain key as the adapters spell it ('84532', 'solana-devnet'), or null for an unknown chain. */
export function normalizeChainKey(value) {
    const text = String(value ?? '').trim();
    if (SOLANA_CHAIN_KEYS.includes(text)) return text;
    if (text === 'devnet' || text === 'solana') return 'solana-devnet';
    const id = normalizeChainId(text);
    return id && EVM_CHAINS[id] ? id : null;
}

export const isSolanaKey = key => SOLANA_CHAIN_KEYS.includes(key);
export const knownChainKeys = () => [...Object.keys(EVM_CHAINS), ...SOLANA_CHAIN_KEYS];

function chainKeyOrThrow(value) {
    const key = normalizeChainKey(value);
    if (!key) throw failure('unknown-chain', `Not a supported chain: ${value} (supported: ${knownChainKeys().join(', ')}).`);
    return key;
}

function solanaConnection(env, connection) {
    return connection || createRpcConnection(env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, 'confirmed');
}

/** The agent's Solana keypair from the file UGT_AGENT_KEYPAIR names; the key never appears in a message. */
export function agentKeypair(env = process.env) {
    const file = env.UGT_AGENT_KEYPAIR;
    if (!file) throw failure('no-solana-key', 'UGT_AGENT_KEYPAIR is not set: there is no Solana keypair to sign with.');
    const resolved = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
    let secret;
    try { secret = Uint8Array.from(JSON.parse(readFileSync(resolved, 'utf8'))); } catch (_) {
        throw failure('invalid-solana-key', 'UGT_AGENT_KEYPAIR does not name a readable Solana keypair file.');
    }
    if (secret.length !== 64) throw failure('invalid-solana-key', 'UGT_AGENT_KEYPAIR is not a 64-byte Solana keypair.');
    return Keypair.fromSecretKey(secret);
}

/** A read-only adapter for `chainKey`. `connection` / `provider` and `addressBook` are injectable for tests. */
export function readAdapter(chainKey, { env = process.env, log = stderrLog, connection = null, provider = null, addressBook } = {}) {
    const key = chainKeyOrThrow(chainKey);
    if (!isSolanaKey(key)) return evmReadAdapter(key, { env, log, provider, ...(addressBook ? { addressBook } : {}) });
    return SolanaAdapter.createAdapter({ connection: solanaConnection(env, connection), cluster: SolanaAdapter.clusterOf(key), log });
}

/**
 * The adapter signing as the agent on `chainKey`: UGT_AGENT_EVM_PRIVATE_KEY on an EVM chain, the
 * UGT_AGENT_KEYPAIR keypair on Solana (sent and confirmed by polling). `keypair` and `send` are
 * injectable for tests.
 */
export function signingAdapter(chainKey, { env = process.env, log = stderrLog, connection = null, provider = null, addressBook, keypair = null, send = null } = {}) {
    const key = chainKeyOrThrow(chainKey);
    if (!isSolanaKey(key)) return evmSigningAdapter(key, { env, log, provider, ...(addressBook ? { addressBook } : {}) });
    const conn = solanaConnection(env, connection);
    const signer = keypair || agentKeypair(env);
    const sendInstructions = send || (instructions => sendAndConfirmPolling(conn, new Transaction().add(...instructions), [signer]));
    return SolanaAdapter.createAdapter({ connection: conn, cluster: SolanaAdapter.clusterOf(key), wallet: signer.publicKey.toBase58(), send: sendInstructions, log });
}
