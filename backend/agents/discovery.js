// Read ordinary proposal summaries and minted named plans for society/supporter policies.
// A named plan is a policy input identified in its own namespace; its row IDs remain member IDs.

import { createHash } from 'node:crypto';
import { effectiveLifecycleStatus } from '../proposals/lifecycle.js';
import { isSolanaMinted } from './supporter-picker.js';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { decodeProposalState, PROPOSAL_PROGRAM_ID } from './lifecycle-actions.js';

export const SUMMARY_PAGE = 1000;
export const MAX_DISCOVERED = 3000;
export const BATCH_SIZE = 1000;
const CHAIN_STATUS = ['Active', 'Executed', 'Cancelled', 'Expired'];
const PROPOSAL_DISCRIMINATOR = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);

function key(proposal) {
    return String(proposal.proposalId || proposal.id);
}

function proposalAccount(proposal) {
    return proposal.onchain?.proposalId || proposal.onchain?.proposalAccount
        || proposal.proposalAccount || proposal.onchainData?.proposalId || null;
}

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
    const pages = await Promise.all(cities.map(async city => {
        const [proposals, listed] = await Promise.all([
            summaries(apiBase, city, fetchJson, log),
            fetchJson(`${apiBase}/plans${city ? `?city=${encodeURIComponent(city)}` : ''}`)
        ]);
        return { proposals, plans: listed.plans || [] };
    }));

    const byId = new Map();
    pages.flatMap(page => page.proposals).forEach(proposal => byId.set(key(proposal), proposal));
    const plansBySlug = new Map();
    pages.flatMap(page => page.plans).forEach(plan => {
        if (!plansBySlug.has(String(plan.slug))) plansBySlug.set(String(plan.slug), plan);
    });
    const plans = Array.from(plansBySlug.values());
    const details = await Promise.all(plans.filter(plan => {
        const chainId = plan.onchain?.chainId;
        return proposalAccount(plan) && (chainId === undefined || chainId === null || /^solana/i.test(String(chainId)));
    }).map(async plan => {
        try {
            const detail = await fetchJson(`${apiBase}/plans/${encodeURIComponent(plan.slug)}`);
            const members = detail.members || [];
            const listedIds = (plan.proposalRowIds || []).map(String);
            const detailIds = (detail.proposalRowIds || []).map(String);
            const memberIds = members.map(member => String(member.proposalRowId ?? ''));
            const reason = members.some(member => member.missing) ? 'member missing'
                : members.some(member => member.changed) ? 'member changed'
                    : !listedIds.length || !detailIds.length ? 'membership unavailable'
                    : members.length !== detailIds.length || listedIds.length !== detailIds.length
                        || listedIds.some((id, index) => id !== detailIds[index])
                        || detailIds.some((id, index) => id !== memberIds[index]) ? 'membership changed' : null;
            if (reason) {
                log(`named plan ${plan.slug}: excluded (${reason})`);
                return null;
            }
            return { ...plan, ...detail };
        } catch (error) {
            throw new Error(`named plan ${plan.slug} detail request failed: ${error.message}`, { cause: error });
        }
    }));

    const acceptedPlans = details.filter(Boolean).map(plan => ({
        id: `plan:${plan.slug}`,
        proposalId: `plan:${plan.slug}`,
        planSlug: plan.slug,
        planHash: plan.planHash,
        goal: 'plan',
        lifecycleStatus: 'Active',
        author: plan.author || null,
        title: plan.title || plan.slug,
        name: plan.title || plan.slug,
        createdAt: plan.createdAt || null,
        onchain: { ...(plan.onchain || {}), proposalId: proposalAccount(plan) },
        proposalRowIds: (plan.proposalRowIds || []).map(String),
        planMembers: plan.members || []
    }));

    // Never surface two policy choices backed by one Solana account. Ordinary proposal summaries
    // own the account when a plan and proposal happen to reference the same one.
    for (const plan of acceptedPlans) {
        if (byId.has(plan.proposalId)) throw new Error(`proposal identifier collision with named plan ${plan.planSlug}: ${plan.proposalId}`);
    }
    const usedAccounts = new Set(Array.from(byId.values()).map(proposalAccount).filter(Boolean).map(String));
    for (const plan of acceptedPlans) {
        const account = String(proposalAccount(plan));
        if (usedAccounts.has(account)) {
            log(`named plan ${plan.planSlug}: excluded (Solana account already represented)`);
            continue;
        }
        usedAccounts.add(account);
        byId.set(plan.proposalId, plan);
    }
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
        const label = proposal.planSlug ? `named plan ${proposal.planSlug}` : `proposal ${key(proposal)}`;
        const info = infos[index];
        if (!info?.data) throw new Error(`${label} chain account ${proposalAccount(proposal)} is missing`);
        if (!info.owner || !new PublicKey(info.owner).equals(expectedOwner)) {
            throw new Error(`${label} chain account is not owned by the proposal program`);
        }
        if (!Buffer.from(info.data).subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
            throw new Error(`${label} chain account is not a Proposal account`);
        }
        const state = decodeState(info.data);
        if (proposal.planSlug && (!proposal.planHash || state.imageUri !== `ugt-plan:${proposal.planSlug}@${proposal.planHash}`)) {
            throw new Error(`${label} chain account does not commit to its current content`);
        }
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

// Load plan members in one bounded batch request per 1000 rows; ordinary records continue to use
// their canonical GET route. Geometry is aggregated as source evidence for density policies.
export async function loadPlanRecord({ apiBase, plan, fetchJson }) {
    const ids = (plan.proposalRowIds || []).map(String);
    const items = [];
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        const response = await fetchJson(`${apiBase}/proposals/batch`, {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids: ids.slice(offset, offset + BATCH_SIZE) })
        });
        items.push(...(response.items || []));
    }
    const records = new Map(items.filter(item => item.proposal).map(item => [String(item.id), item.proposal]));
    const missing = ids.filter(id => !records.has(id));
    if (missing.length) throw new Error(`${missing.length} named-plan member record(s) unavailable`);
    const buildings = [];
    for (const id of ids) {
        const geometry = records.get(id)?.geometry;
        const members = Array.isArray(geometry?.buildings) ? geometry.buildings : [];
        const parameters = records.get(id)?.buildingProposal?.parameters || {};
        for (const building of members) {
            const properties = { ...(building.properties || {}) };
            if (properties.floors === undefined && parameters.floors !== undefined) properties.floors = parameters.floors;
            if (properties.height === undefined && parameters.height !== undefined) properties.height = parameters.height;
            buildings.push({ ...building, properties, sourceProposalRowId: id });
        }
    }
    return {
        id: plan.id, proposalId: plan.proposalId, goal: 'plan', title: plan.title,
        planSlug: plan.planSlug,
        geometry: { buildings },
        evidence: { sourceProposalRowIds: ids, buildingCount: buildings.length }
    };
}
