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

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    ONCHAIN_STATUSES,
    TERMINAL_STATUSES,
    decisionOf,
    onchainFromAccount,
    onchainMoved,
    refreshOnchain,
    writeOnchain
} from '../agreements/onchain.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

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

// consensus.land_event column values of one event, in insert order ($1..$11), written the one
// idempotent way (ON CONFLICT (event_id) DO NOTHING).
export const LAND_EVENT_COLUMNS = `(event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash,
                 source_observed_at, attester, transaction_signature, evidence)`;

export function landEventParams(event) {
    return [
        event.id, event.eventType, event.subjectType, event.subjectId, event.outcome,
        event.source.accountUrl ?? event.source.transactionUrl, event.source.hash, event.observedAt, event.attester.address,
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

// How many lifecycle and per-parcel events each account already has (an account whose events are
// complete needs no transaction search) and, once it has its lifecycle event, when it ended: that
// event's chain time.
async function storedEventCounts(pool, accounts) {
    const counts = new Map(accounts.map(account => [account, { lifecycle: 0, parcels: 0, endedAt: null }]));
    if (!accounts.length) return counts;
    const { rows } = await pool.query(`
        SELECT evidence->>'account' AS account, event_type, count(*)::int AS events, max(source_observed_at) AS ended_at
        FROM consensus.land_event
        WHERE event_type = ANY($1::text[]) AND evidence->>'account' = ANY($2::text[])
        GROUP BY 1, 2`, [AGREEMENT_EVENT_TYPES, accounts]);
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
 * One pass over the minted agreements of `chain.cluster` (agreements/onchain.js createAgreementChain).
 * Dry run unless `apply`: then nothing is written, and the result says what would be. One agreement's
 * failure (an RPC or database error) is recorded and the pass goes on with the next.
 * @returns {Promise<{ scanned: number, reconciled: number, moved: number, terminal: number, events: object[],
 *   inserted: number, invalidAccounts: object[], missingEvidence: string[], failed: object[], dryRun: boolean }>}
 *   reconciled: `onchain` rows written; invalidAccounts: agreements whose account is missing or is not
 *   theirs; missingEvidence: terminal accounts whose terminal transaction was not found; failed:
 *   { cid, error } of agreements whose step threw
 */
export async function syncAgreementLifecycle({ pool, chain, apply = false, now = () => Date.now(), log = () => {} } = {}) {
    if (!pool || !chain) throw new Error('pool and chain are required');
    const { rows } = await pool.query(`
        SELECT cid, content->>'sponsor' AS sponsor, input_parcel_ids, parcel_source_id, onchain
        FROM consensus.agreement
        WHERE onchain->>'chain' = 'solana' AND onchain->>'cluster' = $1
        ORDER BY created_at, cid`, [chain.cluster]);
    const total = rows.length;
    log(`${total} minted agreement(s) on ${chain.cluster}${apply ? '' : ' (dry run: nothing is written)'}`);
    const result = { scanned: total, reconciled: 0, moved: 0, terminal: 0, events: [], inserted: 0, invalidAccounts: [], missingEvidence: [], failed: [], dryRun: !apply };
    if (!total) return result;

    const reads = await chain.readAccounts(rows.map(row => row.onchain.account));
    const counts = await storedEventCounts(pool, rows.map(row => row.onchain.account));
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
        if (account.authority !== row.sponsor) return invalid(`belongs to ${account.authority}, not the sponsor`);

        const fresh = onchainFromAccount(account, { cluster: chain.cluster, programId: chain.programId, observedAt, observedSlot: read.slot });
        const moved = onchainMoved(row.onchain, fresh);
        if (moved) {
            result.moved += 1;
            log(`${step}: ${row.onchain.status} → ${fresh.status}, decision ${row.onchain.decision} → ${fresh.decision}, escrow ${fresh.escrowLamports} lamports`);
        }
        const terminal = TERMINAL_STATUSES.includes(fresh.status);
        // When it ended, the chain's own time: its stored lifecycle event's, else executed_at. A first
        // pass over a cancelled or expired account learns it from the terminal event below.
        const endedAt = terminal ? (stored.endedAt ?? (fresh.status === 'executed' ? fresh.executedAt : null)) : null;
        const next = { ...refreshOnchain(row.onchain, fresh), ...(endedAt ? { endedAt } : {}) };
        if (apply && await writeOnchain(pool, row.cid, next)) result.reconciled += 1;

        if (!terminal) return;
        result.terminal += 1;
        const parcelIds = row.input_parcel_ids || [];
        if (stored.lifecycle > 0 && (fresh.status !== 'executed' || stored.parcels >= parcelIds.length)) return;
        const source = await findTerminalTransaction(await chain.connection(), {
            account: account.address, outcome: fresh.status, programId: chain.programId
        });
        if (!source) {
            result.missingEvidence.push(account.address);
            log(`${step}: ${fresh.status}, but no ${TERMINAL_EVENTS[fresh.status].name} among the account's newest ${TERMINAL_SEARCH_LIMIT} transactions`);
            return;
        }
        let events;
        try {
            events = buildAgreementEvents({
                agreement: { cid: row.cid, inputParcelIds: parcelIds, parcelSourceId: row.parcel_source_id },
                account, accountData: read.data, cluster: chain.cluster, programId: chain.programId, source
            });
        } catch (error) {
            result.missingEvidence.push(account.address);
            log(`${step}: ${error.message}`);
            return;
        }
        if (apply && !endedAt) await writeOnchain(pool, row.cid, { ...next, endedAt: events[0].observedAt });
        result.events.push(...events);
        const inserted = apply ? await insertEvents(pool, events) : 0;
        result.inserted += inserted;
        log(`${step}: ${fresh.status} in ${source.signature}; ${events.length} event(s)${apply ? `, ${inserted} new` : ''}`);
    }
}
