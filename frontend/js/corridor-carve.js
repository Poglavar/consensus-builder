// What an applied proposal does to the EXISTING buildings under it.
//
// A corridor crossing a building can end in one of three ways, and they must not collapse into
// each other: the building is DEMOLISHED (razed), it is CUT (the corridor slices a piece out and
// the rest stands), or the corridor TUNNELS beneath it (the building is untouched — the road
// passes under). This module is the one place that decides which.
//
// It is deliberately dependency-light — records + an object_id in, verdict out. No DOM, no THREE,
// no proposalStorage, and (now) no turf: the CALLER passes the proposals. That is what lets the
// same code run in the browser 3D view (three-mode.js) and on the server (backend/buildings/
// carve.js), so the app and the walk sim cannot disagree about which buildings survive.
//
// ONE DATASET, ONE KEY. Detection scans `gdi_building_footprint` (object_id) — the photogrammetric
// survey — and the meshes we render are `gdi_building_3d` (object_id), 1:1 on the same key: they
// are the footprint and mesh products of the SAME GDI feature (mean IoU 0.997). So a demolition
// record NAMES the mesh it affects, and the carve is a dictionary lookup: record.id === object_id.
//
// This is why there is no matching machinery left here. There used to be ~110 lines of it — a
// footprint-overlap identity test, a graze bar, and a dgu_gdi_building_match resolver — because
// detection scanned the DGU CADASTRE (zgrada_id) while rendering used GDI meshes (object_id): two
// different surveys of the same city, in two different key spaces, that subdivide buildings
// differently. Every one of those was a guess at "which mesh does this cadastre record mean?".
// The question no longer exists. All of it is gone.
//
// The polygon subtraction is NOT gone — it just happens once, at draw time, where it belongs:
// upsertCutRecord / splitDemolitionFootprint (corridor-tunnel.js) intersect the GDI footprint with
// the corridor and store BOTH sides on the record (`demolishedPart` and `remainder`). A cut is
// still footprint − corridor; the carve simply reads the answer instead of re-deriving it against
// a convex hull that was never the real outline anyway.

// A remainder under max(10 m², 15% of the footprint) is a sliver not worth keeping — the whole
// building reads as demolished. Applied at record-writing time (corridor-tunnel.js) and mirrored
// here only so the two files state the same rule.
const CARVE_MIN_REMAINDER_AREA_M2 = 10;
const CARVE_MIN_REMAINDER_FRACTION = 0.15;

function carveAppliedLike(...statuses) {
    return statuses.some(status => ['applied', 'executed'].includes(String(status || '').toLowerCase()));
}

// Demolition records of every APPLIED proposal in `proposals`. Unapplying or deleting a proposal
// takes its demolitions with it — the buildings come back. Roads, parks/squares/lakes and building
// typologies all clear their ground the same way and all park their records on
// `<kind>Proposal.demolishedBuildings`.
function demolishedBuildingRecordsFrom(proposals) {
    const records = [];
    (proposals || []).forEach(proposal => {
        if (!proposal) return;
        const rp = proposal.roadProposal;
        if (rp && rp.definition && carveAppliedLike(rp.status, proposal.status)) {
            (rp.definition.demolishedBuildings || []).forEach(record => {
                if (record && record.id) records.push(record);
            });
        }
        ['structureProposal', 'buildingProposal'].forEach(key => {
            const sub = proposal[key];
            if (!sub || !Array.isArray(sub.demolishedBuildings)) return;
            if (!carveAppliedLike(sub.status, proposal.status)) return;
            sub.demolishedBuildings.forEach(record => {
                if (record && record.id) records.push(record);
            });
        });
    });
    return records;
}

// Every applied demolition record, indexed by the id it was written against — an object_id for a
// real GDI building, or `proposal:<id>:<n>` for a PROPOSED building demolished by a later proposal.
// A building whose id is absent from this map is untouched, and that includes every TUNNELLED
// building: a tunnel writes a tunnel record, never a demolition record.
//
// Later records win: a building cut by one proposal and then razed by another is razed.
// Returns { records: Map<string, record> }.
function collectCarveRecords(proposals) {
    const records = new Map();
    demolishedBuildingRecordsFrom(proposals).forEach(record => {
        if (!record || !record.geometry) return;
        const existing = records.get(String(record.id));
        // A full demolition (no remainder) is final — a cut recorded elsewhere cannot resurrect it.
        if (existing && !existing.remainder) return;
        records.set(String(record.id), record);
    });
    return { records };
}

// Ground-plane footprint (lng/lat) of a { faces: [...] } 3D building, as the convex hull of every
// face vertex. NOT part of the carve any more — the record carries the real outline. This is still
// the only way to get an approximate footprint out of a raw mesh, which the 3D view's parcel
// volume calc (computeParcelMetrics) needs, so it stays exported.
function buildingFootprintFromFaces(faces, turf) {
    if (!Array.isArray(faces) || !turf || typeof turf.convex !== 'function') return null;
    const pts = [];
    for (const face of faces) {
        if (!face || !Array.isArray(face.coordinates)) continue;
        for (const ring of face.coordinates) {
            if (!Array.isArray(ring)) continue;
            for (const c of ring) {
                if (c && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) pts.push(turf.point([c[0], c[1]]));
            }
        }
    }
    if (pts.length < 3) return null;
    try { return turf.convex(turf.featureCollection(pts)) || null; } catch (_) { return null; }
}

// THE CARVE. One building's object_id against the records from collectCarveRecords():
//   null                            → untouched. Every TUNNELLED building lands here, and so does
//                                     every building no applied proposal ever named.
//   { remainder: null, demolished } → razed: nothing worth keeping survives.
//   { remainder, demolished }       → cut: `remainder` still stands, `demolished` is gone.
// `remainder` and `demolished` are GeoJSON geometries taken straight off the record — the exact
// polygons the draw-time subtraction produced against this object's own footprint.
function carveBuildingByObjectId(objectId, carveRecords) {
    const records = (carveRecords && carveRecords.records) || null;
    if (!records || objectId === undefined || objectId === null) return null;
    const record = records.get(String(objectId));
    if (!record) return null;
    // A record with a remainder is a CUT; one without is a full demolition.
    if (!record.remainder) return { remainder: null, demolished: record.geometry || null };
    return { remainder: record.remainder, demolished: record.demolishedPart || null };
}

if (typeof window !== 'undefined') {
    window.CARVE_MIN_REMAINDER_AREA_M2 = CARVE_MIN_REMAINDER_AREA_M2;
    window.CARVE_MIN_REMAINDER_FRACTION = CARVE_MIN_REMAINDER_FRACTION;
    window.demolishedBuildingRecordsFrom = demolishedBuildingRecordsFrom;
    window.collectCarveRecords = collectCarveRecords;
    window.buildingFootprintFromFaces = buildingFootprintFromFaces;
    window.carveBuildingByObjectId = carveBuildingByObjectId;
}

// Node-visible for unit tests and for the server carve; the browser loads this file as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CARVE_MIN_REMAINDER_AREA_M2,
        CARVE_MIN_REMAINDER_FRACTION,
        demolishedBuildingRecordsFrom,
        collectCarveRecords,
        buildingFootprintFromFaces,
        carveBuildingByObjectId
    };
}
