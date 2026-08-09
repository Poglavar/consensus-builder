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

const LEGACY_DERIVED_PARCEL = /^HR-\d+-.+?_[a-z0-9]+_\d+$/i;

export function isDerivedParcelDeclaration(value) {
    const id = String(value ?? '');
    return id.includes('#') || LEGACY_DERIVED_PARCEL.test(id);
}

export function findNonCadastralParentDeclaration(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return null;
    const lists = [
        ['parentParcelIds', proposal.parentParcelIds],
        ['parcelIds', proposal.parcelIds],
        ['cadastreParcelIds', proposal.cadastreParcelIds]
    ];
    LOCAL_STATE_SUB_KEYS.forEach(key => {
        const sub = proposal[key];
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
        lists.push([`${key}.parentParcelIds`, sub.parentParcelIds]);
        if (key === 'reparcellization') lists.push([`${key}.parcelIds`, sub.parcelIds]);
    });
    for (const [path, values] of lists) {
        if (!Array.isArray(values)) continue;
        const id = values.find(isDerivedParcelDeclaration);
        if (id !== undefined) return { path, id: String(id) };
    }
    return null;
}

const clearRoadDemolition = definition => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return;
    delete definition.surfaceFootprint;
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
};

export function stripLocalProposalState(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
    const sanitized = JSON.parse(JSON.stringify(proposal));
    const governmentPlan = sanitized.tags?.governmentPlan === true
        || sanitized.roadProposal?.definition?.kind === 'government_plan';

    [
        'applied', 'appliedAt', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'formation', 'demolishedBuildings', 'demolitionScanned'
    ].forEach(key => delete sanitized[key]);
    if (!governmentPlan) delete sanitized.childFeatures;

    if (sanitized.geometry && typeof sanitized.geometry === 'object') {
        delete sanitized.geometry.parentFeatures;
        delete sanitized.geometry.childFeatures;
        if (sanitized.roadProposal) {
            delete sanitized.geometry.roadPlan;
            delete sanitized.geometry.roadGeometry;
            if (Object.keys(sanitized.geometry).length === 0) delete sanitized.geometry;
        }
    }

    LOCAL_STATE_SUB_KEYS.forEach(key => {
        const sub = sanitized[key];
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
        delete sub.applied;
        delete sub.appliedAt;
        delete sub.status;
        delete sub.childParcelIds;
        delete sub.parentFeatures;
        delete sub.parentsToRemove;
        delete sub.formation;
        delete sub.demolishedBuildings;
        delete sub.demolitionScanned;
        if (!(key === 'roadProposal' && governmentPlan)) delete sub.childFeatures;
        clearRoadDemolition(sub.definition);
    });
    if (sanitized.roadProposal) {
        delete sanitized.definition;
        delete sanitized.roadProposal.roadGeometry;
    }
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
    // The CADASTRAL parcels the geometry covers. Unlike ancestor_parcel_ids these are never derived
    // ids, so they mean the same thing on every machine. See rethink-proposals.md.
    proposal.cadastreParcelIds = choose(row.cadastre_parcel_ids, proposal.cadastreParcelIds ?? null);
    // Publish-time stamps of the formation's ownership flow and the cadastre frame it was measured
    // against (rethink-proposals.md §9/§12 step 2, D5).
    proposal.ownershipFlow = choose(row.ownership_flow, proposal.ownershipFlow ?? null);
    proposal.cadastreFrame = choose(row.cadastre_frame, proposal.cadastreFrame ?? null);
    proposal.acceptedParcelIds = choose(row.accepted_parcel_ids, proposal.acceptedParcelIds);
    proposal.ownerAcceptances = choose(row.owner_acceptances, proposal.ownerAcceptances);
    proposal.roadProposal = choose(row.road_proposal, proposal.roadProposal);
    proposal.buildingProposal = choose(row.building_proposal, proposal.buildingProposal);
    proposal.structureProposal = choose(row.structure_proposal, proposal.structureProposal);
    proposal.reparcellization = choose(row.reparcellization, proposal.reparcellization);
    proposal.lens = choose(row.lens, proposal.lens);
    proposal.bounds = choose(row.bounds, proposal.bounds);
    proposal.onchain = choose(row.onchain_data, proposal.onchain);
    proposal.onchainData = choose(row.onchain_data, proposal.onchainData);
    proposal.screenshotUrl = row.screenshot_url
        ?? row.onchain_data?.imageUrl
        ?? proposal.screenshotUrl
        ?? null;
    // Epoch bucket ("Kumulativno do godine" timeline). Shared state, not local:
    // which decade a proposal belongs to is a property of the plan, not of one
    // browser's applied view.
    proposal.epochYear = present(row.epoch_year) ? Number(row.epoch_year) : (proposal.epochYear ?? null);

    return stripLocalProposalState(proposal);
}
