// Deterministic land-event oracle for proposal terminal state. It snapshots the Solana proposal
// account, anchors the observation to the terminal transaction, publishes a hashed recipe, and
// reconciles the proposal read model from that verified event.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { decodeParsedTransaction, loadIdls } from '../solana/tx-decoder.js';

export const PROPOSAL_PROGRAM_ID = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
export const MARKET_PROGRAM_ID = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
export const RECIPE_ID = 'proposal-lifecycle-v1';
export const RECIPE_V2_ID = 'proposal-lifecycle-v2';
export const EVENT_TYPE = 'proposal_lifecycle';
export const STATUS_EXECUTED = 1;
export const STATUS_CANCELLED = 2;
// v2 (blockchain/solana/README.md "Lens model v2", pending devnet deployment): set by a lens
// member's `expired` verdict through settle_with_verdict. The market resolves it NO.
export const STATUS_EXPIRED = 3;

const TERMINAL_OUTCOMES = Object.freeze({
    [STATUS_EXECUTED]: 'executed',
    [STATUS_CANCELLED]: 'cancelled',
    [STATUS_EXPIRED]: 'expired'
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const IDL_DIR = path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl');

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function takeU32(bytes, offset) {
    if (offset + 4 > bytes.length) throw new Error('proposal account ended before a length field');
    return bytes.readUInt32LE(offset);
}

// Offset of the status byte in a proposal_nft Proposal account (after the 8-byte discriminator,
// proposal_id, owner, parcel_ids, is_conditional, image_uri, acceptance_possible).
function statusOffset(bytes) {
    let offset = 8 + 8 + 32;
    const parcelCount = takeU32(bytes, offset); offset += 4;
    for (let index = 0; index < parcelCount; index += 1) {
        const length = takeU32(bytes, offset); offset += 4 + length;
        if (offset > bytes.length) throw new Error('proposal account ended inside parcel ids');
    }
    offset += 1;
    const uriLength = takeU32(bytes, offset); offset += 4 + uriLength;
    offset += 1;
    if (offset >= bytes.length) throw new Error('proposal account has no lifecycle status');
    return offset;
}

export function readProposalStatus(data) {
    const bytes = Buffer.from(data || []);
    return bytes[statusOffset(bytes)];
}

/**
 * The proposal's lens: the base58 keys whose attestations its program accepts. Reads past status
 * through sol_balance, token_balance, acceptance_count and accepted_parcels, the same prefix
 * proposal_market's ProposalLensView mirrors (pinned by proposal-market-layout.test.js). Both v1
 * and v2 accounts carry the lens at this offset. Throws on a truncated account: a missing lens
 * must never read as an empty (or any other) list.
 */
export function readProposalLens(data) {
    const bytes = Buffer.from(data || []);
    let offset = statusOffset(bytes) + 1 + 8 + 8 + 8;
    const acceptedCount = takeU32(bytes, offset); offset += 4;
    for (let index = 0; index < acceptedCount; index += 1) {
        const length = takeU32(bytes, offset); offset += 4 + length;
        if (offset > bytes.length) throw new Error('proposal account ended inside accepted parcels');
    }
    const lensCount = takeU32(bytes, offset); offset += 4;
    if (offset + lensCount * 32 > bytes.length) throw new Error('proposal account ended inside the lens');
    const lens = [];
    for (let index = 0; index < lensCount; index += 1) {
        lens.push(new PublicKey(bytes.subarray(offset, offset + 32)).toBase58());
        offset += 32;
    }
    return lens;
}

// proposal-lifecycle-v1 is precommitted: its body, and therefore its hash, must never change under
// this id (proposal-lifecycle-oracle.test.js pins the hash). Trusted attester: the ProposalNFT
// program only; executed -> YES, cancelled -> NO.
export function buildProposalLifecycleRecipe({ proposalAccount, marketAccount = null } = {}) {
    if (!proposalAccount) throw new Error('proposalAccount is required');
    const body = {
        id: RECIPE_ID,
        version: 1,
        question: 'Will this proposal execute?',
        eventType: EVENT_TYPE,
        subject: { chain: 'solana:devnet', proposalAccount, marketAccount },
        trustedAttesters: [{ kind: 'solana_program', address: PROPOSAL_PROGRAM_ID }],
        outcomes: { executed: 'YES', cancelled: 'NO' },
        verification: {
            kind: 'program_account_state',
            marketProgram: MARKET_PROGRAM_ID,
            proposalOwnerProgram: PROPOSAL_PROGRAM_ID,
            statusBytes: { executed: STATUS_EXECUTED, cancelled: STATUS_CANCELLED },
            permissionless: true
        }
    };
    return { ...body, hash: `sha256:${sha256(canonicalJson(body))}` };
}

/**
 * proposal-lifecycle-v2 (lens model): trusted attesters derive from the proposal's on-chain lens.
 * The ProposalNFT program attests the terminal state, and on v2 it moves that state only on
 * attestations signed by a lens member (accept_with_attestations, settle_with_verdict), so the
 * recipe names both and its hash commits to the lens. Expired (a lens member's verdict) is NO.
 * `lens` is required: read it with readProposalLens from the proposal account, never assume it.
 */
export function buildProposalLifecycleRecipeV2({ proposalAccount, marketAccount = null, lens } = {}) {
    if (!proposalAccount) throw new Error('proposalAccount is required');
    if (!Array.isArray(lens) || lens.length === 0) throw new Error('lens is required: read it from the proposal account');
    const members = lens.map(key => {
        try { return new PublicKey(key).toBase58(); } catch { throw new Error(`lens entry ${key} is not a Solana public key`); }
    });
    const body = {
        id: RECIPE_V2_ID,
        version: 2,
        question: 'Will this proposal execute?',
        eventType: EVENT_TYPE,
        subject: { chain: 'solana:devnet', proposalAccount, marketAccount },
        trustedAttesters: [
            { kind: 'solana_program', address: PROPOSAL_PROGRAM_ID, role: 'enforces the proposal lens on chain' },
            ...members.map(address => ({ kind: 'solana_sas_issuer', address, role: 'lens member' }))
        ],
        outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
        verification: {
            kind: 'program_account_state',
            marketProgram: MARKET_PROGRAM_ID,
            proposalOwnerProgram: PROPOSAL_PROGRAM_ID,
            statusBytes: { executed: STATUS_EXECUTED, cancelled: STATUS_CANCELLED, expired: STATUS_EXPIRED },
            lensSource: 'proposal account lens, decoded after accepted_parcels',
            permissionless: true
        }
    };
    return { ...body, hash: `sha256:${sha256(canonicalJson(body))}` };
}

// Which recipe a proposal account qualifies for: v2 when it carries a lens with at least one key
// (every proposal minted from now on; the program refuses an empty lens), v1 otherwise.
export function recipeForProposalAccount({ proposalAccount, marketAccount = null, accountData } = {}) {
    let lens = null;
    try { lens = accountData ? readProposalLens(accountData) : null; } catch { lens = null; }
    return lens && lens.length
        ? buildProposalLifecycleRecipeV2({ proposalAccount, marketAccount, lens })
        : buildProposalLifecycleRecipe({ proposalAccount, marketAccount });
}

function explorer(kind, value) {
    return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
}

export function buildProposalLifecycleEvent({
    proposalAccount,
    status,
    accountData,
    transaction,
    blockTime,
    slot = null
} = {}) {
    const outcome = TERMINAL_OUTCOMES[status] ?? null;
    if (!outcome) throw new Error('proposal status is not terminal');
    if (!proposalAccount || !transaction) throw new Error('proposalAccount and transaction are required');
    const numericBlockTime = typeof blockTime === 'number' && Number.isSafeInteger(blockTime)
        ? blockTime
        : typeof blockTime === 'string' && /^\d+$/.test(blockTime) && Number.isSafeInteger(Number(blockTime))
            ? Number(blockTime)
            : null;
    const observedAt = numericBlockTime === null ? null : new Date(numericBlockTime * 1000).toISOString();
    if (!observedAt) throw new Error('the source transaction has no block time');
    const bytes = Buffer.from(accountData || []);
    return {
        id: `solana:devnet:${EVENT_TYPE}:${proposalAccount}:${outcome}`,
        eventType: EVENT_TYPE,
        subjectType: 'proposal',
        subjectId: proposalAccount,
        outcome,
        observedAt,
        attester: { kind: 'solana_program', address: PROPOSAL_PROGRAM_ID },
        source: {
            chain: 'solana:devnet',
            accountUrl: explorer('address', proposalAccount),
            transactionUrl: explorer('tx', transaction),
            transaction,
            slot,
            hash: `sha256:${sha256(bytes)}`
        },
        evidence: {
            proposalStatusByte: status,
            accountDataBase64: bytes.toString('base64'),
            recipeId: recipeForProposalAccount({ proposalAccount, accountData: bytes }).id
        }
    };
}

// The instructions that can leave a proposal in each terminal status: v1 accept_proposal (devnet
// history), v2 accept_with_attestations (the last acceptance executes) and settle_with_verdict.
function terminalActions(status) {
    if (status === STATUS_EXECUTED) return ['accept_proposal', 'accept_with_attestations', 'settle_with_verdict'];
    if (status === STATUS_CANCELLED) return ['cancel_and_refund'];
    if (status === STATUS_EXPIRED) return ['settle_with_verdict'];
    return [];
}

function sourceForProposal(rows, proposalAccount, status, idls) {
    const actions = terminalActions(status);
    for (const row of rows) {
        const decoded = decodeParsedTransaction(row.raw, { idls });
        if (!decoded || decoded.status !== 'success') continue;
        const matches = decoded.instructions.some(instruction => instruction.program?.address === PROPOSAL_PROGRAM_ID
            && actions.includes(instruction.action)
            && instruction.accounts?.some(account => account.role === 'proposal' && account.address === proposalAccount));
        if (matches) return row;
    }
    return null;
}

function lifecycleStatusForOutcome(outcome) {
    if (outcome === 'executed') return 'Executed';
    if (outcome === 'cancelled') return 'Cancelled';
    if (outcome === 'expired') return 'Expired';
    throw new Error(`unsupported proposal lifecycle outcome: ${outcome}`);
}

// consensus.land_event column values of one event, in insert order ($1..$11). Shared by every
// event type so all of them are written the same idempotent way (ON CONFLICT (event_id) DO NOTHING).
export const LAND_EVENT_COLUMNS = `(event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash,
                 source_observed_at, attester, transaction_signature, evidence)`;

export function landEventParams(event) {
    return [
        event.id, event.eventType, event.subjectType, event.subjectId, event.outcome,
        event.source.accountUrl ?? event.source.transactionUrl, event.source.hash, event.observedAt, event.attester.address,
        event.source.transaction, JSON.stringify({ source: event.source, ...event.evidence })
    ];
}

async function writeEventAndReconcileProposal(pool, event) {
    const lifecycleStatus = lifecycleStatusForOutcome(event.outcome);
    const result = await pool.query(`
        WITH inserted_event AS (
            INSERT INTO consensus.land_event
                ${LAND_EVENT_COLUMNS}
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
            ON CONFLICT (event_id) DO NOTHING
            RETURNING 1
        ), reconciled_proposals AS (
            UPDATE proposal
            SET lifecycle_status = $12,
                proposal_data = CASE
                    WHEN proposal_data IS NULL
                        THEN jsonb_build_object('lifecycleStatus', $12::text)
                    WHEN jsonb_typeof(proposal_data) = 'object'
                        THEN jsonb_set(proposal_data, '{lifecycleStatus}', to_jsonb($12::text), true)
                    ELSE proposal_data
                END,
                updated_at = NOW()
            WHERE COALESCE(
                onchain_data->>'proposalId',
                proposal_data #>> '{onchain,proposalId}',
                proposal_data #>> '{onchainData,proposalId}'
            ) = $4
              AND lifecycle_status IS DISTINCT FROM $12
            RETURNING 1
        )
        SELECT
            (SELECT COUNT(*)::integer FROM inserted_event) AS inserted,
            (SELECT COUNT(*)::integer FROM reconciled_proposals) AS reconciled
    `, [...landEventParams(event), lifecycleStatus]);
    return {
        inserted: Number(result.rows?.[0]?.inserted || 0),
        reconciled: Number(result.rows?.[0]?.reconciled || 0)
    };
}

export async function syncProposalLifecycleEvents({ pool, connection, dryRun = false, onProgress = () => {} } = {}) {
    if (!pool || !connection) throw new Error('pool and connection are required');
    const proposals = await pool.query(`
        SELECT DISTINCT COALESCE(
            onchain_data->>'proposalId',
            proposal_data #>> '{onchain,proposalId}',
            proposal_data #>> '{onchainData,proposalId}'
        ) AS proposal_account
        FROM proposal
        WHERE COALESCE(
            onchain_data->>'proposalId',
            proposal_data #>> '{onchain,proposalId}',
            proposal_data #>> '{onchainData,proposalId}'
        ) IS NOT NULL
    `);
    const invalidAccounts = [];
    const accounts = proposals.rows.map(row => row.proposal_account).filter(Boolean).flatMap(value => {
        try { return [new PublicKey(value).toBase58()]; }
        catch { invalidAccounts.push(value); return []; }
    });
    const infos = [];
    for (let index = 0; index < accounts.length; index += 100) {
        const chunk = accounts.slice(index, index + 100).map(value => new PublicKey(value));
        infos.push(...await connection.getMultipleAccountsInfo(chunk, 'confirmed'));
        onProgress({ phase: 'accounts', done: Math.min(index + chunk.length, accounts.length), total: accounts.length });
    }

    const terminal = accounts.map((proposalAccount, index) => {
        const info = infos[index];
        if (!info?.data || info.owner?.toBase58?.() !== PROPOSAL_PROGRAM_ID) return null;
        const status = readProposalStatus(info.data);
        return TERMINAL_OUTCOMES[status]
            ? { proposalAccount, status, accountData: info.data }
            : null;
    }).filter(Boolean);

    const transactions = terminal.length ? await pool.query(`
        SELECT signature, slot, block_time, raw
        FROM consensus.solana_transaction
        WHERE touched_addresses && $1::text[]
        ORDER BY block_time DESC NULLS LAST, slot DESC
    `, [terminal.map(item => item.proposalAccount)]) : { rows: [] };
    const idls = loadIdls(IDL_DIR);
    const events = [];
    const missingEvidence = [];
    let inserted = 0;
    let reconciled = 0;
    for (let index = 0; index < terminal.length; index += 1) {
        const item = terminal[index];
        const source = sourceForProposal(transactions.rows, item.proposalAccount, item.status, idls);
        if (!source) {
            missingEvidence.push(item.proposalAccount);
        } else {
            const event = buildProposalLifecycleEvent({
                ...item,
                transaction: source.signature,
                blockTime: source.block_time,
                slot: source.slot
            });
            events.push(event);
            if (!dryRun) {
                const persisted = await writeEventAndReconcileProposal(pool, event);
                inserted += persisted.inserted;
                reconciled += persisted.reconciled;
            }
        }
        onProgress({ phase: 'events', done: index + 1, total: terminal.length, inserted, reconciled });
    }
    return {
        scanned: accounts.length,
        invalidAccounts,
        terminal: terminal.length,
        events,
        inserted,
        reconciled,
        missingEvidence,
        dryRun
    };
}

export { canonicalJson, explorer, lifecycleStatusForOutcome, sha256, sourceForProposal, TERMINAL_OUTCOMES };
