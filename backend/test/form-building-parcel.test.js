// §15a building formation: a freeform building forms its own parcel. Default = FOOTPRINT parcel
// (mint the building's parcel, cut each host's remainder back to its owner); option = whole-parcel
// take. Real turf + the real identity funnel drive the assertions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { _formBuildingParcel } = require('../../frontend/js/proposals/apply/buildings.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature etc.
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');

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
    properties: { parcelId: id, rootParcelId: id, BROJ_CESTICE: id.replace('HR-', ''), ownershipDetails: { owners: [{ name: 'Owner ' + id, percentageShare: 100 }] } },
    geometry: rect(dx0, 0, dx1, 2)
});

beforeEach(() => {
    GLOBAL_KEYS.forEach(k => { saved[k] = globalThis[k]; });
    globalThis.turf = turf;
    globalThis.window = {
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
        _hideFeaturesFromMap(features) { this.hidden.push(...features); },
        _persistParcelFeature: vi.fn(),
        _addProposalAsAncestor: vi.fn(),
        _addChildParcels: vi.fn(),
        _setLastApplyFailure: vi.fn(),
        _formBuildingParcel
    };
}

describe('_formBuildingParcel — footprint mode (default)', () => {
    it('mints the building parcel from the footprint and cuts host remainders back to their owners', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(parcels);
        const proposalData = { author: 'Ana', parentParcelIds: [] };
        const bp = {};
        // Building straddles both parcels: x 1..3, y 0.5..1.5.
        const result = await manager._formBuildingParcel('p-bld', proposalData, bp, rect(1, 0.5, 3, 1.5), [], 'p-bld');

        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A', 'HR-B']);
        expect(bp.formation.mode).toBe('footprint');

        const buildingParcel = manager.added.find(f => f.properties.buildingParcel === true);
        expect(buildingParcel).toBeTruthy();
        expect(buildingParcel.properties.baseParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(buildingParcel.properties.ownershipDetails.owners[0].name).toBe('Ana');
        expect(bp.formation.buildingParcelIds).toEqual([buildingParcel.properties.parcelId]);

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
        expect(bp.childParcelIds).toEqual(manager.added.map(f => String(f.properties.parcelId)));
    });

    it('refuses a footprint hanging off the live fabric', async () => {
        const parcels = [parcelOf('HR-A', 0, 2)];
        const manager = makeManager(parcels);
        const result = await manager._formBuildingParcel('p-bld', { author: 'Ana' }, {}, rect(1, 0, 4, 2), [], 'p-bld');
        expect(result.ok).toBe(false);
        expect(manager.added).toHaveLength(0);
        expect(manager._setLastApplyFailure.mock.calls[0][1].code).toBe('building-uncovered-ground');
    });

    it('is idempotent on restore — an existing formation record is not re-taken', async () => {
        const manager = makeManager([parcelOf('HR-A', 0, 2)]);
        const bp = { formation: { mode: 'footprint', parcelIds: ['HR-A'], childParcelIds: ['HR-A#p-bld-1'] } };
        const result = await manager._formBuildingParcel('p-bld', {}, bp, rect(0, 0, 2, 2), [], 'p-bld');
        expect(result.ok).toBe(true);
        expect(result.parentIds).toEqual(['HR-A']);
        expect(manager.added).toHaveLength(0);
    });
});

describe('_formBuildingParcel — whole-parcel option', () => {
    it('adopts the single host parcel for the proposer when takeWholeParcels is set', async () => {
        const host = parcelOf('HR-A', 0, 2);
        const manager = makeManager([host]);
        globalThis.window.__cadastreAncestry = { resolveParentsByGeometry: () => ({ ids: ['HR-A'], coverage: 1 }) };
        const bp = { takeWholeParcels: true };
        const result = await manager._formBuildingParcel('p-bld', { author: 'Ana' }, bp, rect(0, 0, 2, 2), [], 'p-bld');

        expect(result.ok).toBe(true);
        expect(bp.formation.mode).toBe('adopt');
        expect(host.properties.ownershipDetails.owners[0].name).toBe('Ana');
        expect(bp.formation.prior[0].ownershipDetails.owners[0].name).toBe('Owner HR-A');
        expect(manager.added).toHaveLength(0); // nothing minted on adoption
    });

    it('refuses partial coverage under the whole-parcel option, naming the offender', async () => {
        const parcels = [parcelOf('HR-A', 0, 2), parcelOf('HR-B', 2, 4)];
        const manager = makeManager(parcels);
        const bp = { takeWholeParcels: true };
        const result = await manager._formBuildingParcel('p-bld', { author: 'Ana' }, bp, rect(0, 0, 3, 2), [], 'p-bld');
        expect(result.ok).toBe(false);
        const failure = manager._setLastApplyFailure.mock.calls[0][1];
        expect(failure.code).toBe('building-partial-parcels');
        expect(failure.message).toContain('HR-B');
    });
});
