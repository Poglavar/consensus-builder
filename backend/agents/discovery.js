// Read ordinary proposal summaries and minted named plans for society/supporter policies.
// A named plan is a policy input identified in its own namespace; its row IDs remain member IDs.

import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { decodeProposalState, PROPOSAL_PROGRAM_ID } from './lifecycle-actions.js';
import { proposalAccountOf } from '../markets/contests.js';

export const SUMMARY_PAGE = 1000;
export const MAX_DISCOVERED = 3000;
export const BATCH_SIZE = 1000;
const CHAIN_STATUS = ['Active', 'Executed', 'Cancelled', 'Expired'];

function key(proposal) {
    const id = typeof proposal?.proposalId === 'string' ? proposal.proposalId.trim() : '';
    if (!id || /^[0-9]+$/.test(id)) throw new Error('proposal summary is missing its non-numeric authored proposalId');
    return id;
}

const proposalAccount = proposal => proposalAccountOf(proposal?.onchain);
const ROW_ID = /^[0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function verifiedPlanMembership(listed, detail) {
    const listedIds = listed?.proposalRowIds;
    const detailIds = detail?.proposalRowIds;
    const members = detail?.members;
    if (!Array.isArray(listedIds) || !Array.isArray(detailIds) || !Array.isArray(members)
        || !listedIds.length || !listedIds.every(id => typeof id === 'string' && ROW_ID.test(id))
        || new Set(listedIds).size !== listedIds.length) return 'membership unavailable';
    if (!detailIds.every(id => typeof id === 'string' && ROW_ID.test(id))
        || members.some(member => !member || member.missing || member.changed)) {
        return members.some(member => member?.missing) ? 'member missing'
            : members.some(member => member?.changed) ? 'member changed' : 'membership malformed';
    }
    const memberIds = members.map(member => member.proposalRowId);
    if (listedIds.length !== detailIds.length || detailIds.length !== memberIds.length
        || listedIds.some((id, index) => id !== detailIds[index] || id !== memberIds[index])) return 'membership changed';
    if (typeof listed.planHash !== 'string' || !SHA256.test(listed.planHash)
        || detail.planHash !== listed.planHash) return 'commitment unavailable';
    const listedAccount = proposalAccount(listed);
    const detailAccount = proposalAccount(detail);
    if (!listedAccount || listedAccount !== detailAccount) return 'chain account changed';
    return null;
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
        return Boolean(proposalAccount(plan));
    }).map(async plan => {
        try {
            const detail = await fetchJson(`${apiBase}/plans/${encodeURIComponent(plan.slug)}`);
            const reason = detail.slug !== plan.slug ? 'plan identity changed' : verifiedPlanMembership(plan, detail);
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
        lifecycleStatus: 'Unknown',
        author: plan.author || null,
        title: plan.title || plan.slug,
        name: plan.title || plan.slug,
        createdAt: plan.createdAt || null,
        onchain: plan.onchain,
        proposalRowIds: (plan.proposalRowIds || []).map(String),
        planMembers: plan.members || []
    }));

    // Never surface two policy choices backed by one Solana account. Ordinary proposal summaries
    // own the account when a plan and proposal happen to reference the same one.
    for (const plan of acceptedPlans) {
        if (byId.has(plan.proposalId)) throw new Error(`proposal identifier collision with named plan ${plan.planSlug}: ${plan.proposalId}`);
    }
    const usedAccounts = new Set(Array.from(byId.values()).map(proposalAccount).filter(Boolean));
    for (const plan of acceptedPlans) {
        const account = proposalAccount(plan);
        if (usedAccounts.has(account)) {
            log(`named plan ${plan.planSlug}: excluded (Solana account already represented)`);
            continue;
        }
        usedAccounts.add(account);
        byId.set(plan.proposalId, plan);
    }
    return Array.from(byId.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function applyPlanStatuses(proposals, infos, { decodeState = decodeProposalState, programId = PROPOSAL_PROGRAM_ID } = {}) {
    const plans = (proposals || []).filter(proposal => proposal.planSlug);
    if (infos.length !== plans.length) throw new Error(`received ${infos.length} chain states for ${plans.length} named plans`);
    const expectedOwner = new PublicKey(programId);
    plans.forEach((plan, index) => {
        const info = infos[index];
        if (!info?.data) throw new Error(`named plan ${plan.planSlug} chain account ${proposalAccount(plan)} is missing`);
        if (!info.owner || !new PublicKey(info.owner).equals(expectedOwner)) {
            throw new Error(`named plan ${plan.planSlug} chain account is not owned by the proposal program`);
        }
        const state = decodeState(info.data);
        if (!plan.planHash || state.imageUri !== `ugt-plan:${plan.planSlug}@${plan.planHash}`) {
            throw new Error(`named plan ${plan.planSlug} chain account does not commit to its current content`);
        }
        if (!Number.isInteger(state?.status) || state.status < 0 || state.status >= CHAIN_STATUS.length) {
            throw new Error(`named plan ${plan.planSlug} has invalid on-chain status ${state?.status}`);
        }
        plan.lifecycleStatus = CHAIN_STATUS[state.status];
    });
    return proposals;
}

export async function refreshNamedPlanStatuses(proposals, connection, env = process.env) {
    const plans = (proposals || []).filter(proposal => proposal.planSlug);
    if (!plans.length) return proposals;
    const accounts = plans.map(plan => new PublicKey(proposalAccount(plan)));
    const infos = await getMultipleAccountsBatched(connection, accounts, { batchSize: accountsPerRequest(env) });
    return applyPlanStatuses(proposals, infos);
}

// Load plan members in one bounded batch request per 1000 rows; ordinary records continue to use
// their canonical GET route. Geometry is aggregated as source evidence for density policies.
export async function loadPlanRecord({ apiBase, plan, fetchJson }) {
    const ids = (plan.proposalRowIds || []).map(String);
    if (!ids.length || ids.some(id => !ROW_ID.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error(`named plan ${plan.planSlug || plan.slug || '(unknown)'} has invalid database row membership`);
    }
    const items = [];
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        const response = await fetchJson(`${apiBase}/proposals/batch`, {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids: ids.slice(offset, offset + BATCH_SIZE) })
        });
        items.push(...(response.items || []));
    }
    const records = new Map();
    for (const item of items) {
        const id = String(item?.id ?? '');
        if (!ids.includes(id)) throw new Error(`named-plan batch returned an unrequested row ID ${id || '(empty)'}`);
        if (item.proposal) {
            if (String(item.proposal.id) !== id) throw new Error(`named-plan batch row identity mismatch for ${id}`);
            records.set(id, item.proposal);
        }
    }
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
