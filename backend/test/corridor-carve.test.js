// Unit tests for the shared carve — the one module that decides whether a proposal DEMOLISHED an
// existing building, CUT it, or TUNNELLED under it (leaving it whole). Both the browser 3D view and
// the server run this code, so this behaviour is the contract between them.
//
// The carve is now a LOOKUP: detection scans gdi_building_footprint (object_id) and the meshes are
// gdi_building_3d (object_id) — the same objects, so a demolition record NAMES its mesh. These
// tests pin that down, and in particular that a record can no longer reach a mesh it does not name.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const {
    demolishedBuildingRecordsFrom,
    collectCarveRecords,
    buildingFootprintFromFaces,
    carveBuildingByObjectId
} = require('../../frontend/js/corridor-carve.js');

// A metric-ish box around Zagreb centre: 1e-5 degrees of latitude ≈ 1.11 m, and at 45.8°N
// 1e-5 degrees of longitude ≈ 0.775 m. Sizes below are chosen so the areas are unambiguous.
const LNG0 = 15.97;
const LAT0 = 45.81;

// A rectangle `wLng` x `hLat` degrees with its south-west corner at (lng, lat).
function box(lng, lat, wLng, hLat) {
    return {
        type: 'Polygon',
        coordinates: [[
            [lng, lat],
            [lng + wLng, lat],
            [lng + wLng, lat + hLat],
            [lng, lat + hLat],
            [lng, lat]
        ]]
    };
}

// A flat-face mesh (the shape /buildings/near returns) whose vertices span the given footprint.
function meshFromBox(objectId, geometry, zMin = 120, zMax = 135) {
    const ring = geometry.coordinates[0];
    return {
        object_id: objectId,
        z_min: zMin,
        z_max: zMax,
        faces: [
            { type: 'Polygon', coordinates: [ring.map(c => [c[0], c[1], zMin])] },
            { type: 'Polygon', coordinates: [ring.map(c => [c[0], c[1], zMax])] }
        ]
    };
}

// ~28 m x 28 m building.
const BUILDING = box(LNG0, LAT0, 0.00036, 0.00025);
// The left third of it — the part a corridor takes.
const CUT_PART = box(LNG0, LAT0, 0.00012, 0.00025);
const REMAINDER = box(LNG0 + 0.00012, LAT0, 0.00024, 0.00025);

// The two record shapes corridor-tunnel.js writes, both keyed by the GDI object_id.
const fullDemolition = (id) => ({ id: String(id), geometry: BUILDING });
const cutRecord = (id) => ({
    id: String(id),
    geometry: BUILDING,
    demolishedPart: CUT_PART,
    remainder: REMAINDER
});

const roadWith = (records, status = 'applied') => ({
    proposalId: 'p-road',
    status,
    roadProposal: { status, definition: { demolishedBuildings: records } }
});

describe('demolishedBuildingRecordsFrom', () => {
    const record = { id: 'b1', geometry: box(LNG0, LAT0, 0.0001, 0.0001) };

    it('collects records from roads, structures and building typologies alike', () => {
        const records = demolishedBuildingRecordsFrom([
            { status: 'applied', roadProposal: { status: 'applied', definition: { demolishedBuildings: [record] } } },
            { status: 'applied', structureProposal: { status: 'applied', demolishedBuildings: [{ ...record, id: 'b2' }] } },
            { status: 'executed', buildingProposal: { status: 'executed', demolishedBuildings: [{ ...record, id: 'b3' }] } }
        ]);

        expect(records.map(r => r.id)).toEqual(['b1', 'b2', 'b3']);
    });

    it('ignores proposals that are not applied — unapplying gives the buildings back', () => {
        const records = demolishedBuildingRecordsFrom([
            { status: 'unapplied', roadProposal: { status: 'unapplied', definition: { demolishedBuildings: [record] } } },
            { status: 'Active', structureProposal: { status: 'Active', demolishedBuildings: [record] } }
        ]);

        expect(records).toEqual([]);
    });
});

describe('collectCarveRecords', () => {
    it('indexes applied records by the object_id they were written against', () => {
        const { records } = collectCarveRecords([roadWith([cutRecord(61075), fullDemolition(99999)])]);

        expect([...records.keys()].sort()).toEqual(['61075', '99999']);
        expect(records.get('61075').remainder).toBeTruthy();
        expect(records.get('99999').remainder).toBeUndefined();
    });

    it('lets a full demolition win over a cut of the same building — it cannot be resurrected', () => {
        const { records } = collectCarveRecords([
            roadWith([fullDemolition(61075)]),
            { proposalId: 'p2', status: 'applied', structureProposal: { status: 'applied', demolishedBuildings: [cutRecord(61075)] } }
        ]);

        expect(records.get('61075').remainder).toBeUndefined();
    });

    it('holds nothing for proposals that are not applied', () => {
        const { records } = collectCarveRecords([roadWith([fullDemolition(61075)], 'unapplied')]);

        expect(records.size).toBe(0);
    });
});

describe('buildingFootprintFromFaces', () => {
    it('hulls the face vertices of a 3D mesh into a ground-plane footprint', () => {
        const footprint = buildingFootprintFromFaces(meshFromBox(1, BUILDING).faces, turf);

        expect(footprint).toBeTruthy();
        expect(footprint.geometry.type).toBe('Polygon');
        expect(turf.area(footprint)).toBeCloseTo(turf.area(BUILDING), 0);
    });

    it('returns null for a mesh with no usable vertices', () => {
        expect(buildingFootprintFromFaces([], turf)).toBeNull();
        expect(buildingFootprintFromFaces(null, turf)).toBeNull();
    });
});

describe('carveBuildingByObjectId', () => {
    it('leaves a building UNTOUCHED when no applied proposal names it', () => {
        const carve = carveBuildingByObjectId(61075, collectCarveRecords([roadWith([fullDemolition(99999)])]));

        expect(carve).toBeNull();
    });

    it('RAZES a building whose record carries no remainder', () => {
        const carve = carveBuildingByObjectId(61075, collectCarveRecords([roadWith([fullDemolition(61075)])]));

        expect(carve).toBeTruthy();
        expect(carve.remainder).toBeNull();
        expect(turf.area(turf.feature(carve.demolished))).toBeCloseTo(turf.area(BUILDING), 0);
    });

    it('CUTS a building whose record carries a remainder, and hands back both halves', () => {
        const carve = carveBuildingByObjectId(61075, collectCarveRecords([roadWith([cutRecord(61075)])]));

        expect(carve).toBeTruthy();
        // The polygons come straight off the record — the draw-time subtraction against this very
        // object's own footprint. remainder + demolished still accounts for the whole building.
        const remaining = turf.area(turf.feature(carve.remainder));
        const gone = turf.area(turf.feature(carve.demolished));
        expect(remaining).toBeGreaterThan(0);
        expect(gone).toBeGreaterThan(0);
        expect(remaining + gone).toBeCloseTo(turf.area(BUILDING), 0);
    });

    it('matches on the id ALONE — a record for another building never touches this mesh, however much it overlaps', () => {
        // THE point of the whole refactor. This record demolishes the exact same GROUND that mesh
        // 61075 stands on, but it names 99999. Under the old footprint-overlap matching this would
        // have prism-ified 61075 (that is what the graze bar existed to paper over). Now it cannot:
        // detection and rendering scan the same GDI objects, so an id mismatch is a real mismatch.
        const carve = carveBuildingByObjectId(61075, collectCarveRecords([roadWith([fullDemolition(99999)])]));

        expect(carve).toBeNull();
    });

    it('leaves a TUNNELLED building whole — a tunnel writes no demolition record at all', () => {
        // The corridor's polygon runs straight through the building, but the user chose to tunnel,
        // so no record was ever written for it. Nothing else is needed to keep it standing: there is
        // no corridor-footprint region left in the carve that could reach it.
        const tunnelled = {
            proposalId: 'p-tunnel',
            status: 'applied',
            roadProposal: {
                status: 'applied',
                definition: {
                    polygon: box(LNG0 - 0.0004, LAT0 + 0.0001, 0.0016, 0.00005),
                    tunnels: [{ edgeKey: 'a|b', buildingIds: ['61075'] }],
                    demolishedBuildings: []
                }
            }
        };

        expect(carveBuildingByObjectId(61075, collectCarveRecords([tunnelled]))).toBeNull();
    });

    it('lets a park/square clear its ground — its records carve exactly like a corridor\'s', () => {
        const park = {
            proposalId: 'p-park',
            status: 'applied',
            structureProposal: { status: 'applied', demolishedBuildings: [fullDemolition(61075)] }
        };
        const carve = carveBuildingByObjectId(61075, collectCarveRecords([park]));

        expect(carve).toBeTruthy();
        expect(carve.remainder).toBeNull();
    });

    it('gives the buildings back when the proposal is unapplied', () => {
        expect(carveBuildingByObjectId(61075, collectCarveRecords([roadWith([fullDemolition(61075)], 'unapplied')]))).toBeNull();
    });

    it('accepts a numeric or a string object_id — the pool and the record may disagree on type', () => {
        const records = collectCarveRecords([roadWith([fullDemolition(61075)])]);

        expect(carveBuildingByObjectId(61075, records)).toBeTruthy();
        expect(carveBuildingByObjectId('61075', records)).toBeTruthy();
    });
});
