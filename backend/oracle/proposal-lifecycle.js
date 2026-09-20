// Deterministic land-event oracle for proposal terminal state. It snapshots the Solana proposal
// account, anchors the observation to the terminal transaction, and publishes a hashed recipe.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { decodeParsedTransaction, loadIdls } from '../solana/tx-decoder.js';

export const PROPOSAL_PROGRAM_ID = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
export const MARKET_PROGRAM_ID = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
export const RECIPE_ID = 'proposal-lifecycle-v1';
export const EVENT_TYPE = 'proposal_lifecycle';
export const STATUS_EXECUTED = 1;
export const STATUS_CANCELLED = 2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export function readProposalStatus(data) {
    const bytes = Buffer.from(data || []);
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
    return bytes[offset];
}

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
    const outcome = status === STATUS_EXECUTED ? 'executed' : status === STATUS_CANCELLED ? 'cancelled' : null;
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
            accountDataBase64: bytes.toString('base64')
        }
    };
}

function terminalAction(status) {
    return status === STATUS_EXECUTED ? 'accept_proposal' : status === STATUS_CANCELLED ? 'cancel_and_refund' : null;
}

function sourceForProposal(rows, proposalAccount, status, idls) {
    const action = terminalAction(status);
    for (const row of rows) {
        const decoded = decodeParsedTransaction(row.raw, { idls });
        if (!decoded || decoded.status !== 'success') continue;
        const matches = decoded.instructions.some(instruction => instruction.program?.address === PROPOSAL_PROGRAM_ID
            && instruction.action === action
            && instruction.accounts?.some(account => account.role === 'proposal' && account.address === proposalAccount));
        if (matches) return row;
    }
    return null;
}

async function writeEvent(pool, event) {
    const result = await pool.query(`
        INSERT INTO consensus.land_event
            (event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash,
             source_observed_at, attester, transaction_signature, evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (event_id) DO NOTHING
    `, [
        event.id, event.eventType, event.subjectType, event.subjectId, event.outcome,
        event.source.accountUrl, event.source.hash, event.observedAt, event.attester.address,
        event.source.transaction, JSON.stringify({ source: event.source, ...event.evidence })
    ]);
    return result.rowCount || 0;
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
        return status === STATUS_EXECUTED || status === STATUS_CANCELLED
            ? { proposalAccount, status, accountData: info.data }
            : null;
    }).filter(Boolean);

    const transactions = terminal.length ? await pool.query(`
        SELECT signature, slot, block_time, raw
        FROM consensus.solana_transaction
        WHERE touched_addresses && $1::text[]
        ORDER BY block_time DESC NULLS LAST, slot DESC
    `, [terminal.map(item => item.proposalAccount)]) : { rows: [] };
    const idls = loadIdls(path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl'));
    const events = [];
    const missingEvidence = [];
    let inserted = 0;
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
            if (!dryRun) inserted += await writeEvent(pool, event);
        }
        onProgress({ phase: 'events', done: index + 1, total: terminal.length, inserted });
    }
    return {
        scanned: accounts.length,
        invalidAccounts,
        terminal: terminal.length,
        events,
        inserted,
        missingEvidence,
        dryRun
    };
}

export { canonicalJson, sha256, sourceForProposal };
