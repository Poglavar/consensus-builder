// The one projection seed scripts must apply before writing a proposal row directly to the database.
//
// Seeds bypass the API, whose write path runs every body through stripLocalProposalState. Without
// the same projection a seed stores retired parcel declarations (parentParcelIds, parcelIds,
// buildingProposal.parentParcelNumbers/ancestorKey, …) and the strict serializer then refuses the
// row with a 422 forever. This applies the API projection and proves the row is readable BEFORE
// anything is written, so re-running a seed can never create an unreadable record.

import { assertCanonicalProposalRow, stripLocalProposalState } from '../../proposals/serializer.js';

export function canonicalSeedRecord(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
        throw new Error('canonicalSeedRecord: proposal must be an object');
    }
    const record = stripLocalProposalState(proposal);
    const ids = Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : null;
    try {
        assertCanonicalProposalRow({
            cadastre_parcel_ids: ids,
            proposal_data: record,
            road_proposal: record.roadProposal ?? null,
            building_proposal: record.buildingProposal ?? null,
            structure_proposal: record.structureProposal ?? null,
            reparcellization: record.reparcellization ?? null
        });
    } catch (error) {
        throw new Error(`Seed proposal ${record.proposalId || '(no id)'} would be unreadable: ${error.detail || error.message}`);
    }
    return record;
}
