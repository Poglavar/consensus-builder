// Pure rules of frontend/js/proposals/open-ground.js (PARCEL-OPTIONAL.md phase 3): which records
// stand on open ground, how the host is derived from the site and the bound parcels, the bbox
// interaction index, and how ground pieces are kept apart from cadastral parcels (the parcel menu).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const openGround = require('../../frontend/js/proposals/open-ground.js');
const menuModel = require('../../frontend/js/ui/parcel-menu-model.js');
const { _formBuildingParcel } = require('../../frontend/js/proposals/apply/buildings.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature

const LON = 15.876;
const LAT = 43.7537;
const U = 1e-4;
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[
        [LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U],
        [LON + x1 * U, LAT + y1 * U], [LON + x0 * U, LAT + y1 * U],
        [LON + x0 * U, LAT + y0 * U]
    ]]
});
const multi = polygon => ({ type: 'MultiPolygon', coordinates: [polygon.coordinates] });
const HASH = 'ab'.repeat(32);

// The module reads turf as the browser global, as every other site module does.
const priorTurf = globalThis.turf;
beforeAll(() => { globalThis.turf = turf; });
afterAll(() => { if (priorTurf === undefined) delete globalThis.turf; else globalThis.turf = priorTurf; });

const park = (fields = {}) => ({
    proposalId: 'p',
    goal: 'park',
    cadastreParcelIds: [],
    site: multi(rect(0, 0, 20, 10)),
    structureProposal: { kind: 'park', geometry: rect(0, 0, 20, 10) },
    ...fields
});

describe('hasOpenGround', () => {
    it('is true for a material record with a site and an empty declaration', () => {
        expect(openGround.hasOpenGround(park())).toBe(true);
    });

    it('follows the binding coverage when parcels are declared', () => {
        expect(openGround.hasOpenGround(park({ cadastreParcelIds: ['HR-1'], binding: { coverage: 'partial' } }))).toBe(true);
        expect(openGround.hasOpenGround(park({ cadastreParcelIds: ['HR-1'], binding: { coverage: 'complete' } }))).toBe(false);
        // A city whose cadastre the server does not hold: the declaration is all there is.
        expect(openGround.hasOpenGround(park({ cadastreParcelIds: ['RS-1'], binding: { coverage: 'unknown' } }))).toBe(false);
        // Records from before bindings existed keep the cadastre-only behaviour.
        expect(openGround.hasOpenGround(park({ cadastreParcelIds: ['HR-1'] }))).toBe(false);
    });

    it('is never true for a parcel act', () => {
        expect(openGround.hasOpenGround({ proposalId: 'o', goal: 'offer', cadastreParcelIds: [] })).toBe(false);
        expect(openGround.hasOpenGround(park({ isVote: true }))).toBe(false);
    });
});

describe('corridorOnOpenGroundOnly', () => {
    it('reads an empty declaration as a ribbon on open ground unless the binding names parcels', () => {
        expect(openGround.corridorOnOpenGroundOnly({ cadastreParcelIds: [] })).toBe(true);
        expect(openGround.corridorOnOpenGroundOnly({ cadastreParcelIds: [], binding: { parcels: [] } })).toBe(true);
        expect(openGround.corridorOnOpenGroundOnly({ cadastreParcelIds: [], binding: { parcels: [{ parcelId: 'HR-1' }] } })).toBe(false);
        expect(openGround.corridorOnOpenGroundOnly({ cadastreParcelIds: ['HR-1'] })).toBe(false);
    });
});

describe('openGroundHost', () => {
    it('is the site minus the bound parcels, named by the site hash', () => {
        const record = park({ cadastreParcelIds: ['HR-1'], binding: { coverage: 'partial' } });
        const host = openGround.openGroundHost(record, {
            parcels: [{ id: 'HR-1', geometry: rect(-5, -5, 10, 15) }],
            siteHashHex: HASH
        });
        expect(host.properties.parcelId).toBe(`ground:${HASH}`);
        expect(host.properties.groundIds).toEqual([`ground:${HASH}`]);
        expect(host.properties.cadastreParcelIds).toEqual([]);
        expect(openGround.isOpenGroundHost(host)).toBe(true);
        expect(turf.area(host)).toBeCloseTo(turf.area(turf.feature(rect(10, 0, 20, 10))), 0);
    });

    it('is the whole site with an empty binding, and null on a fully bound site', () => {
        expect(turf.area(openGround.openGroundHost(park(), { siteHashHex: HASH })))
            .toBeCloseTo(turf.area(turf.feature(rect(0, 0, 20, 10))), 0);
        expect(openGround.openGroundHost(park({ cadastreParcelIds: ['HR-1'], binding: { coverage: 'complete' } }), {
            parcels: [{ id: 'HR-1', geometry: rect(0, 0, 20, 10) }], siteHashHex: HASH
        })).toBeNull();
    });

    it('drops cadastral micro-gaps narrower than the binding floor', () => {
        // Two bound parcels with a 0.5 mm seam (110 m long, so 0.05 m²: past the area prefilter)
        // between them, and real open ground beyond. 1 U east ≈ 8.04 m here, so 0.5 mm ≈ 6.2e-5 U.
        const seam = 6.2e-5;
        const geometry = openGround.openGroundGeometry(rect(0, 0, 30, 100), [
            { id: 'A', geometry: rect(0, 0, 10, 100) },
            { id: 'B', geometry: rect(10 + seam, 0, 20, 100) }
        ]);
        expect(geometry.type).toBe('Polygon');
        expect(turf.area(turf.feature(geometry))).toBeCloseTo(turf.area(turf.feature(rect(20, 0, 30, 100))), -1);
    });

    it('refuses to treat a missing bound parcel as open ground', () => {
        expect(() => openGround.openGroundHost(park({ cadastreParcelIds: ['HR-1'], binding: { coverage: 'partial' } }), {
            parcels: [], siteHashHex: HASH
        })).toThrow(expect.objectContaining({ code: 'open-ground-parcels-missing' }));
    });

    it('fails loudly when a parcel cannot be subtracted, never keeping an overlapping host', () => {
        const clip = () => { throw new Error('ring could not close'); };
        expect(() => openGround.openGroundGeometry(rect(0, 0, 20, 10), [{ id: 'A', geometry: rect(0, 0, 10, 10) }], { clip }))
            .toThrow(expect.objectContaining({ code: 'open-ground-derivation-failed' }));
    });
});

describe('bbox index and geometric interactions', () => {
    const entry = (id, box, open) => ({
        id,
        bbox: openGround.bboxOf(rect(...box)),
        geometry: turf.feature(rect(...box)),
        openGround: open
    });
    const intersects = (a, b) => {
        const hit = turf.intersect(a, b);
        return !!hit && turf.area(hit) > 0.25;
    };

    it('queries by bbox through the grid and an overflow list', () => {
        const index = openGround.createBboxIndex({ cellDeg: 0.001 });
        index.insert('small', openGround.bboxOf(rect(0, 0, 5, 5)));
        index.insert('huge', openGround.bboxOf(rect(-1000, -1000, 1000, 1000)));
        index.insert('far', openGround.bboxOf(rect(300, 300, 305, 305)));
        expect([...index.query(openGround.bboxOf(rect(1, 1, 2, 2)))].sort()).toEqual(['huge', 'small']);
    });

    it('needs open ground on at least one side, and follows chains through members it adds', () => {
        const seed = entry('seed', [0, 0, 10, 10], true);
        const found = openGround.geometricInteractions([seed], [
            entry('overlaps', [8, 0, 18, 10], false),
            entry('chain', [16, 0, 26, 10], true),
            entry('cadastral-pair', [17, 0, 27, 10], false),
            entry('abutting', [-10, 0, 0, 10], false),
            entry('far', [100, 100, 110, 110], true)
        ], { intersects });
        // 'cadastral-pair' overlaps only cadastral 'overlaps' and open 'chain': it joins through the
        // chain. 'abutting' shares only an edge with the seed.
        expect([...found].sort()).toEqual(['cadastral-pair', 'chain', 'overlaps']);
        // Two cadastral records never meet here (they share anchors instead).
        const none = openGround.geometricInteractions([entry('c1', [0, 0, 10, 10], false)],
            [entry('c2', [5, 0, 15, 10], false)], { intersects });
        expect(none.size).toBe(0);
    });
});

describe('a ground piece is never a cadastral parcel', () => {
    it('is recognised by provenance', () => {
        expect(openGround.isGroundPiece({ properties: { cadastreParcelIds: [], groundIds: [`ground:${HASH}`] } })).toBe(true);
        expect(openGround.isGroundPiece({ properties: { cadastreParcelIds: ['HR-1'], groundIds: [`ground:${HASH}`] } })).toBe(false);
        expect(openGround.isGroundPiece({ properties: { cadastreParcelIds: [], groundIds: ['HR-1'] } })).toBe(false);
    });

    it('offers no parcel actions in the parcel menu', () => {
        const facts = { parcelId: 'p-1', isGround: true, historyIds: [], siteToolAvailable: true, can3d: true, blocksEnabled: true };
        expect(menuModel.availableActions(facts)).toEqual(['details', 'view3d', 'useAsSite']);
        expect(menuModel.availableActions({ ...facts, isGround: false, historyIds: ['HR-1'] }))
            .toEqual(expect.arrayContaining(['offer', 'history', 'propose', 'detectBlock']));
    });
});

describe('whole-parcel building take beside open ground', () => {
    it('takes the whole parcel plus exactly the footprint on the open-ground host', async () => {
        const saved = {};
        const keys = ['window', 'turf', '_resolveRootParcelNumberFromProperties', '_calculateGeoJsonArea', 'updateStatus'];
        keys.forEach(key => { saved[key] = globalThis[key]; });
        globalThis.turf = turf;
        globalThis.window = { __formationEdit: formationEdit, __openGround: openGround };
        globalThis._resolveRootParcelNumberFromProperties = props => (props && props.rootParcelNumber) || null;
        globalThis._calculateGeoJsonArea = geometry => turf.area(turf.feature(geometry));
        globalThis.updateStatus = () => {};
        try {
            const host = openGround.openGroundHost(park({ cadastreParcelIds: ['HR-A'], binding: { coverage: 'partial' } }), {
                parcels: [{ id: 'HR-A', geometry: rect(0, 0, 10, 10) }], siteHashHex: HASH
            });
            const parcelA = { type: 'Feature', properties: { parcelId: 'HR-A', cadastreParcelIds: ['HR-A'] }, geometry: rect(0, 0, 10, 10) };
            const added = [];
            const hidden = [];
            const failures = [];
            const manager = {
                _assignSyntheticChildIdentities(proposalId, features) {
                    features.forEach((feature, index) => { feature.properties.parcelId = `${proposalId}-${index + 1}`; });
                },
                _addFeaturesToMap(features) { added.push(...features); },
                _consumeFeaturesFromLiveFabric(features) { hidden.push(...features); },
                _markParcelProducedByProposal() {},
                _setLastApplyFailure(_id, failure) { failures.push(failure); },
                _appliedRoadOverlappedByTaking: () => null,
                _formBuildingParcel
            };
            // The footprint covers all of HR-A and 5 units of open ground beside it.
            const result = await manager._formBuildingParcel('b', { author: 'Ana' }, { takeWholeParcels: true },
                rect(0, 0, 15, 10), [], 'b', [parcelA, host]);
            expect(failures).toEqual([]);
            expect(result.ok).toBe(true);
            expect(added).toHaveLength(1);
            expect(added[0].properties.cadastreParcelIds).toEqual(['HR-A']);
            expect(added[0].properties.groundIds).toEqual([`ground:${HASH}`]);
            expect(turf.area(added[0])).toBeCloseTo(turf.area(turf.feature(rect(0, 0, 15, 10))), -1);
            expect(hidden.map(feature => feature.properties.parcelId)).toEqual(['HR-A']);
        } finally {
            keys.forEach(key => { if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key]; });
        }
    });
});
