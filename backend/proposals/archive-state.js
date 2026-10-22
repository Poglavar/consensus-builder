// The local-state strip of authored proposal records and the archive form of a reconstruction: what a
// record keeps when it leaves a browser or a database (no applied or local state, no runtime approval
// claims, no source-database identities). Shared by the reconstruction archive codecs
// (reconstruction-geojson.js and its corridor and structure variants) and the proposal row serializer.
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const proposalOrigin = requireCjs('../../frontend/js/proposals/origin.js');
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');
const sourceProposal = requireCjs('../../frontend/js/planning/source-proposal.js');

const LOCAL_STATE_SUB_KEYS = Object.freeze([
    'roadProposal',
    'buildingProposal',
    'structureProposal',
    'reparcellization'
]);

// A stored row that violates the flat-record contract is a data error, not a server fault. Routes
// map this code to 422 with the reason, and list routes skip the row and report it, so one
// unmigrated record never turns a whole plan or city list into "HTTP 500".
export const PROPOSAL_RECORD_INVALID = 'proposal-record-invalid';
// What a person is told. The technical reason (which field, which id) is on `error.detail` for
// logs and the console; it means nothing to a visitor opening an old share link.
export const PROPOSAL_RECORD_INVALID_MESSAGE =
    'This proposal was made with an older version of the site and can no longer be opened.';

export function invalidRecord(detail) {
    const error = new Error(PROPOSAL_RECORD_INVALID_MESSAGE);
    error.code = PROPOSAL_RECORD_INVALID;
    error.status = 422;
    error.detail = detail;
    return error;
}

const clearRoadDemolition = definition => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return;
    delete definition.surfaceFootprint;
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
};

export function stripLocalProposalState(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
    // Authored designs may pin a source revision; serialization must never follow the latest
    // cache value and silently replace that reference or treat its authority as owner consent.
    sourceProposal.validateReferences(proposal.sourceReferences);
    const sanitized = JSON.parse(JSON.stringify(proposal));
    [
        'applied', 'appliedAt', 'localPurchaseSimulation', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        // No current producer verifies an execution-event time. Observation/receipt times stay
        // in their qualified evidence records; this client field is not that evidence.
        'executedAt', 'publicationApiBase', 'lifecycleEvidence', 'proposalDraftId', 'proposalDraftRevision',
        // These identifiers belong to this browser's agent/draft state, not the published record.
        'authorAgentId',
        'sourceProposalId', 'replacementOfProposalId', 'copiedFromProposalId', 'copiedFromName',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'formation', 'demolishedBuildings', 'demolitionScanned', 'parcelSourceId',
        // Approval configuration is authored content and survives publication. Approval
        // decisions and authority workflow state are runtime claims from one client and never do.
        'ownerApprovals', 'ownerApprovalHistory', 'approvalState', 'approvalRuntimeState',
        'authorityApprovals', 'authorityApprovalHistory', 'authorityState', 'authorityRuntimeState',
        'acceptedParcelIds', 'ownerAcceptances'
    ].forEach(key => delete sanitized[key]);
    // An origin names a local key or a design CID (proposals/origin.js); one naming a server row of
    // this table predates M2, so the record refuses by name like any other older-version record.
    if (sanitized.proposalOrigin) {
        try {
            sanitized.proposalOrigin = proposalOrigin.portable(sanitized.proposalOrigin);
        } catch (error) {
            throw invalidRecord(`Invalid proposal record: proposalOrigin: ${error.message}`);
        }
    }
    delete sanitized.childFeatures;

    if (sanitized.geometry && typeof sanitized.geometry === 'object') {
        // Architectural evidence is owned by the building registry and joined by read routes.
        // Saving an API response or a copied proposal must not persist a stale model snapshot.
        for (const building of sanitized.geometry.buildings || []) {
            if (!building.properties) continue;
            delete building.properties.floorPlans;
            delete building.properties.floorModel;
        }
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

// Reconstruction archives are portable authored records, not API rows or browser snapshots.
// Keep the authored metadata sanitizer above, then remove identities that only make sense in the
// source database and paid-agent claim projection (a verified mirror can carry its own provenance).
export function stripProposalArchiveState(proposal) {
    const sanitized = stripLocalProposalState(proposal);
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;
    delete sanitized.id;
    delete sanitized.serverProposalId;
    delete sanitized.agent;
    return sanitized;
}
