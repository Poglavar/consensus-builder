// Server side of the proposal footprint: which cadastral parcels a proposal's own geometry lies on.
// The parts come from the shared pure builder (frontend/js/proposals/footprint-parts.js, the same
// one the browser publish gate uses); PostGIS unions them and measures each parcel's overlap in
// EPSG:3765 metres. The strict declaration rule for new records (declared == binding) lives in
// binding.js.

import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const footprintPartsApi = requireCjs('../../frontend/js/proposals/footprint-parts.js');
const corridorOsmForm = requireCjs('../../frontend/js/corridor-osm-form.js');

export const { footprintParts, hasFootprint, MAX_FOOTPRINT_VERTICES } = footprintPartsApi;

export const INVALID_FOOTPRINT = 'invalid-footprint';

// A stored row keeps sub-proposals both in their own columns and inside proposal_data; the column
// is authoritative (the serializer reads it the same way).
export function proposalGeometryView(row) {
    const data = row && row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    const roadProposal = row?.road_proposal ?? data.roadProposal;
    return {
        ...data,
        // The row holds the record (roads.md §11); the land is built from its decoded stretches.
        roadProposal: roadProposal?.definition && typeof roadProposal.definition === 'object'
            ? { ...roadProposal, definition: corridorOsmForm.toView(roadProposal.definition) }
            : roadProposal,
        buildingProposal: row?.building_proposal ?? data.buildingProposal,
        structureProposal: row?.structure_proposal ?? data.structureProposal,
        reparcellization: row?.reparcellization ?? data.reparcellization
    };
}

export function footprintQueryParams(parts) {
    const lines = parts.centerline
        ? parts.centerline.segments.map(coordinates => ({
            line: { type: 'LineString', coordinates },
            halfWidthM: parts.centerline.halfWidthM
        }))
        : [];
    return [JSON.stringify(parts.polygons), JSON.stringify(lines)];
}
