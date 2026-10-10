// A corrected version of a UPU Borovje member (rekonstrukcije/upu-borovje/snap-to-cadastre.mjs for v2,
// fit-streets.mjs for v3): the record it revises with the committed geometry replayed onto it, under a new
// proposal id `<base id>-v<version>`. Pure: record and change in, record out. The cadastral declaration is
// left to the target backend, which binds the new site.

export const REPAIR_VERSION = 'borovje-cadastral-snap-v1';
export const VERSION_SUFFIX = '-v2';

// `p-x` → `p-x-v3`; `p-x-v2` → `p-x-v3`.
export const versionedId = (proposalId, version) => `${String(proposalId).replace(/-v\d+$/, '')}-v${version}`;

export const multi = geometry => (geometry.type === 'MultiPolygon' ? geometry : { type: 'MultiPolygon', coordinates: [geometry.coordinates] });
// Fields the server owns or derives; a new record must not carry the original's.
const SERVER_FIELDS = ['id', 'proposal_id', 'createdAt', 'updatedAt', 'binding', 'parcelSet', 'screenshotUrl', 'epochYear',
    'cadastreParcelIds', 'acceptedParcelIds', 'ownershipFlow', 'cadastreFrame', 'decayEnabled', 'depositEnabled', 'isConditional'];

// The corrected record, without its cadastral declaration (the target backend binds the new site).
export function revisedRecord(original, change, { version = 2, repair = REPAIR_VERSION } = {}) {
    const record = structuredClone(original);
    for (const field of SERVER_FIELDS) delete record[field];
    record.revisionOf = original.proposalId;
    record.proposalId = versionedId(original.proposalId, version);
    record.reconstructionRepair = repair;
    record.toleranceM = 0;
    if (change.plots) {
        const polygons = record.reparcellization.polygons.map(polygon => {
            const plot = change.plots[polygon.ownerKey];
            if (!plot) throw new Error(`${original.proposalId}: no corrected plot ${polygon.ownerKey}`);
            return { ...polygon, geometry: plot.geometry, area: Number(plot.m2.toFixed(1)) };
        });
        const totalArea = Number(polygons.reduce((sum, polygon) => sum + polygon.area, 0).toFixed(1));
        for (const polygon of polygons) polygon.percent = Number((100 * polygon.area / totalArea).toFixed(2));
        record.reparcellization = { ...record.reparcellization, polygons, totalArea,
            poolGeometry: record.reparcellization.poolGeometry?.type === 'Feature'
                ? { ...record.reparcellization.poolGeometry, geometry: change.pool } : change.pool };
        record.site = multi(change.pool);
    }
    if (change.polygon) {
        const definition = record.roadProposal.definition;
        definition.polygon = change.polygon;
        if (change.segments) {
            // points and segments are the same polylines (road-drawing.js keeps them so); a segment added
            // by the correction (a narrowed stretch) comes with its id and profile.
            definition.segments = structuredClone(change.segments);
            definition.points = structuredClone(change.segments);
            if (change.segmentIds) definition.segmentIds = [...change.segmentIds];
            if (change.segmentProfiles) definition.segmentProfiles = structuredClone(change.segmentProfiles);
            if (definition.segmentIds.length !== definition.segments.length
                || definition.segmentIds.some(id => !definition.segmentProfiles[id])) {
                throw new Error(`${original.proposalId}: every corrected segment needs an id and a profile`);
            }
        }
        record.site = multi(change.polygon);
    }
    if (change.geometry) {
        const structure = record.structureProposal;
        structure.geometry = structure.geometry?.type === 'Feature' ? { ...structure.geometry, geometry: change.geometry } : change.geometry;
        record.site = multi(change.geometry);
    }
    return record;
}
