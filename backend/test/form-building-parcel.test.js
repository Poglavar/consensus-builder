// §15a building formation: a freeform building forms its own parcel. Default = FOOTPRINT parcel
// (mint the building's parcel, cut each host's remainder back to its owner); option = whole-parcel
// take. Real turf + the real identity funnel drive the assertions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const {
    _formBuildingParcel,
    shouldFormOwnBuildingParcel
} = require('../../frontend/js/proposals/apply/buildings.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature etc.
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const boundary = require('./fixtures/parcel-cut-boundary.json');

const GLOBAL_KEYS = ['window', 'turf', '_resolveRootParcelIdFromProperties',
    '_resolveRootParcelNumberFromProperties', '_calculateGeoJsonArea', 'updateStatus'];
const saved = {};

const LON = 15.96, LAT = 45.80;
const rect = (dx0, dy0, dx1, dy1) => ({
    type: 'Polygon',
    coordinates: [[
        [LON + dx0 * 1e-3, LAT + dy0 * 1e-3], [LON + dx1 * 1e-3, LAT + dy0 * 1e-3],
        [LON + dx1 * 1e-3, LAT + dy1 * 1e-3], [LON + dx0 * 1e-3, LAT + dy1 * 1e-3],
        [LON + dx0 * 1e-3, LAT + dy0 * 1e-3]
    ]]
});
const parcelOf = (id, dx0, dx1) => ({
    type: 'Feature',
    properties: {
        parcelId: id,
        cadastreParcelIds: [id],
        rootParcelId: id,
        BROJ_CESTICE: id.replace('HR-', ''),
        ownershipDetails: { owners: [{ name: 'Owner ' + id, percentageShare: 100 }] }
    },
    geometry: rect(dx0, 0, dx1, 2)
});

beforeEach(() => {
    GLOBAL_KEYS.forEach(k => { saved[k] = globalThis[k]; });
    globalThis.turf = turf;
    globalThis.window = {
        __parcelArrangement: parcelArrangement,
        __formationEdit: formationEdit,
        __cadastreAncestry: { resolveParentsByGeometry: () => ({ ids: ['HR-A', 'HR-B'], coverage: 1 }) }
    };
    globalThis._resolveRootParcelIdFromProperties = props => (props && props.rootParcelId) || null;
    globalThis._resolveRootParcelNumberFromProperties = props => (props && props.rootParcelNumber) || null;
    globalThis._calculateGeoJsonArea = geometry => {
        try { return turf.area({ type: 'Feature', properties: {}, geometry }); } catch (_) { return 0; }
    };
    globalThis.updateStatus = vi.fn();
});

afterEach(() => {
    GLOBAL_KEYS.forEach(k => {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    });
});

function makeManager(parcels) {
    return {
        hidden: [],
        added: [],
        _resolveParcelFeaturesByIds: vi.fn(() => parcels),
        _assignSyntheticChildIdentities(...args) { return ProposalManager._assignSyntheticChildIdentities(...args); },
        _addFeaturesToMap(features) { this.added.push(...features); },
        _consumeFeaturesFromLiveFabric(features) { this.hidden.push(...features); },
        // The fabric's partition check is its own test (formed-partition-check.test.js).
        _checkFormedPartition: vi.fn(async () => true),
        _markParcelProducedByProposal: vi.fn(),
        _addChildParcels: vi.fn(),
        _setLastApplyFailure: vi.fn(),
        _appliedRoadOverlappedByTaking: vi.fn(() => null),
        _formBuildingParcel
    };
}

describe('building parcel formation routing', () => {
    it('forms an ordinary one-footprint freeform building parcel', () => {
        expect(shouldFormOwnBuildingParcel({ goal: 'single' }, 'single', 1)).toBe(true);
    });

    it('does not let legacy plan metadata change ordinary single-building parcel formation', () => {
        expect(shouldFormOwnBuildingParcel({ coordinatedPlanId: 'upu-borovje' }, 'single', 1)).toBe(true);
    });

    it('does not form parcels for multi-footprint or non-single building proposals', () => {
        expect(shouldFormOwnBuildingParcel({}, 'single', 2)).toBe(false);
        expect(shouldFormOwnBuildingParcel({}, 'buildings', 1)).toBe(false);
    });
});

describe('_formBuildingParcel — footprint mode (default)', () => {
    it('forms the take and remainder on identical boundaries without rewriting authored geometry', async () => {
        const authored = { geometry: { landTake: structuredClone(boundary.footprint.geometry) } };
        const original = structuredClone(authored);
        const manager = makeManager([structuredClone(boundary.host)]);
        const result = await manager._formBuildingParcel('tower', authored, {},
            boundary.footprint.geometry, ['GB-host'], 'tower');
        expect(result.ok).toBe(true);
        const take = manager.added.find(feature => feature.properties.buildingParcel);
        const remainders = manager.added.filter(feature => !feature.properties.buildingParcel);
        expect(take.geometry).toEqual(parcelArrangement.onClipGrid(boundary.footprint).geometry);
        expect(remainders.length).toBeGreaterThan(0);
        remainders.forEach(remainder => expect(turf.intersect(take, remainder)).toBeNull());
        const union = manager.added.reduce((merged, feature) => merged ? turf.union(merged, feature) : feature, null);
        expect(turf.difference(parcelArrangement.onClipGrid(boundary.host), union)).toBeNull();
        expect(turf.difference(union, parcelArrangement.onClipGrid(boundary.host))).toBeNull();
        expect(authored).toEqual(original);
    });

    it('mints the building parcel from the footprint and cuts host remainders back to their owners', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(parcels);
        const proposalData = { author: 'Ana', cadastreParcelIds: [] };
        const bp = {};
        // Building straddles both parcels: x 1..3, y 0.5..1.5.
        const result = await manager._formBuildingParcel('p-bld', proposalData, bp, rect(1, 0.5, 3, 1.5), [], 'p-bld');

        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A', 'HR-B']);
        expect(bp).not.toHaveProperty('formation');

        const buildingParcel = manager.added.find(f => f.properties.buildingParcel === true);
        expect(buildingParcel).toBeTruthy();
        expect(buildingParcel.properties.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(buildingParcel.properties.ownershipDetails.owners[0].name).toBe('Ana');

        // Each host leaves a remainder that KEEPS its owner (§14.2). The u-shaped remainders are
        // split into contiguous pieces by the identity funnel.
        const remainders = manager.added.filter(f => f.properties.buildingParcel !== true);
        expect(remainders.length).toBeGreaterThanOrEqual(2);
        remainders.forEach(remainder => {
            expect(remainder.properties.ownershipDetails.owners[0].name).toMatch(/^Owner HR-/);
        });
        expect(manager.hidden.map(f => f.properties.parcelId).sort()).toEqual(['HR-A', 'HR-B']);
        // Every child carries a fresh flat identity under a base root.
        manager.added.forEach(child => {
            expect(String(child.properties.parcelId)).toMatch(/^HR-[AB]#p-bld-\d+$/);
        });
        expect(bp).not.toHaveProperty('childParcelIds');
    });

    it('keeps both hosts and all ground for a 1.15 m² triangle split into sub-1 m² takes', async () => {
        // The observed triangle is 1.153 m², split 0.324 + 0.829 m² by the host boundary.
        // A fixed 1 m² per-host floor lost both hosts even though their union covers it.
        const footprint = { type: 'Polygon', coordinates: [[
            [LON, LAT], [LON + 0.02966e-3, LAT],
            [LON + 0.02966e-3, LAT + 0.009e-3], [LON, LAT]
        ]] };
        const left = parcelOf('HR-A', 0, 0.01572);
        const right = parcelOf('HR-B', 0.01572, 0.02966);
        left.geometry = rect(0, -0.02, 0.01572, 0.03);
        right.geometry = rect(0.01572, -0.02, 0.02966, 0.03);
        const hosts = [left, right];
        const footprintFeature = turf.feature(footprint);
        const takes = hosts.map(host => turf.area(turf.intersect(footprintFeature, host)));
        expect(turf.area(footprintFeature)).toBeCloseTo(1.153, 2);
        expect(takes[0]).toBeCloseTo(0.324, 2);
        expect(takes[1]).toBeCloseTo(0.829, 2);
        expect(takes.every(area => area < 1)).toBe(true);

        const manager = makeManager(hosts);
        const result = await manager._formBuildingParcel('tiny', { author: 'Ana' }, {},
            footprint, [], 'tiny');

        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A', 'HR-B']);
        expect(manager.hidden.map(host => host.properties.parcelId).sort()).toEqual(['HR-A', 'HR-B']);
        const building = manager.added.find(feature => feature.properties.buildingParcel === true);
        expect(building.properties.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(turf.area(building)).toBeCloseTo(turf.area(footprintFeature), 2);
        for (const host of hosts) {
            const anchor = host.properties.parcelId;
            const retained = manager.added.filter(feature => feature !== building
                && feature.properties.cadastreParcelIds.includes(anchor));
            expect(retained.length).toBeGreaterThan(0);
            expect(retained.every(feature => feature.properties.ownershipDetails.owners[0].name === `Owner ${anchor}`)).toBe(true);
            const groundAfter = retained.reduce((sum, feature) => sum + turf.area(feature), 0)
                + turf.area(turf.intersect(building, host));
            expect(Math.abs(groundAfter - turf.area(host))).toBeLessThan(0.02);
        }
    });

    it('propagates an intersection failure before changing live ground', async () => {
        const hosts = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(hosts);
        window.__parcelArrangement = {
            ...parcelArrangement,
            clipFailure: parcelArrangement.clipFailure,
            clip(operation, left, right) {
                if (operation === 'intersect') throw new Error('intersection failed explicitly');
                return turf[operation](left, right);
            },
            // The host test runs the shared clip through geometry-tolerances.js reachesInto.
            clipWith(t, operation, left, right, context) {
                if (operation === 'intersect') throw new Error('intersection failed explicitly');
                return parcelArrangement.clipWith(t, operation, left, right, context);
            }
        };
        await expect(manager._formBuildingParcel('p-bld', { author: 'Ana' }, {},
            rect(1, 0.5, 3, 1.5), [], 'p-bld'))
            .rejects.toThrow('intersection failed explicitly');
        expect(manager.added).toHaveLength(0);
        expect(manager.hidden).toHaveLength(0);
    });

    it('refuses a footprint hanging off the live fabric', async () => {
        const parcels = [parcelOf('HR-A', 0, 2)];
        const manager = makeManager(parcels);
        const result = await manager._formBuildingParcel('p-bld', { author: 'Ana' }, {}, rect(1, 0, 4, 2), [], 'p-bld');
        expect(result.ok).toBe(false);
        expect(manager.added).toHaveLength(0);
        expect(manager._setLastApplyFailure.mock.calls[0][1].code).toBe('building-uncovered-ground');
    });

    it('refuses when a host remainder cannot be computed, instead of hiding dead ground', async () => {
        // turf's sweep-line throws on degenerate rings; treating that as "fully consumed"
        // hid the host with no remainder minted — a whole parcel of unclickable dead ground.
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(parcels);
        // Only the remainder cut fails; the uncovered-footprint check (geometry-tolerances.js) runs first.
        const broken = new Proxy(turf, {
            get: (target, key) => key === 'difference'
                ? (...args) => {
                    if (/geometry-tolerances\.js/.test(String(new Error().stack))) return target.difference(...args);
                    throw new Error('Unable to find segment in SweepLine tree.');
                }
                : target[key]
        });
        globalThis.turf = broken;
        const result = await manager._formBuildingParcel('p-bld', { author: 'Ana' }, {}, rect(1, 0.5, 3, 1.5), [], 'p-bld');
        expect(result.ok).toBe(false);
        expect(manager.hidden).toHaveLength(0);
        expect(manager._setLastApplyFailure.mock.calls[0][1].code).toBe('building-cut-failed');
    });

    it('rebuilds from live ground without recording a formation cache', async () => {
        const manager = makeManager([parcelOf('HR-A', 0, 2)]);
        const bp = {};
        const result = await manager._formBuildingParcel('p-bld', {}, bp, rect(0, 0, 2, 2), [], 'p-bld');
        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A']);
        expect(manager.added).toHaveLength(1);
        expect(manager.added[0].properties.buildingParcel).toBe(true);
        expect(bp).not.toHaveProperty('formation');
        expect(bp).not.toHaveProperty('childParcelIds');
    });
});

describe('_formBuildingParcel — reviewed take', () => {
    it('forms whole host land around a narrow building without changing its footprint', async () => {
        const host = parcelOf('HR-A', 0, 2);
        const manager = makeManager([host]);
        const result = await manager._formBuildingParcel('p-bld', { author: 'Proposer', geometry: { landTake: host.geometry } }, {}, rect(.5, .5, 1, 1.5), [], 'p-bld');
        expect(result.ok).toBe(true);
        expect(manager.added).toHaveLength(1);
        expect(manager.added[0].geometry).toEqual(parcelArrangement.onClipGrid(host).geometry);
        expect(manager.hidden).toEqual([host]);
    });
    it('takes a whole parcel beside a cut and retains the neighbour owner and all land', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(parcels);
        const body = rect(1, .5, 3, 1.5);
        const take = turf.union(parcels[0], turf.feature(body));
        const result = await manager._formBuildingParcel('p-bld', { author: 'Proposer', geometry: { landTake: take } }, {}, body, [], 'p-bld');
        expect(result.ok).toBe(true);
        const child = manager.added.find(f => f.properties.buildingParcel);
        expect(turf.area(child)).toBeCloseTo(turf.area(take), 3);
        const remainders = manager.added.filter(f => !f.properties.buildingParcel);
        expect(remainders.length).toBeGreaterThan(0);
        expect(remainders.every(f => f.properties.ownershipDetails.owners[0].name === 'Owner HR-B')).toBe(true);
        expect(manager.added.reduce((sum, f) => sum + turf.area(f), 0)).toBeCloseTo(parcels.reduce((sum, f) => sum + turf.area(f), 0), 3);
    });
    it('refuses land that does not contain the building before touching hosts', async () => {
        const manager = makeManager([parcelOf('HR-A', 0, 2)]);
        const result = await manager._formBuildingParcel('p-bld', { geometry: { landTake: rect(0, 0, 1, 2) } }, {}, rect(.5, .5, 1.5, 1.5), [], 'p-bld');
        expect(result.ok).toBe(false);
        expect(manager._setLastApplyFailure.mock.calls[0][1].code).toBe('building-outside-land-take');
        expect(manager.hidden).toHaveLength(0);
    });
});
