import { effectiveLifecycleStatus } from './lifecycle.js';

const LOCAL_STATE_SUB_KEYS = Object.freeze([
    'roadProposal',
    'buildingProposal',
    'structureProposal',
    'reparcellization',
    'decideLaterProposal'
]);

const present = value => value !== undefined && value !== null;
const choose = (databaseValue, fallbackValue) => present(databaseValue) ? databaseValue : fallbackValue;
const iso = (value, fallback) => present(value)
    ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString())
    : fallback;

export function stripLocalProposalState(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
    const sanitized = { ...proposal };
    delete sanitized.applied;
    delete sanitized.appliedAt;
    delete sanitized.status;
    LOCAL_STATE_SUB_KEYS.forEach(key => {
        const sub = sanitized[key];
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
        sanitized[key] = { ...sub };
        delete sanitized[key].applied;
        delete sanitized[key].appliedAt;
        delete sanitized[key].status;
    });
    return sanitized;
}

export function serializeProposalRow(row, options = {}) {
    const proposal = stripLocalProposalState(row?.proposal_data ? { ...row.proposal_data } : {});
    if (!row) return proposal;

    if (present(row.id)) proposal.id = row.id;
    if (present(row.proposal_id)) proposal.proposalId = row.proposal_id;
    if (present(row.city)) proposal.city = row.city;
    proposal.name = choose(row.name, proposal.name);
    proposal.title = choose(row.title, proposal.title);
    proposal.description = choose(row.description, proposal.description);
    proposal.author = choose(row.author, proposal.author);
    proposal.type = choose(row.type, proposal.type);
    proposal.lifecycleStatus = row.effective_status
        || effectiveLifecycleStatus(choose(row.lifecycle_status, proposal.lifecycleStatus), choose(row.expires_at, proposal.expiresAt), options.now);

    proposal.offer = present(row.offer) ? Number(row.offer) : proposal.offer;
    proposal.offerCurrency = choose(row.offer_currency, proposal.offerCurrency);
    proposal.budget = present(row.budget) ? Number(row.budget) : proposal.budget;
    proposal.budgetCurrency = choose(row.budget_currency, proposal.budgetCurrency);
    proposal.createdAt = iso(row.created_at, proposal.createdAt);
    proposal.expiresAt = iso(row.expires_at, proposal.expiresAt);
    proposal.updatedAt = iso(row.updated_at, proposal.updatedAt);
    proposal.decayEnabled = choose(row.decay_enabled, proposal.decayEnabled);
    proposal.decayPercent = choose(row.decay_percent, proposal.decayPercent);
    proposal.decayDurationMs = choose(row.decay_duration_ms, proposal.decayDurationMs);
    proposal.depositEnabled = choose(row.deposit_enabled, proposal.depositEnabled);
    proposal.depositPercent = choose(row.deposit_percent, proposal.depositPercent);
    proposal.isConditional = choose(row.is_conditional, proposal.isConditional);
    proposal.disbursementMode = choose(row.disbursement_mode, proposal.disbursementMode);
    proposal.parentParcelIds = choose(row.ancestor_parcel_ids, proposal.parentParcelIds ?? null);
    proposal.childParcelIds = choose(row.descendant_parcel_ids, proposal.childParcelIds ?? null);
    proposal.acceptedParcelIds = choose(row.accepted_parcel_ids, proposal.acceptedParcelIds);
    proposal.ownerAcceptances = choose(row.owner_acceptances, proposal.ownerAcceptances);
    proposal.roadProposal = choose(row.road_proposal, proposal.roadProposal);
    proposal.buildingProposal = choose(row.building_proposal, proposal.buildingProposal);
    proposal.structureProposal = choose(row.structure_proposal, proposal.structureProposal);
    proposal.reparcellization = choose(row.reparcellization, proposal.reparcellization);
    proposal.parentProposals = choose(row.parent_proposal_ids, proposal.parentProposals);
    proposal.childProposals = choose(row.child_proposal_ids, proposal.childProposals);
    proposal.lens = choose(row.lens, proposal.lens);
    proposal.bounds = choose(row.bounds, proposal.bounds);
    proposal.onchain = choose(row.onchain_data, proposal.onchain);
    proposal.onchainData = choose(row.onchain_data, proposal.onchainData);
    proposal.screenshotUrl = row.screenshot_url
        ?? row.onchain_data?.imageUrl
        ?? proposal.screenshotUrl
        ?? null;

    // Geometry blobs are deliberately not part of the proposal transport contract.
    if ('parent_features' in row) proposal.parentFeatures = null;
    if ('child_features' in row) proposal.childFeatures = null;

    return stripLocalProposalState(proposal);
}
