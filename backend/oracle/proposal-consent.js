// Evidence log for lens model v2 (lens-model.md, blockchain/solana/README.md "Lens model v2"):
// materialises `proposal_acceptance` events from proposal_nft AcceptanceRecord accounts and
// `proposal_verdict` events from VerdictSettled program events in the transaction store, writes them
// to consensus.land_event with the shared idempotent insert, and refreshes the attester directory
// (consensus.lens_member) for every member seen in a record. Every event time comes from the chain
// (accepted_at, settled_at), never from this job's clock. While the v2 program is not deployed there
// are no records and no events, and the whole step is a no-op.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { encodeBase58 } from '../solana/tx-decoder.js';
import { upsertLensMember } from './lens-directory.js';
import {
    explorer,
    LAND_EVENT_COLUMNS,
    landEventParams,
    PROPOSAL_PROGRAM_ID,
    readProposalStatus,
    STATUS_EXECUTED,
    TERMINAL_OUTCOMES
} from './proposal-lifecycle.js';

export const ACCEPTANCE_EVENT_TYPE = 'proposal_acceptance';
export const VERDICT_EVENT_TYPE = 'proposal_verdict';

// Anchor discriminators: sha256("account:AcceptanceRecord")[..8] and sha256("event:VerdictSettled")[..8],
// equal to the checked-in proposal_nft IDL (pinned by proposal-consent-events.test.js).
const anchorDiscriminator = (prefix, name) => createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8);
export const ACCEPTANCE_RECORD_DISCRIMINATOR = anchorDiscriminator('account', 'AcceptanceRecord');
export const VERDICT_SETTLED_DISCRIMINATOR = anchorDiscriminator('event', 'VerdictSettled');

const DEFAULT_PUBKEY = '11111111111111111111111111111111';

function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

class Reader {
    constructor(bytes, what) {
        this.bytes = bytes;
        this.offset = 0;
        this.what = what;
    }

    take(n) {
        if (this.offset + n > this.bytes.length) throw new Error(`${this.what} ended early`);
        const out = this.bytes.subarray(this.offset, this.offset + n);
        this.offset += n;
        return out;
    }

    pubkey() { return new PublicKey(this.take(32)).toBase58(); }
    u8() { return this.take(1)[0]; }
    i64() { return Number(this.take(8).readBigInt64LE(0)); }
    string() {
        const length = this.take(4).readUInt32LE(0);
        return this.take(length).toString('utf8');
    }
}

// Unix seconds from the chain -> ISO. A non-positive or unsafe value is not a time: refuse it rather
// than write 1970 as an event time.
function chainTime(seconds, what) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`${what} has no valid on-chain time`);
    return new Date(seconds * 1000).toISOString();
}

/** Decode an AcceptanceRecord account (proposal_nft v2). */
export function decodeAcceptanceRecord(data) {
    const bytes = Buffer.from(data || []);
    const reader = new Reader(bytes, 'acceptance record');
    if (!reader.take(8).equals(ACCEPTANCE_RECORD_DISCRIMINATOR)) throw new Error('not an AcceptanceRecord account');
    const proposal = reader.pubkey();
    const parcelUid = reader.string();
    const owner = reader.pubkey();
    const member = reader.pubkey();
    const ownershipAttestation = reader.pubkey();
    const ownershipHash = reader.take(32).toString('hex');
    const payout = reader.pubkey();
    const acceptedAt = reader.i64();
    reader.u8(); // bump
    return {
        proposal, parcelUid, owner, member, ownershipAttestation, ownershipHash,
        payout: payout === DEFAULT_PUBKEY ? null : payout,
        acceptedAt
    };
}

/** Decode a VerdictSettled event payload (the bytes after "Program data: ", base64-decoded). */
export function decodeVerdictSettled(data) {
    const bytes = Buffer.from(data || []);
    const reader = new Reader(bytes, 'VerdictSettled event');
    if (!reader.take(8).equals(VERDICT_SETTLED_DISCRIMINATOR)) throw new Error('not a VerdictSettled event');
    return {
        proposal: reader.pubkey(),
        verdictAttestation: reader.pubkey(),
        verdictHash: reader.take(32).toString('hex'),
        member: reader.pubkey(),
        status: reader.u8(),
        settledAt: reader.i64()
    };
}

/**
 * `Program data:` payloads emitted by `programId` itself, walking the invoke/success stack of the
 * log so another program in the same transaction cannot pass its logs off as ours.
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

const PROGRAM_ATTESTER = Object.freeze({ kind: 'solana_program', address: PROPOSAL_PROGRAM_ID });

export function buildAcceptanceEvent({ recordAddress, record, accountData, transaction, slot = null }) {
    if (!recordAddress || !transaction) throw new Error('recordAddress and transaction are required');
    return {
        id: `solana:devnet:${ACCEPTANCE_EVENT_TYPE}:${recordAddress}`,
        eventType: ACCEPTANCE_EVENT_TYPE,
        subjectType: 'proposal',
        subjectId: record.proposal,
        outcome: 'accepted',
        observedAt: chainTime(record.acceptedAt, 'acceptance record'),
        attester: { ...PROGRAM_ATTESTER },
        source: {
            chain: 'solana:devnet',
            accountUrl: explorer('address', recordAddress),
            transactionUrl: explorer('tx', transaction),
            transaction,
            slot,
            hash: `sha256:${sha256Hex(Buffer.from(accountData || []))}`
        },
        evidence: {
            acceptanceRecord: recordAddress,
            parcelUid: record.parcelUid,
            owner: record.owner,
            member: record.member,
            ownershipAttestation: record.ownershipAttestation,
            ownershipHash: `sha256:${record.ownershipHash}`,
            payout: record.payout,
            acceptedAt: record.acceptedAt
        }
    };
}

export function buildVerdictEvent({ verdict, transaction, slot = null }) {
    const outcome = TERMINAL_OUTCOMES[verdict.status];
    if (outcome !== 'executed' && outcome !== 'expired') throw new Error(`VerdictSettled status ${verdict.status} is not a verdict outcome`);
    if (!transaction) throw new Error('transaction is required');
    return {
        id: `solana:devnet:${VERDICT_EVENT_TYPE}:${verdict.proposal}:${verdict.verdictAttestation}`,
        eventType: VERDICT_EVENT_TYPE,
        subjectType: 'proposal',
        subjectId: verdict.proposal,
        outcome,
        observedAt: chainTime(verdict.settledAt, 'VerdictSettled'),
        attester: { ...PROGRAM_ATTESTER },
        source: {
            chain: 'solana:devnet',
            accountUrl: explorer('address', verdict.proposal),
            transactionUrl: explorer('tx', transaction),
            transaction,
            slot,
            // sha256 over the whole verdict SAS account, as the program computed it on settlement.
            hash: `sha256:${verdict.verdictHash}`
        },
        evidence: {
            verdictAttestation: verdict.verdictAttestation,
            member: verdict.member,
            proposalStatusByte: verdict.status,
            settledAt: verdict.settledAt
        }
    };
}

/** VerdictSettled events in stored transactions, only from successful ones and only our program. */
export function verdictsFromTransactions(rows) {
    const verdicts = [];
    for (const row of rows) {
        const raw = row.raw?.result && !row.raw?.transaction ? row.raw.result : row.raw;
        if (!raw?.meta || raw.meta.err) continue;
        for (const payload of programDataLogs(raw.meta.logMessages, PROPOSAL_PROGRAM_ID)) {
            if (payload.length < 8 || !payload.subarray(0, 8).equals(VERDICT_SETTLED_DISCRIMINATOR)) continue;
            verdicts.push({ verdict: decodeVerdictSettled(payload), transaction: row.signature, slot: row.slot ?? null });
        }
    }
    return verdicts;
}

// The accept_with_attestations transaction that created a record: the stored, successful one whose
// proposal_nft instruction names this record in its `record` account.
function acceptanceTransaction(rows, recordAddress, decode) {
    for (const row of rows) {
        const decoded = decode(row.raw);
        if (!decoded || decoded.status !== 'success') continue;
        const matches = decoded.instructions.some(ix => ix.program?.address === PROPOSAL_PROGRAM_ID
            && ix.action === 'accept_with_attestations'
            && ix.accounts?.some(account => account.role === 'record' && account.address === recordAddress));
        if (matches) return row;
    }
    return null;
}

async function insertEvent(pool, event) {
    const result = await pool.query(`
        INSERT INTO consensus.land_event
            ${LAND_EVENT_COLUMNS}
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING 1
    `, landEventParams(event));
    return result.rows?.length ? 1 : 0;
}

/**
 * Directory entries derived from acceptance records: per member, how many distinct ownership
 * attestations and parcels its records cover, how many of those proposals are Executed, and the
 * earliest and latest accepted_at (the on-chain times that revealed the member).
 */
export function membersFromRecords(records, executedProposals = new Set()) {
    const byMember = new Map();
    for (const { record } of records) {
        const entry = byMember.get(record.member) || {
            key: record.member, attestations: new Set(), parcels: new Set(), proposals: new Set(),
            firstSeen: record.acceptedAt, lastSeen: record.acceptedAt
        };
        entry.attestations.add(record.ownershipAttestation);
        entry.parcels.add(record.parcelUid);
        entry.proposals.add(record.proposal);
        entry.firstSeen = Math.min(entry.firstSeen, record.acceptedAt);
        entry.lastSeen = Math.max(entry.lastSeen, record.acceptedAt);
        byMember.set(record.member, entry);
    }
    return [...byMember.values()].map(entry => ({
        key: entry.key,
        kind: 'owner-consent',
        coverage: {
            ownership: entry.attestations.size,
            parcels: entry.parcels.size,
            executed: [...entry.proposals].filter(proposal => executedProposals.has(proposal)).length
        },
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen
    }));
}

/**
 * One pass of the v2 evidence log. `decode` is the transaction decoder bound to the IDLs.
 * @returns {Promise<{records:number, acceptanceEvents:number, verdictEvents:number, events:object[],
 *   inserted:number, members:number, missingEvidence:string[], invalidRecords:string[], dryRun:boolean}>}
 */
export async function syncProposalConsentEvents({ pool, connection, decode, dryRun = false, onProgress = () => {} } = {}) {
    if (!pool || !connection || !decode) throw new Error('pool, connection and decode are required');
    const program = new PublicKey(PROPOSAL_PROGRAM_ID);
    const accounts = await connection.getProgramAccounts(program, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(ACCEPTANCE_RECORD_DISCRIMINATOR) } }]
    });

    const invalidRecords = [];
    const records = [];
    for (const { pubkey, account } of accounts || []) {
        const recordAddress = pubkey.toBase58?.() ?? String(pubkey);
        if (account?.owner?.toBase58?.() !== PROPOSAL_PROGRAM_ID) { invalidRecords.push(recordAddress); continue; }
        try {
            records.push({ recordAddress, record: decodeAcceptanceRecord(account.data), accountData: account.data });
        } catch {
            invalidRecords.push(recordAddress);
        }
    }
    onProgress({ phase: 'acceptance-records', done: records.length, total: (accounts || []).length });

    // One store read covers both event kinds: every successful transaction that touched the program
    // and either logged program data (a VerdictSettled candidate) or touched one of the records.
    const recordAddresses = records.map(item => item.recordAddress);
    const transactions = await pool.query(`
        SELECT signature, slot, block_time, raw
        FROM consensus.solana_transaction
        WHERE $1 = ANY(touched_addresses)
          AND (touched_addresses && $2::text[]
               OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(raw #> '{meta,logMessages}', '[]'::jsonb)) AS log(line)
                          WHERE line LIKE 'Program data: %'))
        ORDER BY block_time DESC NULLS LAST, slot DESC
    `, [PROPOSAL_PROGRAM_ID, recordAddresses]);

    const events = [];
    const missingEvidence = [];
    for (const item of records) {
        const source = acceptanceTransaction(transactions.rows, item.recordAddress, decode);
        if (!source) { missingEvidence.push(item.recordAddress); continue; }
        events.push(buildAcceptanceEvent({ ...item, transaction: source.signature, slot: source.slot }));
    }
    const acceptanceEvents = events.length;
    for (const { verdict, transaction, slot } of verdictsFromTransactions(transactions.rows)) {
        events.push(buildVerdictEvent({ verdict, transaction, slot }));
    }

    // Coverage "executed": the member's proposals whose account status is Executed right now.
    const proposals = [...new Set(records.map(item => item.record.proposal))];
    const executed = new Set();
    for (let index = 0; index < proposals.length; index += 100) {
        const chunk = proposals.slice(index, index + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk.map(key => new PublicKey(key)), 'confirmed');
        infos.forEach((info, i) => {
            if (info?.data && info.owner?.toBase58?.() === PROPOSAL_PROGRAM_ID && readProposalStatus(info.data) === STATUS_EXECUTED) {
                executed.add(chunk[i]);
            }
        });
    }
    const members = membersFromRecords(records, executed);

    let inserted = 0;
    if (!dryRun) {
        for (let index = 0; index < events.length; index += 1) {
            inserted += await insertEvent(pool, events[index]);
            onProgress({ phase: 'consent-events', done: index + 1, total: events.length, inserted });
        }
        for (const member of members) {
            // Two calls so first_seen_at/last_seen_at (LEAST/GREATEST in the upsert) get the earliest
            // and latest accepted_at; the second repeats the same coverage.
            const base = { key: member.key, kind: member.kind, coverage: member.coverage };
            await upsertLensMember(pool, { ...base, seenAt: member.firstSeen });
            if (member.lastSeen !== member.firstSeen) await upsertLensMember(pool, { ...base, seenAt: member.lastSeen });
        }
    }

    return {
        records: records.length,
        acceptanceEvents,
        verdictEvents: events.length - acceptanceEvents,
        events,
        inserted,
        members: members.length,
        missingEvidence,
        invalidRecords,
        dryRun
    };
}
