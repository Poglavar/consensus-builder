// The agreement lifecycle oracle (plan-design-agreement.md M3, "Execution is one event"). One pass reads
// the chain account of every agreement the index records as minted (`consensus.agreement.onchain`),
// refreshes what the chain moves (status, decision, escrow, executedAt and the observation, never the
// fields fixed at create), records when a terminal account ended (`onchain.endedAt`, the chain's time:
// executed_at, or the program's cancel/expire event time) and writes the land events of each terminal
// account: one `agreement_lifecycle`
// event for the agreement (executed, cancelled or expired: what agreement markets resolve on,
// oracle/market-recipe.js) and, when it executed, one `agreement_executed` event per input parcel, that
// parcel's history entry pointing at the agreement (CID, account, lens, decision attestation). Every
// event time is the chain's own (executed_at from the account; cancelled_at or expired_at from the
// program's event) and every event names the transaction that made the account terminal, found among
// the account's newest signatures. Idempotent: event ids are deterministic, events are inserted once,
// and an `onchain` write never replaces a later observation. Driven by land-event-job.js behind the
// CLI agreement-lifecycle-job.mjs.
//
// An agreement on an EVM chain (blockchain/contracts/Agreement.sol, read through
// agreements/onchain-evm.js) gets the same events: the transaction is the one whose AgreementExecuted,
// AgreementCancelled or AgreementExpired log names the agreement's key, found with queryFilter in a
// bounded block range (from the block the agreement was created, or the deadline passed, to the block it
// was read at; only the block of executed_at for an execution), paged because public RPCs limit log
// ranges. Every event time is that log's block timestamp, which the event's own time and, on execution,
// the record's executed_at must equal. Event ids start `eip155:<chainId>:<contract>:`, so they never
// meet a Solana id (`solana:<cluster>:`) or another chain's.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
    ONCHAIN_STATUSES,
    TERMINAL_STATUSES,
    decisionOf,
    onchainFromAccount,
    onchainMoved,
    refreshOnchain,
    writeOnchain
} from '../agreements/onchain.js';
import {
    AGREEMENT_TERMINAL_EVENTS as EVM_TERMINAL_EVENTS,
    EVM_MOVING_FIELDS,
    evmChainLabel,
    evmOnchainMoved,
    onchainFromEvmRecord
} from '../agreements/onchain-evm.js';
import { sameKey } from '../chain/keys.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The shared EVM agreement codec: its explorer links (Basescan, Etherscan; none on a local chain).
const EvmAgreement = require('../../frontend/js/chain/evm-agreement.js');

export const AGREEMENT_LIFECYCLE_EVENT_TYPE = 'agreement_lifecycle';
export const AGREEMENT_EXECUTED_EVENT_TYPE = 'agreement_executed';
export const AGREEMENT_EVENT_TYPES = Object.freeze([AGREEMENT_LIFECYCLE_EVENT_TYPE, AGREEMENT_EXECUTED_EVENT_TYPE]);

// COPIED from blockchain/solana/idl/agreement.json, never computed at runtime: sha256("event:<Name>")[..8]
// of the three events that leave an agreement account terminal.
const TERMINAL_EVENTS = Object.freeze({
    executed: Object.freeze({ name: 'AgreementExecuted', discriminator: Buffer.from([65, 68, 243, 222, 242, 187, 19, 100]) }),
    cancelled: Object.freeze({ name: 'AgreementCancelled', discriminator: Buffer.from([132, 200, 190, 125, 242, 4, 12, 146]) }),
    expired: Object.freeze({ name: 'AgreementExpired', discriminator: Buffer.from([139, 169, 189, 84, 24, 97, 248, 145]) })
});

// How many of an account's newest transactions are searched for the one that made it terminal. The
// program writes nothing after that, so only plain transfers to the account can push it further back.
export const TERMINAL_SEARCH_LIMIT = 50;
// A progress line every this many agreements (and one per agreement that moved, failed or got events).
const PROGRESS_EVERY = 25;
// Blocks per eth_getLogs request when searching an EVM agreement's terminal log; halved (down to one
// block) each time the RPC refuses a range, and kept that small for the rest of the pass.
export const EVM_LOG_PAGE_BLOCKS = 10_000;

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function explorer(kind, value, cluster) {
    return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=${encodeURIComponent(cluster)}`;
}

// Unix seconds from the chain -> ISO. A non-positive or unsafe value is not a time: refuse it rather
// than write 1970 as an event time.
function chainTime(seconds, what) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`${what} has no valid chain time`);
    return new Date(seconds * 1000).toISOString();
}

/**
 * `Program data:` payloads emitted by `programId` itself, walking the invoke/success stack of the log
 * so another program in the same transaction cannot pass its logs off as the agreement program's.
 */
export function programDataLogs(logMessages, programId) {
    const stack = [];
    const out = [];
    for (const line of logMessages || []) {
        const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
        if (invoke) { stack.push(invoke[1]); continue; }
        const exit = /^Program (\S+) (success|failed)/.exec(line);
        if (exit) { if (stack.at(-1) === exit[1]) stack.pop(); continue; }
        if (line.startsWith('Program data: ') && stack.at(-1) === programId) {
            out.push(Buffer.from(line.slice('Program data: '.length), 'base64'));
        }
    }
    return out;
}

function eventReader(bytes) {
    let offset = 8;
    const take = count => {
        if (offset + count > bytes.length) throw new Error('agreement event ended early');
        const out = bytes.subarray(offset, offset + count);
        offset += count;
        return out;
    };
    return {
        pubkey: () => new web3.PublicKey(take(32)).toBase58(),
        string: () => take(take(4).readUInt32LE(0)).toString('utf8'),
        u64: () => take(8).readBigUInt64LE(0).toString(),
        i64: () => {
            const value = take(8).readBigInt64LE(0);
            if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('agreement event time is out of range');
            return Number(value);
        },
        done: () => offset === bytes.length
    };
}

/**
 * The terminal event an agreement program `Program data:` payload carries ({ outcome, agreement, cid,
 * at, … } with lamports as decimal strings), or null for any other event. Throws on a malformed one.
 */
export function decodeTerminalEvent(payload) {
    const bytes = Buffer.from(payload || []);
    const outcome = Object.keys(TERMINAL_EVENTS)
        .find(key => bytes.length >= 8 && bytes.subarray(0, 8).equals(TERMINAL_EVENTS[key].discriminator));
    if (!outcome) return null;
    const r = eventReader(bytes);
    const event = { outcome, agreement: r.pubkey(), cid: r.string() };
    if (outcome === 'executed') {
        Object.assign(event, { payout: r.pubkey(), lamports: r.u64(), lens: r.pubkey(), decisionAttestation: r.pubkey(), at: r.i64() });
    } else {
        Object.assign(event, { refundedLamports: r.u64(), at: r.i64() });
    }
    if (!r.done()) throw new Error(`${TERMINAL_EVENTS[outcome].name} has trailing bytes`);
    return event;
}

/**
 * The successful transaction that left `account` in `outcome`: the newest of its signatures whose
 * logs carry the agreement program's terminal event for this account. { signature, slot, event } or null.
 */
export async function findTerminalTransaction(connection, { account, outcome, programId, limit = TERMINAL_SEARCH_LIMIT }) {
    const signatures = await connection.getSignaturesForAddress(new web3.PublicKey(account), { limit }, 'confirmed');
    for (const entry of signatures || []) {
        if (entry.err) continue;
        const tx = await connection.getTransaction(entry.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta?.err) continue;
        for (const payload of programDataLogs(tx.meta?.logMessages, programId)) {
            let event = null;
            try { event = decodeTerminalEvent(payload); } catch { event = null; }
            if (event && event.outcome === outcome && event.agreement === account) {
                return { signature: entry.signature, slot: tx.slot ?? entry.slot ?? null, event };
            }
        }
    }
    return null;
}

/**
 * The land events of one terminal agreement account: its `agreement_lifecycle` event and, when it
 * executed, one `agreement_executed` event per input parcel. `agreement` is the index row's
 * { cid, inputParcelIds, parcelSourceId }, `account` the decoded account and `accountData` its bytes as
 * read (hashed as the source), `source` findTerminalTransaction's answer.
 */
export function buildAgreementEvents({ agreement, account, accountData, cluster, programId, source }) {
    const outcome = ONCHAIN_STATUSES[account.statusCode];
    if (!TERMINAL_STATUSES.includes(outcome)) throw new Error(`agreement ${account.address} is ${outcome}, not terminal`);
    const { event } = source;
    if (event.outcome !== outcome || event.agreement !== account.address || event.cid !== account.cid) {
        throw new Error(`transaction ${source.signature} does not record ${outcome} for ${account.address}`);
    }
    // Executed: the account's executed_at, which its AgreementExecuted must repeat. Cancelled and expired:
    // the program's event time, since the account keeps none.
    if (outcome === 'executed' && event.at !== account.executedAt) {
        throw new Error(`AgreementExecuted says ${event.at} but agreement ${account.address} stores executed_at ${account.executedAt}`);
    }
    const observedAt = chainTime(outcome === 'executed' ? account.executedAt : event.at, `${TERMINAL_EVENTS[outcome].name} of ${account.address}`);
    const chain = `solana:${cluster}`;
    const attester = { kind: 'solana_program', address: programId };
    const sourceRef = {
        chain,
        accountUrl: explorer('address', account.address, cluster),
        transactionUrl: explorer('tx', source.signature, cluster),
        transaction: source.signature,
        slot: source.slot,
        hash: `sha256:${sha256Hex(Buffer.from(accountData))}`
    };
    // The decision attestation only when the decision reads as satisfied (decisionOf): a cancelled or
    // expired account carries none.
    const satisfied = decisionOf(account) === 'satisfied';
    const decision = {
        lens: account.lens,
        decision: decisionOf(account),
        attestation: satisfied ? account.decisionAttestation : null,
        attestationHash: satisfied && account.decisionHash ? `sha256:${account.decisionHash}` : null
    };
    const lifecycle = {
        id: `${chain}:${AGREEMENT_LIFECYCLE_EVENT_TYPE}:${account.address}:${outcome}`,
        eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
        subjectType: 'agreement',
        subjectId: account.address,
        outcome,
        observedAt,
        attester,
        source: sourceRef,
        evidence: {
            agreementCid: account.cid,
            account: account.address,
            sponsor: account.authority,
            ...decision,
            statusByte: account.statusCode,
            ...(outcome === 'executed'
                ? { payout: event.payout, paidLamports: event.lamports }
                : { refundedLamports: event.refundedLamports }),
            inputParcelIds: agreement.inputParcelIds,
            parcelSourceId: agreement.parcelSourceId ?? null,
            // The hashed bytes themselves, so a reader re-checks the source hash and decodes the account.
            accountDataBase64: Buffer.from(accountData).toString('base64')
        }
    };
    if (outcome !== 'executed') return [lifecycle];
    return [lifecycle, ...agreement.inputParcelIds.map(parcelId => ({
        id: `${chain}:${AGREEMENT_EXECUTED_EVENT_TYPE}:${account.address}:${parcelId}`,
        eventType: AGREEMENT_EXECUTED_EVENT_TYPE,
        subjectType: 'parcel',
        subjectId: parcelId,
        outcome,
        observedAt,
        attester,
        source: sourceRef,
        evidence: {
            agreementCid: account.cid,
            account: account.address,
            ...decision,
            parcelSourceId: agreement.parcelSourceId ?? null
        }
    }))];
}

// ---- EVM agreements ----------------------------------------------------------------------------------

/**
 * The first block in lo..hi whose timestamp is at least `seconds` (binary search over `timeOf(block)`),
 * or hi + 1 when none is.
 */
export async function firstBlockAtOrAfter(timeOf, seconds, lo, hi) {
    let low = lo;
    let high = hi + 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (await timeOf(middle) >= seconds) high = middle;
        else low = middle + 1;
    }
    return low;
}

/**
 * The log that left EVM agreement `account` (evmAccountOf) in `outcome`, found with the chain's
 * terminalLogs (queryFilter on the agreement's key) between the block where its end could first happen
 * and `toBlock`, the block it was read at: from the block of createdAt (cancelled), of the later of
 * createdAt and the deadline (expired), or only the blocks timed executed_at (executed). Pages newest
 * first, `paging.blocks` blocks a request; a refused range is halved and retried, and only a refused
 * single block throws. Returns the log (onchain-evm.js evmTerminalLogOf) with `blockTime`, its block's
 * timestamp, or null when no such log is in range.
 */
export async function findEvmTerminalLog(chain, { account, outcome, toBlock, paging = { blocks: EVM_LOG_PAGE_BLOCKS }, log = () => {} }) {
    const times = new Map();
    const timeOf = async block => {
        if (!times.has(block)) {
            const seconds = await chain.blockTime(block);
            if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`block ${block} has no timestamp`);
            times.set(block, seconds);
        }
        return times.get(block);
    };
    const since = outcome === 'executed' ? account.executedAt
        : outcome === 'expired' ? Math.max(account.createdAt, account.deadline) : account.createdAt;
    if (!Number.isSafeInteger(since) || since <= 0 || !Number.isSafeInteger(toBlock) || toBlock < 0) return null;
    const fromBlock = await firstBlockAtOrAfter(timeOf, since, 0, toBlock);
    const lastBlock = outcome === 'executed' ? await firstBlockAtOrAfter(timeOf, since + 1, fromBlock, toBlock) - 1 : toBlock;
    const key = account.address.toLowerCase();
    let high = lastBlock;
    while (high >= fromBlock) {
        const low = Math.max(fromBlock, high - paging.blocks + 1);
        let logs;
        try {
            logs = await chain.terminalLogs({ key: account.address, outcome, fromBlock: low, toBlock: high });
        } catch (error) {
            const span = high - low + 1;
            if (span <= 1) throw error;
            paging.blocks = Math.floor(span / 2);
            log(`the RPC refused the logs of blocks ${low}-${high} (${error.shortMessage || error.message}); asking ${paging.blocks} block(s) at a time`);
            continue;
        }
        const match = logs.filter(entry => !entry.removed && entry.outcome === outcome && entry.key === key && entry.cid === account.cid).at(-1);
        if (match) return { ...match, blockTime: await timeOf(match.block) };
        high = low - 1;
    }
    return null;
}

// sha256 of a log's topics and data bytes, in that order: what an EVM land event's source hash covers.
function evmLogHash({ topics, data }) {
    return sha256Hex(Buffer.concat([...topics, data].map(hex => Buffer.from(ethers.getBytes(hex)))));
}

/**
 * The land events of one terminal EVM agreement, as buildAgreementEvents writes a Solana one:
 * `agreement` the index row's { cid, inputParcelIds, parcelSourceId }, `account` the record as read
 * (evmAccountOf, its address the agreement key), `source` findEvmTerminalLog's answer. The time is the
 * log's block timestamp; the event's own time, and on execution the record's executed_at, must equal it.
 */
export function buildEvmAgreementEvents({ agreement, account, chainId, contract, source }) {
    const outcome = ONCHAIN_STATUSES[account.statusCode];
    if (!TERMINAL_STATUSES.includes(outcome)) throw new Error(`agreement ${account.address} is ${outcome}, not terminal`);
    const contractAddress = ethers.getAddress(contract);
    const name = EVM_TERMINAL_EVENTS[outcome];
    if (source.outcome !== outcome || source.key !== account.address.toLowerCase() || source.cid !== account.cid || source.address !== contractAddress) {
        throw new Error(`log ${source.transaction}#${source.logIndex} does not record ${outcome} for ${account.address}`);
    }
    if (source.at !== source.blockTime) {
        throw new Error(`${name} of ${account.address} says ${source.at} but its block ${source.block} is timed ${source.blockTime}`);
    }
    if (outcome === 'executed' && source.at !== account.executedAt) {
        throw new Error(`AgreementExecuted says ${source.at} but agreement ${account.address} stores executed_at ${account.executedAt}`);
    }
    const observedAt = chainTime(source.blockTime, `${name} of ${account.address}`);
    const chain = evmChainLabel(chainId);
    const prefix = `${chain}:${contractAddress}`;
    const attester = { kind: 'evm_contract', address: contractAddress };
    const transactionUrl = EvmAgreement.explorerUrl({ signature: source.transaction, chainId });
    const sourceRef = {
        chain,
        contract: contractAddress,
        // The land_event source_url: the explorer's transaction page, or the CAIP-style name of the
        // transaction on a chain without an explorer (a local node).
        url: transactionUrl ?? `${chain}:tx:${source.transaction}`,
        contractUrl: EvmAgreement.explorerUrl({ chainId, contract: contractAddress }),
        transactionUrl,
        transaction: source.transaction,
        block: source.block,
        logIndex: source.logIndex,
        hash: `sha256:${evmLogHash(source)}`
    };
    const satisfied = account.decisionCode === 1;
    const decision = {
        lens: account.lens,
        decision: satisfied ? 'satisfied' : 'pending',
        attestation: satisfied ? account.decisionAttestation : null,
        attestationHash: null
    };
    const lifecycle = {
        id: `${prefix}:${AGREEMENT_LIFECYCLE_EVENT_TYPE}:${account.address}:${outcome}`,
        eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
        subjectType: 'agreement',
        subjectId: account.address,
        outcome,
        observedAt,
        attester,
        source: sourceRef,
        evidence: {
            agreementCid: account.cid,
            account: account.address,
            sponsor: account.sponsor,
            ...decision,
            statusCode: account.statusCode,
            ...(outcome === 'executed' ? { payout: source.payout, paidWei: source.wei } : { refundedWei: source.refundedWei }),
            inputParcelIds: agreement.inputParcelIds,
            parcelSourceId: agreement.parcelSourceId ?? null,
            // The hashed log itself, so a reader re-checks the source hash and decodes the event.
            log: { topics: source.topics, data: source.data }
        }
    };
    if (outcome !== 'executed') return [lifecycle];
    return [lifecycle, ...agreement.inputParcelIds.map(parcelId => ({
        id: `${prefix}:${AGREEMENT_EXECUTED_EVENT_TYPE}:${account.address}:${parcelId}`,
        eventType: AGREEMENT_EXECUTED_EVENT_TYPE,
        subjectType: 'parcel',
        subjectId: parcelId,
        outcome,
        observedAt,
        attester,
        source: sourceRef,
        evidence: {
            agreementCid: account.cid,
            account: account.address,
            ...decision,
            parcelSourceId: agreement.parcelSourceId ?? null
        }
    }))];
}

// consensus.land_event column values of one event, in insert order ($1..$11), written the one
// idempotent way (ON CONFLICT (event_id) DO NOTHING).
export const LAND_EVENT_COLUMNS = `(event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash,
                 source_observed_at, attester, transaction_signature, evidence)`;

export function landEventParams(event) {
    return [
        event.id, event.eventType, event.subjectType, event.subjectId, event.outcome,
        event.source.url ?? event.source.accountUrl ?? event.source.transactionUrl, event.source.hash, event.observedAt, event.attester.address,
        event.source.transaction, JSON.stringify({ source: event.source, ...event.evidence })
    ];
}

// One agreement's events in one transaction: all of them or none. Returns how many were new.
async function insertEvents(pool, events) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let inserted = 0;
        for (const event of events) {
            const result = await client.query(`
                INSERT INTO consensus.land_event ${LAND_EVENT_COLUMNS}
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                ON CONFLICT (event_id) DO NOTHING
                RETURNING 1`, landEventParams(event));
            inserted += result.rows.length;
        }
        await client.query('COMMIT');
        return inserted;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// How many lifecycle and per-parcel events each account already has from `attester` (the program or
// contract the pass watches: an EVM key is the same on every chain) — an account whose events are
// complete needs no transaction search — and, once it has its lifecycle event, when it ended: that
// event's chain time.
async function storedEventCounts(pool, accounts, attester) {
    const counts = new Map(accounts.map(account => [account, { lifecycle: 0, parcels: 0, endedAt: null }]));
    if (!accounts.length) return counts;
    const { rows } = await pool.query(`
        SELECT evidence->>'account' AS account, event_type, count(*)::int AS events, max(source_observed_at) AS ended_at
        FROM consensus.land_event
        WHERE event_type = ANY($1::text[]) AND evidence->>'account' = ANY($2::text[]) AND attester = $3
        GROUP BY 1, 2`, [AGREEMENT_EVENT_TYPES, accounts, attester]);
    for (const row of rows) {
        const entry = counts.get(row.account);
        if (!entry) continue;
        if (row.event_type === AGREEMENT_LIFECYCLE_EVENT_TYPE) {
            entry.lifecycle = row.events;
            entry.endedAt = row.ended_at ? new Date(row.ended_at).toISOString() : null;
        } else {
            entry.parcels = row.events;
        }
    }
    return counts;
}

/**
 * One pass over the minted agreements of `chain.cluster` (agreements/onchain.js createAgreementChain),
 * or of `chain.chainId` for an EVM chain (agreements/onchain-evm.js evmAgreementChain). Dry run unless
 * `apply`: then nothing is written, and the result says what would be. One agreement's failure (an RPC
 * or database error) is recorded and the pass goes on with the next.
 * @returns {Promise<{ scanned: number, reconciled: number, moved: number, terminal: number, events: object[],
 *   inserted: number, invalidAccounts: object[], missingEvidence: string[], failed: object[], dryRun: boolean }>}
 *   reconciled: `onchain` rows written; invalidAccounts: agreements whose account is missing or is not
 *   theirs; missingEvidence: terminal accounts whose terminal transaction was not found; failed:
 *   { cid, error } of agreements whose step threw
 */
export async function syncAgreementLifecycle({ pool, chain, apply = false, now = () => Date.now(), log = () => {} } = {}) {
    if (!pool || !chain) throw new Error('pool and chain are required');
    // An EVM chain (agreements/onchain-evm.js evmAgreementChain, family 'evm') takes the rows recorded on
    // its chain id, and its events are attested by its Agreement contract.
    const evm = chain.family === 'evm';
    const attester = evm ? ethers.getAddress(chain.contract) : chain.programId;
    // The log page size, shrunk for the rest of the pass once the RPC refuses a range.
    const paging = { blocks: EVM_LOG_PAGE_BLOCKS };
    const where = evm ? `EVM chain ${chain.chainId}` : chain.cluster;
    // A Solana pass reads the rows minted under the program it watches; rows of the retired agreement
    // program keep the state last observed (agreements/onchain.js RETIRED_AGREEMENT_PROGRAM_ID).
    const { rows } = await pool.query(`
        SELECT cid, content->>'sponsor' AS sponsor, input_parcel_ids, parcel_source_id, onchain
        FROM consensus.agreement
        WHERE ${evm ? `onchain->>'chain' = 'evm' AND onchain->>'chainId' = $1` : `onchain->>'chain' = 'solana' AND onchain->>'cluster' = $1 AND onchain->>'programId' = $2`}
        ORDER BY created_at, cid`, evm ? [chain.chainId] : [chain.cluster, chain.programId]);
    const total = rows.length;
    log(`${total} minted agreement(s) on ${where}${apply ? '' : ' (dry run: nothing is written)'}`);
    const result = { scanned: total, reconciled: 0, moved: 0, terminal: 0, events: [], inserted: 0, invalidAccounts: [], missingEvidence: [], failed: [], dryRun: !apply };
    if (!total) return result;

    const reads = await chain.readAccounts(rows.map(row => row.onchain.account));
    const counts = await storedEventCounts(pool, rows.map(row => row.onchain.account), attester);
    const observedAt = new Date(now()).toISOString();
    for (let index = 0; index < total; index += 1) {
        const row = rows[index];
        const step = `${index + 1}/${total} ${row.cid}`;
        try {
            await reconcileAgreement({ row, read: reads[index], stored: counts.get(row.onchain.account), step });
        } catch (error) {
            result.failed.push({ cid: row.cid, error: error.message });
            log(`${step}: FAILED ${error.stack || error.message}`);
        }
        if ((index + 1) % PROGRESS_EVERY === 0 || index + 1 === total) {
            log(`progress ${index + 1}/${total} · moved ${result.moved} · terminal ${result.terminal} · events ${result.events.length} · invalid ${result.invalidAccounts.length} · missing evidence ${result.missingEvidence.length} · failed ${result.failed.length}`);
        }
    }
    return result;

    // One agreement: refresh its `onchain` (with when it ended, once known), then, when it is terminal
    // and its events are incomplete, find its terminal transaction and write the events.
    async function reconcileAgreement({ row, read, stored, step }) {
        const invalid = problem => {
            result.invalidAccounts.push({ cid: row.cid, account: row.onchain.account, problem });
            log(`${step}: account ${row.onchain.account} ${problem}`);
        };
        if (read.problem) return invalid(read.problem);
        const account = read.account;
        if (account.cid !== row.cid) return invalid(`stores CID ${account.cid}`);
        if (evm ? !sameKey(account.sponsor, row.sponsor) : account.authority !== row.sponsor) {
            return invalid(`belongs to ${evm ? account.sponsor : account.authority}, not the sponsor`);
        }

        const fresh = evm
            ? onchainFromEvmRecord(account, { chainId: chain.chainId, contract: chain.contract, observedAt, observedSlot: read.slot })
            : onchainFromAccount(account, { cluster: chain.cluster, programId: chain.programId, observedAt, observedSlot: read.slot });
        const moved = evm ? evmOnchainMoved(row.onchain, fresh) : onchainMoved(row.onchain, fresh);
        if (moved) {
            result.moved += 1;
            log(`${step}: ${row.onchain.status} → ${fresh.status}, decision ${row.onchain.decision} → ${fresh.decision}, escrow ${evm ? `${fresh.escrowWei} wei` : `${fresh.escrowLamports} lamports`}`);
        }
        const terminal = TERMINAL_STATUSES.includes(fresh.status);
        // When it ended, the chain's own time: its stored lifecycle event's, else executed_at. A first
        // pass over a cancelled or expired account learns it from the terminal event below.
        const endedAt = terminal ? (stored.endedAt ?? (fresh.status === 'executed' ? fresh.executedAt : null)) : null;
        const next = { ...refreshOnchain(row.onchain, fresh, evm ? EVM_MOVING_FIELDS : undefined), ...(endedAt ? { endedAt } : {}) };
        if (apply && await writeOnchain(pool, row.cid, next)) result.reconciled += 1;

        if (!terminal) return;
        result.terminal += 1;
        const parcelIds = row.input_parcel_ids || [];
        if (stored.lifecycle > 0 && (fresh.status !== 'executed' || stored.parcels >= parcelIds.length)) return;
        const source = evm
            ? await findEvmTerminalLog(chain, { account, outcome: fresh.status, toBlock: read.slot, paging, log: line => log(`${step}: ${line}`) })
            : await findTerminalTransaction(await chain.connection(), { account: account.address, outcome: fresh.status, programId: chain.programId });
        if (!source) {
            result.missingEvidence.push(account.address);
            log(`${step}: ${fresh.status}, but ${evm
                ? `no ${EVM_TERMINAL_EVENTS[fresh.status]} log of this key up to block ${read.slot}`
                : `no ${TERMINAL_EVENTS[fresh.status].name} among the account's newest ${TERMINAL_SEARCH_LIMIT} transactions`}`);
            return;
        }
        const agreement = { cid: row.cid, inputParcelIds: parcelIds, parcelSourceId: row.parcel_source_id };
        let events;
        try {
            events = evm
                ? buildEvmAgreementEvents({ agreement, account, chainId: chain.chainId, contract: chain.contract, source })
                : buildAgreementEvents({ agreement, account, accountData: read.data, cluster: chain.cluster, programId: chain.programId, source });
        } catch (error) {
            result.missingEvidence.push(account.address);
            log(`${step}: ${error.message}`);
            return;
        }
        if (apply && !endedAt) await writeOnchain(pool, row.cid, { ...next, endedAt: events[0].observedAt });
        result.events.push(...events);
        const inserted = apply ? await insertEvents(pool, events) : 0;
        result.inserted += inserted;
        log(`${step}: ${fresh.status} in ${evm ? `${source.transaction} (block ${source.block})` : source.signature}; ${events.length} event(s)${apply ? `, ${inserted} new` : ''}`);
    }
}
