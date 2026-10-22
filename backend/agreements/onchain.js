// The chain side of the agreement index (plan-design-agreement.md, M3): the clusters this server reads
// agreements on, the account an agreement's sponsor and CID derive (PDA ["agreement", sponsor,
// sha256(cid)], programs/agreement/README.md), reading and decoding those accounts over RPC with the
// shared codec (frontend/js/solana/agreement-client.js), and the `onchain` JSON consensus.agreement
// keeps. POST /agreements/:cid/onchain writes it once (routes/agreements.js); the lifecycle oracle
// refreshes the fields the chain moves and discovers accounts nobody reported (oracle/agreement-lifecycle.js).

import { createRequire } from 'node:module';
import { createRpcConnection } from '../solana/rpc.js';
import { accountsPerRequest } from '../solana/account-batching.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// web3 is injected (as markets/contests.js does): the codec's own require would resolve from frontend/.
export const AgreementClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3 });

export const AGREEMENT_PROGRAM_ID = AgreementClient.constants.AGREEMENT_PROGRAM_ID;
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// The clusters the index reads agreements on, by the name `onchain.cluster` records: devnet only, over
// SOLANA_RPC_URL like every other server-side chain read. A reader checks the RPC's genesis hash once.
export const AGREEMENT_CLUSTERS = Object.freeze({
    devnet: Object.freeze({
        genesisHash: DEVNET_GENESIS_HASH,
        rpcUrl: env => env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'
    })
});

// The program's status codes as the index spells them (lower case, by code).
export const ONCHAIN_STATUSES = Object.freeze(['active', 'executed', 'cancelled', 'expired']);
export const TERMINAL_STATUSES = Object.freeze(['executed', 'cancelled', 'expired']);
// The lens issues `satisfied` only; an unmet agreement expires (lens-schemas.js LENS_DECISIONS).
const DECISION_SATISFIED = AgreementClient.constants.DECISION_SATISFIED;
if (!Number.isInteger(DECISION_SATISFIED)) throw new Error('agreement-client.js has no DECISION_SATISFIED code');
// What the chain can still change after `onchain` is first written, plus the observation itself.
// Everything else (cluster, program, account, sponsor, lens, deadline, required escrow) is fixed at create,
// and `endedAt`, when a terminal account ended in the chain's time, is the lifecycle oracle's to write
// (oracle/agreement-lifecycle.js): a refresh keeps it as stored.
export const MOVING_FIELDS = Object.freeze(['status', 'decision', 'escrowLamports', 'executedAt', 'observedAt', 'observedSlot']);

const iso = seconds => new Date(seconds * 1000).toISOString();
// A transaction signature: 64 bytes in base58.
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export const isSignature = value => typeof value === 'string' && SIGNATURE_PATTERN.test(value);

/** Whether `value` is a canonical base58 public key (a sponsor, lens or account). */
export function isPublicKey(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        return new web3.PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

/**
 * A decoded account's decision as the index spells it: 'satisfied' once the program recorded the lens's
 * satisfied decision, else 'pending'.
 */
export function decisionOf(account) {
    return account.decisionCode === DECISION_SATISFIED ? 'satisfied' : 'pending';
}

/** The account an agreement's sponsor and CID derive, or null when the sponsor is not a public key. */
export function agreementAccountOf(cid, sponsor, programId = AGREEMENT_PROGRAM_ID) {
    if (!isPublicKey(sponsor)) return null;
    return AgreementClient.getAgreementPda(cid, sponsor, programId)[0].toBase58();
}

/**
 * The index's `onchain` for a decoded account (AgreementClient.readAgreement), observed at `observedAt`
 * (this server's clock when it read the account: the observation time, never an event time) and
 * `observedSlot` (the RPC's context slot of that read). Lamports are decimal strings (u64);
 * deadline and executedAt are the account's own chain times.
 */
export function onchainFromAccount(account, { cluster, programId = AGREEMENT_PROGRAM_ID, observedAt, observedSlot, signature = null }) {
    const status = ONCHAIN_STATUSES[account.statusCode];
    if (!status) throw new Error(`agreement ${account.address} has status ${account.statusCode}: an unknown code`);
    return {
        chain: 'solana',
        cluster,
        programId,
        account: account.address,
        sponsor: account.authority,
        lens: account.lens,
        status,
        decision: decisionOf(account),
        deadline: account.deadline ? iso(account.deadline) : null,
        requiredLamports: String(account.requiredLamports),
        escrowLamports: String(account.escrowLamports),
        executedAt: account.executedAt ? iso(account.executedAt) : null,
        observedAt,
        observedSlot,
        ...(signature ? { signature } : {})
    };
}

/** The stored `onchain` with only the fields the chain moves taken from a fresh observation. */
export function refreshOnchain(stored, fresh) {
    const next = { ...stored };
    for (const field of MOVING_FIELDS) next[field] = fresh[field];
    return next;
}

/** Whether a fresh observation moves anything but the observation itself. */
export function onchainMoved(stored, fresh) {
    return ['status', 'decision', 'escrowLamports', 'executedAt'].some(field => stored?.[field] !== fresh[field]);
}

/**
 * Writes `onchain` for one agreement unless the index already holds a later observation (a higher
 * observedSlot), so the route and the oracle can never move an agreement back. Returns whether it wrote.
 */
export async function writeOnchain(db, cid, onchain) {
    const { rowCount } = await db.query(`
        UPDATE consensus.agreement
        SET onchain = $2::jsonb, updated_at = now()
        WHERE cid = $1
          AND (onchain IS NULL OR COALESCE((onchain->>'observedSlot')::bigint, 0) <= $3::bigint)`,
    [cid, JSON.stringify(onchain), onchain.observedSlot]);
    return rowCount === 1;
}

/**
 * Agreement accounts on one cluster. The connection defaults to the cluster's RPC (createRpcConnection,
 * retrying); the first call checks that it really is that cluster (genesis hash) and fails with code
 * 'rpc-wrong-cluster' otherwise.
 */
export function createAgreementChain({ cluster = 'devnet', env = process.env, connection = null, programId = AGREEMENT_PROGRAM_ID } = {}) {
    const config = AGREEMENT_CLUSTERS[cluster];
    if (!config) throw new Error(`unsupported cluster ${cluster}`);
    let conn = connection;
    let networkCheck = null;

    async function ready() {
        conn ??= createRpcConnection(config.rpcUrl(env), 'confirmed');
        networkCheck ??= conn.getGenesisHash().then(hash => {
            if (hash !== config.genesisHash) {
                throw Object.assign(new Error(`the RPC for ${cluster} answers genesis ${hash}, not ${config.genesisHash}`), { code: 'rpc-wrong-cluster' });
            }
        }).catch(error => {
            networkCheck = null;
            throw error;
        });
        await networkCheck;
        return conn;
    }

    // One row per address: { address, slot, account (decoded) | null, data (Buffer) | null,
    // problem: null | 'missing' | 'wrong-program' | 'not-agreement' | 'undecodable' }.
    async function readAccounts(addresses, { batchSize = accountsPerRequest(env) } = {}) {
        const connection = await ready();
        const rows = [];
        for (let index = 0; index < addresses.length; index += batchSize) {
            const batch = addresses.slice(index, index + batchSize);
            const { context, value } = await connection.getMultipleAccountsInfoAndContext(batch.map(address => new web3.PublicKey(address)), 'confirmed');
            if (!Array.isArray(value) || value.length !== batch.length) {
                throw new Error(`getMultipleAccountsInfo returned ${Array.isArray(value) ? value.length : 'no'} results for ${batch.length} accounts`);
            }
            batch.forEach((address, position) => {
                const info = value[position];
                const row = { address, slot: context.slot, account: null, data: null, problem: null };
                if (!info) row.problem = 'missing';
                else if (info.owner?.toBase58?.() !== programId) row.problem = 'wrong-program';
                else {
                    row.data = Buffer.from(info.data);
                    try {
                        row.account = AgreementClient.readAgreement(new Uint8Array(row.data), address);
                        if (!row.account) row.problem = 'not-agreement';
                    } catch {
                        row.problem = 'undecodable';
                    }
                }
                rows.push(row);
            });
        }
        return rows;
    }

    return {
        cluster,
        programId,
        connection: ready,
        readAccounts,
        async readAccount(address) {
            return (await readAccounts([address], { batchSize: 1 }))[0];
        },
        // Whether a reported transaction succeeded and names the account: 'ok', 'not-found' (unknown to
        // the RPC, perhaps not yet), 'failed' or 'unrelated'.
        async transactionTouches(signature, address) {
            const connection = await ready();
            const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
            if (!tx) return 'not-found';
            if (tx.meta?.err) return 'failed';
            const loaded = tx.meta?.loadedAddresses || {};
            const keys = [...(tx.transaction?.message?.staticAccountKeys || []), ...(loaded.writable || []), ...(loaded.readonly || [])];
            return keys.some(key => (typeof key === 'string' ? key : key.toBase58()) === address) ? 'ok' : 'unrelated';
        }
    };
}
