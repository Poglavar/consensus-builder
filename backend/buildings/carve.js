// Server-side application of an applied proposal's demolitions to the EXISTING 3D buildings under
// it: razed buildings disappear, cut buildings come back with a reduced footprint, and TUNNELLED
// buildings are returned whole because the road passes under them.
//
// The decision itself is NOT made here. It is made by frontend/js/corridor-carve.js — the same
// module the browser's 3D view runs — which is loaded below with createRequire (it is a classic
// script with a CommonJS export, not ESM). This file only supplies it with the one thing it cannot
// fetch for itself (the applied proposals, from the DB), then re-extrudes whatever survives.
//
// WHY A SERVER CARVE AT ALL: the walk sim (zagreb-isochrone/website/station-3d) renders the same
// `gdi_building_3d` meshes and has no way to know what a proposal did to them — it used to
// blanket-delete every building overlapping a proposal footprint, which razed tunnelled buildings
// too. It now asks this endpoint instead, so the sim and the app cannot disagree.
//
// There is NO id resolution step here any more. A demolition record is written against a GDI object
// (object_id) and the meshes are GDI objects (object_id) — the same key, so the carve is a lookup.
// The old dgu_gdi_building_match query lived here only because detection used to scan the DGU
// cadastre (zgrada_id) and the record had to be guessed onto a mesh.

import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { extrudeFootprint } from './extrude.js';

const require = createRequire(import.meta.url);
const { collectCarveRecords, carveBuildingByObjectId } = require('../../frontend/js/corridor-carve.js');

// The proposal columns the carve reads. Statuses live both on the proposal and on its sub-object,
// and corridor-carve.js checks both (a proposal row is 'Applied' while its roadProposal carries its
// own status), so hand it the same shape GET /proposals/:id returns.
const PROPOSAL_SQL = `
    SELECT proposal_id, id, status, city,
           road_proposal AS "roadProposal",
           structure_proposal AS "structureProposal",
           building_proposal AS "buildingProposal"
    FROM proposal
    WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])
`;

export async function fetchProposalsForCarve(pool, ids) {
    const list = (Array.isArray(ids) ? ids : [])
        .map(id => String(id).trim())
        .filter(Boolean);
    if (!list.length) return [];
    const { rows } = await pool.query(PROPOSAL_SQL, [list]);
    return rows;
}

// Every demolition record the given applied proposals carry, indexed by object_id. Pure — no DB
// round-trip, because the record already names its mesh.
export function carveRecordsFor(proposals) {
    return collectCarveRecords(proposals);
}

// Height of a { z_min, z_max, faces[] } building in metres, falling back to scanning face vertices
// when z_max is absent. Mirrors three-mode.js building3DHeightMeters.
function buildingHeightMeters(building) {
    const zmin = Number(building && building.z_min);
    const zmax = Number(building && building.z_max);
    if (Number.isFinite(zmin) && Number.isFinite(zmax) && zmax > zmin) return zmax - zmin;
    let top = -Infinity;
    let bottom = Infinity;
    for (const face of (building && building.faces) || []) {
        for (const ring of (face && face.coordinates) || []) {
            for (const c of ring || []) {
                if (c && Number.isFinite(c[2])) {
                    if (c[2] > top) top = c[2];
                    if (c[2] < bottom) bottom = c[2];
                }
            }
        }
    }
    return (Number.isFinite(top) && Number.isFinite(bottom) && top > bottom) ? (top - bottom) : 10;
}

// One building's verdict:
//   null                                               → untouched (also every tunnelled building)
//   { verdict: 'razed' }                               → nothing worth keeping survives
//   { verdict: 'cut', remainder, faces, z_min, z_max } → `remainder` still stands, the rest is gone
//
// A cut carries BOTH the remainder footprint and the mesh re-extruded from it. The faces are what a
// renderer actually consumes, and shipping them means no consumer has to own an extruder of its own
// — the walk sim swaps them straight into the feature it already fetched from its own mesh source.
export function carveVerdictFor(building, carveRecords) {
    const objectId = building && building.object_id;
    const carve = carveBuildingByObjectId(objectId, carveRecords);
    if (!carve) return null;

    if (!carve.remainder) return { object_id: objectId, verdict: 'razed', remainder: null, faces: [] };

    const height = buildingHeightMeters(building);
    const baseZ = Number.isFinite(Number(building.z_min)) ? Number(building.z_min) : 0;
    const rebuilt = extrudeFootprint(objectId, carve.remainder, height, baseZ);

    // A remainder that will not extrude (degenerate ring) is not a reason to resurrect the whole
    // uncut building — the corridor still goes through it. Call it razed, loudly.
    if (!rebuilt) {
        console.warn('[buildings/carve] cut remainder failed to extrude — treating as razed', objectId);
        return { object_id: objectId, verdict: 'razed', remainder: null, faces: [] };
    }

    return {
        object_id: objectId,
        verdict: 'cut',
        remainder: carve.remainder,
        faces: rebuilt.faces,
        z_min: rebuilt.z_min,
        z_max: rebuilt.z_max
    };
}

// Applies the carve to a list of provider buildings and returns the list to RENDER: razed buildings
// are omitted entirely, cut buildings are replaced by the mesh re-extruded from their remainder, and
// everything else — untouched and tunnelled alike — is passed through byte-for-byte.
export function carveBuildings(buildings, carveRecords) {
    const out = [];
    for (const building of buildings || []) {
        const verdict = carveVerdictFor(building, carveRecords);
        if (!verdict) {
            out.push(building);
            continue;
        }
        if (verdict.verdict === 'razed') continue;
        out.push({
            object_id: verdict.object_id,
            z_min: verdict.z_min,
            z_max: verdict.z_max,
            faces: verdict.faces
        });
    }
    return out;
}

// Verdicts for every AFFECTED building only — the shape a consumer that fetches its own meshes
// (the walk sim) needs: anything absent from the list is untouched and should render as-is.
export function carveVerdicts(buildings, carveRecords) {
    const verdicts = [];
    for (const building of buildings || []) {
        const verdict = carveVerdictFor(building, carveRecords);
        if (verdict) verdicts.push(verdict);
    }
    return verdicts;
}

// Bounding geometry covering every building the given records demolish, as a GeoJSON Polygon —
// used when a caller asks "what did these proposals do?" without naming an area of its own.
export function carveRecordsBounds(carveRecords) {
    const records = (carveRecords && carveRecords.records) || new Map();
    const features = [];
    for (const record of records.values()) {
        if (record && record.geometry) features.push({ type: 'Feature', properties: {}, geometry: record.geometry });
    }
    if (!features.length) return null;
    try {
        return turf.bboxPolygon(turf.bbox(turf.featureCollection(features))).geometry;
    } catch (_) {
        return null;
    }
}
