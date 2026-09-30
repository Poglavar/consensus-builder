// Permanent per-parcel log (lens-model.md "Evidence log"): merges everything the system knows about one
// cadastral parcel into a single timeline ordered by each event's own time. Sources: the proposal
// records listing the parcel (created, published on chain), lens members' ownership attestations
// (consensus.lens_attestation) and the land events whose evidence names the parcel
// (consensus.land_event: acceptances by parcelUid, lifecycle and verdicts via the proposals that list
// it). Every `at` is the source's own time; an event whose source carries no time keeps `at: null`
// and sorts last, it is never given the time of this read.

import { PublicKey } from '@solana/web3.js';
import { EVENT_TYPE as LIFECYCLE_EVENT_TYPE, explorer } from './proposal-lifecycle.js';
import { ACCEPTANCE_EVENT_TYPE, VERDICT_EVENT_TYPE } from './proposal-consent.js';

export const PARCEL_PROGRAM_ID = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
export const OWNERSHIP_EVENT_TYPE = 'parcel_ownership';
export const PROPOSAL_CREATED_EVENT_TYPE = 'proposal_created';
export const PROPOSAL_PUBLISHED_EVENT_TYPE = 'proposal_published';
const LAND_EVENT_TYPES = [ACCEPTANCE_EVENT_TYPE, LIFECYCLE_EVENT_TYPE, VERDICT_EVENT_TYPE];

// Tie-break for events sharing one timestamp: the order they can causally happen in.
const TYPE_RANK = [
    PROPOSAL_CREATED_EVENT_TYPE, PROPOSAL_PUBLISHED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE,
    ACCEPTANCE_EVENT_TYPE, VERDICT_EVENT_TYPE, LIFECYCLE_EVENT_TYPE
];
const ROW_LIMIT = 500;

// The proposal account a row points at, wherever older writers stored it.
const PROPOSAL_ACCOUNT_SQL = `COALESCE(
    onchain_data->>'proposalId',
    proposal_data #>> '{onchain,proposalId}',
    proposal_data #>> '{onchainData,proposalId}'
)`;

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

/**
 * SQL condition selecting consensus.land_event rows about parcel `$n`: an acceptance names its
 * parcel in its evidence; lifecycle and verdict events name a proposal, so they match through the
 * proposals whose cadastre_parcel_ids contain the parcel. Shared by GET /oracle/events?parcelUid=.
 */
export function landEventParcelCondition(paramIndex) {
    const p = `$${paramIndex}`;
    return `(CASE WHEN event_type = '${ACCEPTANCE_EVENT_TYPE}'
            THEN evidence->>'parcelUid' = ${p}::text
            ELSE subject_id IN (
                SELECT ${PROPOSAL_ACCOUNT_SQL} FROM proposal
                WHERE cadastre_parcel_ids @> jsonb_build_array(${p}::text)
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

function lensOf(onchainData) {
    const lens = onchainData && Array.isArray(onchainData.lens) ? onchainData.lens : null;
    if (!lens) return undefined;
    return lens.map(entry => (typeof entry === 'string' ? entry : entry?.address ?? entry?.key)).filter(Boolean);
}

function compact(event) {
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

export function proposalEvents(row) {
    const onchain = row.onchain_data && typeof row.onchain_data === 'object' ? row.onchain_data : {};
    const proposalAccount = row.proposal_account || onchain.proposalId || undefined;
    const lens = lensOf(onchain);
    const events = [compact({
        type: PROPOSAL_CREATED_EVENT_TYPE,
        // The proposal record is ours: its creation time is this event's own time.
        at: isoOrNull(row.created_at),
        proposalId: row.proposal_id,
        proposalAccount,
        title: row.title || row.name || undefined,
        link: `/proposals/${encodeURIComponent(row.proposal_id)}`
    })];
    if (proposalAccount) {
        const transaction = onchain.transactionHash || undefined;
        events.push(compact({
            type: PROPOSAL_PUBLISHED_EVENT_TYPE,
            // Block time of the mint transaction from the transaction store; null when not stored.
            at: isoOrNull(row.mint_block_time),
            proposalId: row.proposal_id,
            proposalAccount,
            lens,
            transaction,
            link: transaction ? explorer('tx', transaction) : explorer('address', proposalAccount)
        }));
    }
    return events;
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

/**
 * The anchor as the transaction store saw it: exists when a successful stored transaction touched
 * the PDA; mintedAt is the earliest such block time. `readAnchorAccount(address)` (a chain read)
 * decides `exists` when given and reachable, since the store only holds watched addresses.
 */
async function loadAnchor(pool, parcelUid, readAnchorAccount) {
    const account = deriveParcelAnchor(parcelUid);
    if (!account) return { account: null, exists: false, source: 'unseedable' };
    const { rows } = await pool.query(`
        SELECT count(*)::int AS transactions, min(block_time) AS first_block_time
        FROM consensus.solana_transaction
        WHERE touched_addresses @> ARRAY[$1]::text[]
          AND COALESCE(raw->'meta'->'err', raw->'result'->'meta'->'err', 'null'::jsonb) = 'null'::jsonb
    `, [account]);
    const stored = rows[0] || {};
    const mintedAt = isoOrNull(stored.first_block_time);
    let exists = Number(stored.transactions || 0) > 0;
    let source = 'transaction-store';
    if (readAnchorAccount) {
        try {
            exists = Boolean(await readAnchorAccount(account));
            source = 'chain';
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] parcel history: anchor ${account} chain read failed, using the transaction store`, error.message);
        }
    }
    return compact({ account, exists, mintedAt: mintedAt ?? undefined, source });
}

export async function loadParcelHistory(pool, parcelUid, { readAnchorAccount = null } = {}) {
    const uid = validParcelUid(parcelUid);
    if (!uid) throw new Error('parcelUid is required');
    const [proposals, attestations, landEvents, anchor] = await Promise.all([
        pool.query(`
            SELECT p.proposal_id, p.title, p.name, p.created_at, p.onchain_data,
                   ${PROPOSAL_ACCOUNT_SQL} AS proposal_account,
                   tx.block_time AS mint_block_time
            FROM proposal p
            LEFT JOIN consensus.solana_transaction tx ON tx.signature = p.onchain_data->>'transactionHash'
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
        loadAnchor(pool, uid, readAnchorAccount)
    ]);
    const proposalIdByAccount = new Map(proposals.rows
        .filter(row => row.proposal_account)
        .map(row => [row.proposal_account, row.proposal_id]));
    const events = sortHistory([
        ...proposals.rows.flatMap(proposalEvents),
        ...attestations.rows.map(ownershipEvent),
        ...landEvents.rows.map(row => landEventHistoryEvent(row, proposalIdByAccount))
    ]);
    return { parcelUid: uid, anchor, events };
}
