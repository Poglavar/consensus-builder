import { effectiveLifecycleStatus } from './lifecycle.js';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');

const LOCAL_STATE_SUB_KEYS = Object.freeze([
    'roadProposal',
    'buildingProposal',
    'structureProposal',
    'reparcellization',
    'decideLaterProposal'
]);

const present = value => value !== undefined && value !== null;
const owns = (value, key) => value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key);
const choose = (databaseValue, fallbackValue) => present(databaseValue) ? databaseValue : fallbackValue;
const iso = (value, fallback) => present(value)
    ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString())
    : fallback;

export function isDerivedParcelDeclaration(value) {
    return authoredRecord.isDerivedParcelId(value);
}

export function findNonCadastralParentDeclaration(proposal) {
    return authoredRecord.findNonCadastralReference(proposal);
}

export function findLegacyCadastreDeclaration(proposal) {
    const declarations = typeof authoredRecord.legacyCadastreDeclarations === 'function'
        ? authoredRecord.legacyCadastreDeclarations(proposal)
        : [];
    return declarations[0] || null;
}

function sameIdSet(left, right) {
    if (left.length !== right.length) return false;
    const expected = new Set(left.map(String));
    return right.every(id => expected.has(String(id)));
}

// A stored row that violates the flat-record contract is a data error, not a server fault. Routes
// map this code to 422 with the reason, and list routes skip the row and report it, so one
// unmigrated record never turns a whole plan or city list into "HTTP 500".
export const PROPOSAL_RECORD_INVALID = 'proposal-record-invalid';

function invalidRecord(message) {
    const error = new Error(message);
    error.code = PROPOSAL_RECORD_INVALID;
    error.status = 422;
    return error;
}

export function isInvalidRecordError(error) {
    return !!error && error.code === PROPOSAL_RECORD_INVALID;
}

export function assertCanonicalProposalRow(row) {
    // Summary projections do not contain the full record. Full-row serializers do, and reject a
    // broken durable record instead of quietly manufacturing a usable proposal from it.
    if (!owns(row, 'cadastre_parcel_ids')) return;
    const ids = row.cadastre_parcel_ids;
    if (!Array.isArray(ids) || !ids.length) {
        throw invalidRecord('Invalid proposal record: cadastre_parcel_ids is required.');
    }
    const normalizedIds = ids.map(value => typeof value === 'string' ? value : '');
    if (normalizedIds.some((id, index) => !id || id !== id.trim() || id !== ids[index])
        || new Set(normalizedIds).size !== normalizedIds.length) {
        throw invalidRecord('Invalid proposal record: cadastre_parcel_ids must contain unique non-empty strings.');
    }
    const generated = ids.find(isDerivedParcelDeclaration);
    if (generated) {
        throw invalidRecord(`Invalid proposal record: cadastre_parcel_ids contains generated id ${generated}.`);
    }
    const raw = row.proposal_data && typeof row.proposal_data === 'object'
        ? row.proposal_data
        : {};
    const candidate = {
        ...raw,
        cadastreParcelIds: ids,
        acceptedParcelIds: row.accepted_parcel_ids ?? raw.acceptedParcelIds,
        ownerAcceptances: row.owner_acceptances ?? raw.ownerAcceptances,
        ownershipFlow: row.ownership_flow ?? raw.ownershipFlow,
        roadProposal: row.road_proposal ?? raw.roadProposal,
        buildingProposal: row.building_proposal ?? raw.buildingProposal,
        structureProposal: row.structure_proposal ?? raw.structureProposal,
        reparcellization: row.reparcellization ?? raw.reparcellization
    };
    const legacy = findLegacyCadastreDeclaration(candidate);
    if (legacy) {
        throw invalidRecord(`Invalid proposal record: ${legacy.path} is a retired parcel declaration.`);
    }
    if (owns(raw, 'cadastreParcelIds')
        && (!Array.isArray(raw.cadastreParcelIds) || !sameIdSet(ids, raw.cadastreParcelIds))) {
        throw invalidRecord('Invalid proposal record: proposal_data.cadastreParcelIds conflicts with cadastre_parcel_ids.');
    }
    const reference = findNonCadastralParentDeclaration(candidate);
    if (reference) {
        throw invalidRecord(`Invalid proposal record: ${reference.path} lies outside cadastreParcelIds.`);
    }
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
    [
        'applied', 'appliedAt', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'formation', 'demolishedBuildings', 'demolitionScanned'
    ].forEach(key => delete sanitized[key]);
    delete sanitized.childFeatures;

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
        delete sub.childFeatures;
        clearRoadDemolition(sub.definition);
    });
    if (sanitized.roadProposal) {
        delete sanitized.definition;
        delete sanitized.roadProposal.roadGeometry;
    }
    return authoredRecord.stripCadastreAliases(
        authoredRecord.cleanFeatureContainers(sanitized)
    );
}

export function serializeProposalRow(row, options = {}) {
    assertCanonicalProposalRow(row);
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
    // One durable land relationship: the exact authored cadastral selection.
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
