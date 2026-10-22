// Permanent per-parcel log (lens-model.md "Evidence log", plan-design-agreement.md "Execution is one
// event"): merges everything the system knows about one cadastral parcel into a single timeline ordered
// by each event's own time. Sources: the published agreements that take the parcel as an input
// (consensus.agreement), lens members' ownership attestations (consensus.lens_attestation) and the
// parcel's `agreement_executed` land events (consensus.land_event, written by agreement-lifecycle.js:
// one per input parcel of an executed agreement, pointing at it). Every `at` is the source's own time;
// an event whose source carries no time keeps `at: null` and sorts last, it is never given the time of
// this read.

import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { AGREEMENT_EXECUTED_EVENT_TYPE, explorer } from './agreement-lifecycle.js';

export const PARCEL_PROGRAM_ID = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
export const OWNERSHIP_EVENT_TYPE = 'parcel_ownership';
export const AGREEMENT_PUBLISHED_EVENT_TYPE = 'agreement_published';

// Tie-break for events sharing one timestamp: the order they can causally happen in.
const TYPE_RANK = [AGREEMENT_PUBLISHED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE, AGREEMENT_EXECUTED_EVENT_TYPE];
const ROW_LIMIT = 500;

export function validParcelUid(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) return null;
    return text;
}

/** The parcel anchor PDA ["parcel", parcel_id] under parcel_nft, or null when the id cannot seed one (>32 bytes). */
export function deriveParcelAnchor(parcelUid) {
    if (Buffer.byteLength(String(parcelUid), 'utf8') > 32) return null;
    return PublicKey.findProgramAddressSync(
        [Buffer.from('parcel'), Buffer.from(String(parcelUid))], new PublicKey(PARCEL_PROGRAM_ID)
    )[0].toBase58();
}

/** Validate the Parcel account layout and its exact parcel identity, without inferring title. */
export function parcelAnchorAccountMatches(info, parcelUid) {
    if (info?.owner?.toBase58?.() !== PARCEL_PROGRAM_ID || info.executable) return false;
    const data = Buffer.from(info.data || []);
    const discriminator = createHash('sha256').update('account:Parcel').digest().subarray(0, 8);
    if (data.length < 12 || !data.subarray(0, 8).equals(discriminator)) return false;
    let offset = 8;
    const string = () => {
        if (offset + 4 > data.length) throw new Error('Truncated Parcel string length.');
        const length = data.readUInt32LE(offset); offset += 4;
        if (offset + length > data.length) throw new Error('Truncated Parcel string.');
        const bytes = data.subarray(offset, offset + length); offset += length;
        const value = bytes.toString('utf8');
        if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('Invalid Parcel UTF-8.');
        return value;
    };
    try {
        const id = string();
        const metadataUri = string();
        // owner (32 bytes) is a historical payload field, not evidence of real ownership.
        return id === parcelUid && metadataUri.length > 0 && offset + 33 <= data.length;
    } catch { return false; }
}

/**
 * SQL condition selecting consensus.land_event rows about parcel `$n`, attested by the agreement
 * program: an `agreement_executed` event is the parcel's own (its subject); an `agreement_lifecycle`
 * event names an agreement, so it matches when the agreement's input parcels list the parcel. Shared by
 * GET /oracle/events?parcelUid= (routes/land-events.js).
 */
export function landEventParcelCondition(paramIndex) {
    const p = `$${paramIndex}`;
    return `(attester = '${AGREEMENT_PROGRAM_ID}'
        AND CASE WHEN event_type = '${AGREEMENT_EXECUTED_EVENT_TYPE}'
            THEN subject_type = 'parcel' AND subject_id = ${p}::text
            ELSE evidence->'inputParcelIds' @> jsonb_build_array(${p}::text)
        END)`;
}

// A source time as ISO, or null. Accepts Date, ISO text and Unix seconds (block_time).
function isoOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
    const date = numeric ? new Date(Number(value) * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compact(event) {
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

export function agreementEvent(row) {
    return compact({
        type: AGREEMENT_PUBLISHED_EVENT_TYPE,
        // The index is ours: the time it received the agreement is this event's own time.
        at: isoOrNull(row.created_at),
        agreementCid: row.cid,
        title: row.title || undefined,
        link: `/agreements/${encodeURIComponent(row.cid)}`
    });
}

export function ownershipEvent(row) {
    const ownerCount = Number(row.owner_count);
    return compact({
        type: OWNERSHIP_EVENT_TYPE,
        at: isoOrNull(row.issued_at),
        attestation: row.address,
        member: row.authority,
        owner: row.owner,
        ownerCount: row.owner_count !== null && Number.isSafeInteger(ownerCount) ? ownerCount : null,
        // Only the account hash leaves this API; the payload's evidenceRef never does.
        hash: row.account_hash ? `sha256:${row.account_hash}` : null,
        transaction: row.transaction_signature || undefined,
        // Lens members issue on devnet (backend/lens/run.mjs).
        link: explorer('address', row.address, 'devnet')
    });
}

export function landEventHistoryEvent(row) {
    const evidence = row.evidence || {};
    const source = evidence.source || {};
    return compact({
        type: row.event_type,
        at: isoOrNull(row.source_observed_at),
        outcome: row.outcome,
        agreementCid: evidence.agreementCid,
        account: evidence.account,
        lens: evidence.lens,
        attestation: evidence.attestation || undefined,
        transaction: row.transaction_signature,
        hash: row.source_hash,
        link: source.transactionUrl || row.source_url
    });
}

function eventKey(event) {
    return [event.agreementCid, event.account, event.attestation, event.transaction].filter(Boolean).join('|');
}

/** Ascending by own time; untimed events last; ties by causal type order, then a stable key. */
export function sortHistory(events) {
    return [...events].sort((a, b) => {
        if (a.at !== b.at) {
            if (a.at === null) return 1;
            if (b.at === null) return -1;
            return a.at < b.at ? -1 : 1;
        }
        const rank = TYPE_RANK.indexOf(a.type) - TYPE_RANK.indexOf(b.type);
        if (rank) return rank;
        const ka = eventKey(a); const kb = eventKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

// Current account observation only. A transaction touching a derived address establishes neither
// an anchor's existence nor its creation time. Unavailable evidence stays unknown, not false.
async function loadAnchor(parcelUid, readAnchorAccount) {
    const account = deriveParcelAnchor(parcelUid);
    if (!account) return { account: null, exists: false, source: 'unseedable' };
    if (readAnchorAccount) {
        try {
            const exists = await readAnchorAccount(account, parcelUid);
            if (typeof exists !== 'boolean') throw new Error('Anchor reader returned no existence observation.');
            return { account, exists, source: 'chain' };
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] parcel history: anchor ${account} status unavailable`, error.message);
        }
    }
    return { account, exists: null, source: 'unavailable' };
}

export async function loadParcelHistory(pool, parcelUid, { readAnchorAccount = null } = {}) {
    const uid = validParcelUid(parcelUid);
    if (!uid) throw new Error('parcelUid is required');
    const [agreements, attestations, landEvents, anchor] = await Promise.all([
        pool.query(`
            SELECT cid, title, created_at
            FROM consensus.agreement
            WHERE input_parcel_ids @> ARRAY[$1::text]
            ORDER BY created_at, cid
            LIMIT ${ROW_LIMIT}
        `, [uid]),
        pool.query(`
            SELECT address, authority, owner, payload->>'ownerCount' AS owner_count,
                   account_hash, transaction_signature, issued_at
            FROM consensus.lens_attestation
            WHERE kind = 'ownership' AND parcel_uid = $1
            ORDER BY issued_at NULLS LAST, address
            LIMIT ${ROW_LIMIT}
        `, [uid]),
        pool.query(`
            SELECT event_id, event_type, subject_id, outcome, source_url, source_hash,
                   source_observed_at, transaction_signature, evidence
            FROM consensus.land_event
            WHERE event_type = $2 AND ${landEventParcelCondition(1)}
            ORDER BY source_observed_at, event_id
            LIMIT ${ROW_LIMIT}
        `, [uid, AGREEMENT_EXECUTED_EVENT_TYPE]),
        loadAnchor(uid, readAnchorAccount)
    ]);
    const events = sortHistory([
        ...agreements.rows.map(agreementEvent),
        ...attestations.rows.map(ownershipEvent),
        ...landEvents.rows.map(landEventHistoryEvent)
    ]);
    return { parcelUid: uid, anchor, events };
}
