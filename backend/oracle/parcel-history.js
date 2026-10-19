// Permanent per-parcel log (lens-model.md "Evidence log"): merges everything the system knows about one
// cadastral parcel into a single timeline ordered by each event's own time. Sources: the proposal
// records listing the parcel (created, verified chain mirror observed), lens members' ownership attestations
// (consensus.lens_attestation) and the land events whose evidence names the parcel
// (consensus.land_event: acceptances by parcelUid, lifecycle and verdicts via the proposals that list
// it). Every `at` is the source's own time; an event whose source carries no time keeps `at: null`
// and sorts last, it is never given the time of this read.

import { PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EVENT_TYPE as LIFECYCLE_EVENT_TYPE, explorer, PROPOSAL_PROGRAM_ID, VERIFIED_DEVNET_MIRROR_SQL } from './proposal-lifecycle.js';
import { ACCEPTANCE_EVENT_TYPE, VERDICT_EVENT_TYPE } from './proposal-consent.js';

const { PROTOCOL } = createRequire(import.meta.url)('../../frontend/js/proposals/chain-record.js');

export const PARCEL_PROGRAM_ID = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
export const OWNERSHIP_EVENT_TYPE = 'parcel_ownership';
export const PROPOSAL_CREATED_EVENT_TYPE = 'proposal_created';
export const PROPOSAL_CHAIN_OBSERVED_EVENT_TYPE = 'proposal_chain_observed';
const LAND_EVENT_TYPES = [ACCEPTANCE_EVENT_TYPE, LIFECYCLE_EVENT_TYPE, VERDICT_EVENT_TYPE];

// Tie-break for events sharing one timestamp: the order they can causally happen in.
const TYPE_RANK = [
    PROPOSAL_CREATED_EVENT_TYPE, PROPOSAL_CHAIN_OBSERVED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE,
    ACCEPTANCE_EVENT_TYPE, VERDICT_EVENT_TYPE, LIFECYCLE_EVENT_TYPE
];
const ROW_LIMIT = 500;

// Only a server-verified mirror establishes a relation to this oracle's devnet program.
const PROPOSAL_ACCOUNT_SQL = `proposal_data #>> '{chainMirror,ref,tokenId}'`;

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
 * SQL condition selecting consensus.land_event rows about parcel `$n`: an acceptance names its
 * parcel in its evidence; lifecycle and verdict events name a proposal, so they match through the
 * proposals whose cadastre_parcel_ids contain the parcel. Shared by GET /oracle/events?parcelUid=.
 */
export function landEventParcelCondition(paramIndex) {
    const p = `$${paramIndex}`;
    return `(evidence #>> '{source,chain}' = 'solana:devnet'
        AND attester = '${PROPOSAL_PROGRAM_ID}'
        AND CASE WHEN event_type = '${ACCEPTANCE_EVENT_TYPE}'
            THEN evidence->>'parcelUid' = ${p}::text
            ELSE subject_id IN (
                SELECT ${PROPOSAL_ACCOUNT_SQL} FROM proposal
                WHERE cadastre_parcel_ids @> jsonb_build_array(${p}::text)
                  AND ${VERIFIED_DEVNET_MIRROR_SQL}
            )
        END)`;
}

// A source time as ISO, or null. Accepts Date, ISO text and Unix seconds (block_time).
function isoOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
    const date = numeric ? new Date(Number(value) * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function lensOf(lens) {
    if (!Array.isArray(lens)) return undefined;
    return lens.map(entry => (typeof entry === 'string' ? entry : entry?.address ?? entry?.key)).filter(Boolean);
}

function compact(event) {
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

export function proposalEvents(row) {
    const mirror = verifiedDevnetMirror(row);
    const proposalAccount = mirror?.ref.tokenId;
    const events = [compact({
        type: PROPOSAL_CREATED_EVENT_TYPE,
        // The proposal record is ours: its creation time is this event's own time.
        at: isoOrNull(row.created_at),
        proposalId: row.proposal_id,
        proposalAccount,
        title: row.title || row.name || undefined,
        link: `/proposals/${encodeURIComponent(row.proposal_id)}`
    })];
    if (mirror) {
        events.push(compact({
            type: PROPOSAL_CHAIN_OBSERVED_EVENT_TYPE,
            // The mirror verified this account at this time. It did not establish its mint time.
            at: isoOrNull(mirror.verifiedAt),
            proposalId: row.proposal_id,
            proposalAccount,
            chainRef: { ...mirror.ref },
            lens: lensOf(row.observed_lens),
            link: explorer('address', proposalAccount)
        }));
    }
    return events;
}

function verifiedDevnetMirror(row) {
    const mirror = row.chain_mirror;
    const ref = mirror?.ref;
    if (mirror?.protocol !== PROTOCOL || ref?.chainType !== 'solana' || ref.chainId !== 'solana-devnet'
        || ref.contract !== PROPOSAL_PROGRAM_ID || typeof ref.tokenId !== 'string') return null;
    try { return new PublicKey(ref.tokenId).toBase58() === ref.tokenId ? mirror : null; }
    catch { return null; }
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
        link: explorer('address', row.address)
    });
}

export function landEventHistoryEvent(row, proposalIdByAccount = new Map()) {
    const evidence = row.evidence || {};
    const source = evidence.source || {};
    return compact({
        type: row.event_type,
        at: isoOrNull(row.source_observed_at),
        outcome: row.outcome,
        proposalId: proposalIdByAccount.get(row.subject_id),
        proposalAccount: row.subject_id,
        parcelUid: row.event_type === ACCEPTANCE_EVENT_TYPE ? evidence.parcelUid : undefined,
        member: evidence.member || undefined,
        owner: evidence.owner || undefined,
        attestation: evidence.ownershipAttestation || evidence.verdictAttestation || undefined,
        record: evidence.acceptanceRecord || undefined,
        transaction: row.transaction_signature,
        hash: row.source_hash,
        link: source.transactionUrl || row.source_url
    });
}

function eventKey(event) {
    return [event.proposalAccount, event.proposalId, event.attestation, event.record, event.transaction].filter(Boolean).join('|');
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
    const [proposals, attestations, landEvents, anchor] = await Promise.all([
        pool.query(`
            SELECT p.proposal_id, p.title, p.name, p.created_at,
                   (p.proposal_data->'chainMirror') - 'record' AS chain_mirror,
                   p.proposal_data #> '{chainMirror,record,lens}' AS observed_lens
            FROM proposal p
            WHERE p.cadastre_parcel_ids @> jsonb_build_array($1::text)
            ORDER BY p.created_at, p.id
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
            WHERE event_type = ANY($2::text[]) AND ${landEventParcelCondition(1)}
            ORDER BY source_observed_at, event_id
            LIMIT ${ROW_LIMIT}
        `, [uid, LAND_EVENT_TYPES]),
        loadAnchor(uid, readAnchorAccount)
    ]);
    const proposalIdByAccount = new Map(proposals.rows.flatMap(row => {
        const mirror = verifiedDevnetMirror(row);
        return mirror ? [[mirror.ref.tokenId, row.proposal_id]] : [];
    }));
    const events = sortHistory([
        ...proposals.rows.flatMap(proposalEvents),
        ...attestations.rows.map(ownershipEvent),
        ...landEvents.rows.map(row => landEventHistoryEvent(row, proposalIdByAccount))
    ]);
    return { parcelUid: uid, anchor, events };
}
