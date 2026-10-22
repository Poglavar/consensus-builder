import { effectiveLifecycleStatus } from './lifecycle.js';
import { buildParcelSet } from './parcel-set.js';
import { createRequire } from 'node:module';

import { PROPOSAL_RECORD_INVALID, invalidRecord, stripLocalProposalState } from './archive-state.js';

const requireCjs = createRequire(import.meta.url);
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');
const lifecycleEvidence = requireCjs('../../frontend/js/proposals/lifecycle-evidence.js');

const isPolygonGeometry = value => !!value && typeof value === 'object'
    && (value.type === 'Polygon' || value.type === 'MultiPolygon') && Array.isArray(value.coordinates);


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



export function isInvalidRecordError(error) {
    return !!error && error.code === PROPOSAL_RECORD_INVALID;
}

export function assertCanonicalProposalRow(row) {
    // Summary projections do not contain the full record. Full-row serializers do, and reject a
    // broken durable record instead of quietly manufacturing a usable proposal from it.
    if (!owns(row, 'cadastre_parcel_ids')) return;
    const ids = row.cadastre_parcel_ids;
    if (!Array.isArray(ids)) {
        throw invalidRecord('Invalid proposal record: cadastre_parcel_ids is required.');
    }
    const raw = row.proposal_data && typeof row.proposal_data === 'object'
        ? row.proposal_data
        : {};
    if (!ids.length) {
        // An empty declaration is valid only for a material proposal that carries its site (the
        // column, when the query selected it, or the record's own copy) — PARCEL-OPTIONAL.md.
        const hasSite = present(row.site) || isPolygonGeometry(raw.site);
        if (!hasSite) {
            throw invalidRecord('Invalid proposal record: cadastre_parcel_ids is required.');
        }
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




export function projectProposalLifecycleEvidence({ lifecycleStatus, chainMirror, lifecycleEvent, expiresAt, now } = {}) {
    return lifecycleEvidence.projectLifecycleEvidence({
        lifecycleStatus, chainMirror, lifecycleEvent, expiresAt, now
    });
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
    // The lifecycle column owns this fact. Missing/invalid state cannot be repaired from an older
    // authored JSON projection or inferred from a deadline.
    proposal.lifecycleStatus = effectiveLifecycleStatus(
        row.effective_status ?? row.lifecycle_status, row.expires_at, options.now);

    proposal.offer = present(row.offer) ? Number(row.offer) : proposal.offer;
    proposal.offerCurrency = choose(row.offer_currency, proposal.offerCurrency);
    proposal.budget = present(row.budget) ? Number(row.budget) : proposal.budget;
    proposal.budgetCurrency = choose(row.budget_currency, proposal.budgetCurrency);
    proposal.createdAt = iso(row.created_at, proposal.createdAt);
    proposal.expiresAt = iso(row.expires_at, proposal.expiresAt);
    proposal.updatedAt = iso(row.updated_at, proposal.updatedAt);
    proposal.decayEnabled = choose(row.decay_enabled, proposal.decayEnabled);
    proposal.decayPercent = choose(row.decay_percent, proposal.decayPercent);
    // pg returns BIGINT as text; the authored deal and its commitment use a finite duration number.
    proposal.decayDurationMs = present(row.decay_duration_ms) ? Number(row.decay_duration_ms) : proposal.decayDurationMs;
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
    // The proposal's ground and the server binding fixed at publish (PARCEL-OPTIONAL.md). The site
    // is served from the record (the geometry column exists for spatial queries, not transport).
    proposal.site = proposal.site ?? null;
    proposal.binding = choose(row.binding, proposal.binding ?? null);
    proposal.parcelSet = buildParcelSet({
        parcelIds: proposal.cadastreParcelIds || [],
        parcelSource: proposal.binding?.parcelSource ?? null
    });
    proposal.roadProposal = choose(row.road_proposal, proposal.roadProposal);
    proposal.buildingProposal = choose(row.building_proposal, proposal.buildingProposal);
    proposal.structureProposal = choose(row.structure_proposal, proposal.structureProposal);
    proposal.reparcellization = choose(row.reparcellization, proposal.reparcellization);
    proposal.lens = choose(row.lens, proposal.lens);
    proposal.bounds = choose(row.bounds, proposal.bounds);
    // Chain attachment is a server-owned projection. An absent/NULL column cannot resurrect a
    // stale location from authored JSON, and the API exposes exactly one representation.
    proposal.onchain = row.onchain_data ?? null;
    delete proposal.onchainData;
    proposal.screenshotUrl = row.screenshot_url
        ?? row.onchain_data?.imageUrl
        ?? proposal.screenshotUrl
        ?? null;
    // Epoch bucket ("Kumulativno do godine" timeline). Shared state, not local:
    // which decade a proposal belongs to is a property of the plan, not of one
    // browser's applied view.
    proposal.epochYear = present(row.epoch_year) ? Number(row.epoch_year) : (proposal.epochYear ?? null);
    // The paid-agent stamp is only true of a row that carries a settled x402 payment. Rows written
    // through the free route before it stopped accepting `agent` may still hold a client-made one;
    // when the query selected agent_payment_id, an unpaid row's stamp is not served.
    if (Object.prototype.hasOwnProperty.call(row, 'agent_payment_id') && !present(row.agent_payment_id)) {
        delete proposal.agent;
    }
    // Server-held provenance of fields a migration retired (scripts/migrate-legacy-parcel-
    // declarations.mjs). It stays in the row so the migration is reversible, but it is not part
    // of the proposal and must never be served, forked or re-published by a client.
    delete proposal.legacy;
    // The chain-mirror projection (rebuilding a mirrored row from its chain record) went with the
    // mirror's read side in M3: these read-only rows serve as stored until the proposal table is dropped.

    const projection = projectProposalLifecycleEvidence({
        lifecycleStatus: proposal.lifecycleStatus,
        chainMirror: proposal.chainMirror,
        lifecycleEvent: row.lifecycle_event ?? null,
        expiresAt: proposal.expiresAt,
        now: options.now
    });
    const serialized = stripLocalProposalState(proposal);
    serialized.lifecycleEvidence = projection.lifecycleEvidence;
    return serialized;
}
