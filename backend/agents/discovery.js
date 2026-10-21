// Read proposal summaries for society/supporter policies, and check minted ones against their chain.

import { createHash } from 'node:crypto';
import { effectiveLifecycleStatus } from '../proposals/lifecycle.js';
import { isSolanaMinted } from './supporter-picker.js';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { decodeProposalState, PROPOSAL_PROGRAM_ID } from './lifecycle-actions.js';
import { proposalAccountOf } from '../markets/contests.js';

export const SUMMARY_PAGE = 1000;
export const MAX_DISCOVERED = 3000;
const CHAIN_STATUS = ['Active', 'Executed', 'Cancelled', 'Expired'];
const PROPOSAL_DISCRIMINATOR = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);

function key(proposal) {
    const id = typeof proposal?.proposalId === 'string' ? proposal.proposalId.trim() : '';
    if (!id || /^[0-9]+$/.test(id)) throw new Error('proposal summary is missing its non-numeric authored proposalId');
    return id;
}

const proposalAccount = proposal => proposalAccountOf(proposal?.onchain);

async function summaries(apiBase, city, fetchJson, log) {
    const proposals = [];
    let count = Infinity;
    for (let offset = 0; offset < Math.min(count, MAX_DISCOVERED); offset += SUMMARY_PAGE) {
        const query = `${city ? `city=${encodeURIComponent(city)}&` : ''}limit=${SUMMARY_PAGE}&offset=${offset}`;
        const page = await fetchJson(`${apiBase}/proposals/summary?${query}`);
        proposals.push(...(page.proposals || []));
        count = Number(page.count) || 0;
        if (!(page.proposals || []).length) break;
    }
    if (count > proposals.length) log(`${city || 'all cities'}: read the newest ${proposals.length} of ${count} proposals (cap ${MAX_DISCOVERED})`);
    return proposals;
}

export async function discoverProposalInputs({ apiBase, cities, fetchJson, log = () => {} }) {
    const pages = await Promise.all(cities.map(city => summaries(apiBase, city, fetchJson, log)));
    const byId = new Map();
    pages.flat().forEach(proposal => byId.set(key(proposal), proposal));
    return Array.from(byId.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// API rows can lag the daily evidence materializer. Every Solana proposal, including ordinary
// records, must be checked on chain before a policy acts on its reported lifecycle.
export function applyProposalStatuses(proposals, infos, { decodeState = decodeProposalState, programId = PROPOSAL_PROGRAM_ID } = {}) {
    const minted = (proposals || []).filter(isSolanaMinted);
    if (infos.length !== minted.length) throw new Error(`received ${infos.length} chain states for ${minted.length} minted proposals`);
    const expectedOwner = new PublicKey(programId);
    // Validate the entire batch before changing any policy inputs or persisting a read model.
    const statuses = minted.map((proposal, index) => {
        const label = `proposal ${key(proposal)}`;
        const info = infos[index];
        if (!info?.data) throw new Error(`${label} chain account ${proposalAccount(proposal)} is missing`);
        if (!info.owner || !new PublicKey(info.owner).equals(expectedOwner)) {
            throw new Error(`${label} chain account is not owned by the proposal program`);
        }
        if (!Buffer.from(info.data).subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
            throw new Error(`${label} chain account is not a Proposal account`);
        }
        const state = decodeState(info.data);
        if (!Number.isInteger(state?.status) || state.status < 0 || state.status >= CHAIN_STATUS.length) {
            throw new Error(`${label} has invalid on-chain status ${state?.status}`);
        }
        return CHAIN_STATUS[state.status];
    });
    minted.forEach((proposal, index) => {
        proposal.onchainLifecycleStatus = statuses[index];
        // A local expiry still excludes support while its terminal verdict waits to be submitted.
        proposal.lifecycleStatus = effectiveLifecycleStatus(statuses[index], proposal.expiresAt);
    });
    return proposals;
}

// This projects confirmed terminal account state into the API read model. The separate oracle
// still records immutable transaction evidence and land events; no authored metadata is changed.
async function reconcileTerminalStatuses(pool, proposals) {
    const observations = proposals.filter(isSolanaMinted)
        .filter(proposal => ['Executed', 'Cancelled', 'Expired'].includes(proposal.onchainLifecycleStatus))
        .map(proposal => ({ account: proposalAccount(proposal), status: proposal.onchainLifecycleStatus }));
    if (!observations.length) return 0;
    const result = await pool.query(`
        UPDATE proposal p
        SET lifecycle_status = observed.status,
            updated_at = now()
        FROM jsonb_to_recordset($1::jsonb) AS observed(account text, status text)
        WHERE p.onchain_data->>'proposalId' = observed.account
          AND COALESCE(p.onchain_data->>'chainId', 'solana-devnet') = 'solana-devnet'
          AND COALESCE(p.onchain_data->>'chainType', 'solana') = 'solana'
          AND p.lifecycle_status IS DISTINCT FROM observed.status
        RETURNING p.id
    `, [JSON.stringify(observations)]);
    return result.rowCount;
}

export async function refreshProposalStatuses(proposals, connection, { env = process.env, pool = null, log = () => {} } = {}) {
    const minted = (proposals || []).filter(isSolanaMinted);
    if (!minted.length) return proposals;
    const accounts = minted.map(proposal => new PublicKey(proposalAccount(proposal)));
    const infos = await getMultipleAccountsBatched(connection, accounts, { batchSize: accountsPerRequest(env) });
    applyProposalStatuses(proposals, infos);
    if (pool) {
        const reconciled = await reconcileTerminalStatuses(pool, minted);
        if (reconciled) log(`OK reconciled ${reconciled} proposal lifecycle(s) from confirmed on-chain state`);
    }
    return proposals;
}
