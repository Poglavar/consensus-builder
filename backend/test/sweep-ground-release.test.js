// During canonical boot/recovery replay, corridor cuts invalidate only records whose authored
// geometry no longer fits the resulting live pieces. The decision itself changes record state;
// replay's complete reset already removed disposable presentation and parcel output.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const applyRoute = require('../../frontend/js/proposals/apply/route.js');
const groundSweep = require('../../frontend/js/proposals/ground-sweep.js');
const turf = require('@turf/turf');

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    }
    globalThis[name] = value;
}
afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

// One cadastral parcel, already cut into two pieces by a road — the state the sweep inspects.
const PARCEL_ID = 'HR-A';
const WEST = turf.polygon([[[0, 0], [0.0004, 0], [0.0004, 0.001], [0, 0.001], [0, 0]]], { parcelId: `${PARCEL_ID}#1` });
const EAST = turf.polygon([[[0.0006, 0], [0.001, 0], [0.001, 0.001], [0.0006, 0.001], [0.0006, 0]]], { parcelId: `${PARCEL_ID}#2` });
// A block that spans BOTH pieces — the road went straight through it.
const BLOCK = turf.polygon([[[0.0002, 0.0002], [0.0008, 0.0002], [0.0008, 0.0008], [0.0002, 0.0008], [0.0002, 0.0002]]]);
// A block wholly inside the west piece — untouched, and it must stay.
const SAFE_BLOCK = turf.polygon([[[0.0001, 0.0002], [0.0003, 0.0002], [0.0003, 0.0004], [0.0001, 0.0004], [0.0001, 0.0002]]]);

const layerFor = feature => ({ feature, toGeoJSON: () => JSON.parse(JSON.stringify(feature)) });

function blockRecord(proposalId, ...footprints) {
    return {
        proposalId,
        title: `Block ${proposalId}`,
        goal: 'buildings',
        applied: true,
        buildingProposal: { parentParcelIds: [PARCEL_ID] },
        geometry: { buildings: footprints.map(footprint => turf.feature(footprint.geometry)) }
    };
}

function buildWorld(records) {
    const byId = new Map([
        [`${PARCEL_ID}#1`, layerFor(WEST)],
        [`${PARCEL_ID}#2`, layerFor(EAST)]
    ]);
    const store = new Map(records.map(record => [String(record.proposalId), record]));
    const win = {
        parcelLayerById: byId,
        __parcelArrangement: arrangement,
        __planOrder: planOrder,
        __cadastreAncestry: { loadedCadastreParcels: () => [] },
        // The sweep judges a design part by part (a block is one building per parcel, and the union
        // of them can never fit inside one piece) — the page loads this module for it.
        __groundSweep: groundSweep,
        turf,
        removeParcelLayerById: id => byId.delete(String(id)),
        parks: [],
        squares: [],
        lakes: [],
        transitStations: [],
        // What the map is actually drawing.
        proposedBuildings: records.flatMap(record => record.geometry.buildings.map(building => ({
            type: 'Feature',
            geometry: building.geometry,
            properties: { proposalId: String(record.proposalId) }
        })))
    };

    installGlobal('window', win);
    installGlobal('turf', turf);
    installGlobal('setProposalApplied', setProposalApplied);
    installGlobal('applyRoute', applyRoute);
    installGlobal('appliedOf', proposal => proposal?.applied === true);
    installGlobal('proposalStorage', {
        save: vi.fn(),
        getAllProposals: () => Array.from(store.values()),
        getProposal: id => store.get(String(id))
    });

    const manager = {
        _severedThisRebuild: [],
        _replayInvalidated: false,
        _parkRecordsInvalidatedByCorridors: ProposalManager._parkRecordsInvalidatedByCorridors
    };
    return { win, manager, byId };
}

describe('parking a record whose ground stopped being whole', () => {
    it('parks the record and invalidates the current replay pass', () => {
        const divided = blockRecord('block-divided', BLOCK);
        const { manager } = buildWorld([divided]);

        const sweep = manager._parkRecordsInvalidatedByCorridors([PARCEL_ID], [divided]);

        expect(sweep.unapplied.map(entry => entry.proposalId)).toEqual(['block-divided']);
        expect(divided.applied).toBe(false);
        expect(manager._severedThisRebuild).toEqual(['block-divided']);
        expect(manager._replayInvalidated).toBe(true);
    });

    it('leaves a block that still fits inside one piece applied', () => {
        const safe = blockRecord('block-safe', SAFE_BLOCK);
        const { manager } = buildWorld([safe]);

        const sweep = manager._parkRecordsInvalidatedByCorridors([PARCEL_ID], [safe]);

        expect(sweep.unapplied).toEqual([]);
        expect(safe.applied).toBe(true);
    });

    // A block is one building per parcel. Judging the UNION of them asked whether the whole block
    // fits inside a single piece of a single parcel — which it cannot once it spans two, so moving a
    // road's nodes removed four blocks, then twelve, with the cut nowhere near a building.
    it('keeps a block whose buildings each sit inside a piece, though the block spans both', () => {
        const inWest = turf.polygon([[[0.0001, 0.0002], [0.0003, 0.0002], [0.0003, 0.0008], [0.0001, 0.0008], [0.0001, 0.0002]]]);
        const inEast = turf.polygon([[[0.0007, 0.0002], [0.0009, 0.0002], [0.0009, 0.0008], [0.0007, 0.0008], [0.0007, 0.0002]]]);
        const spanning = blockRecord('block-two-parcels', inWest, inEast);
        const { manager } = buildWorld([spanning]);

        const sweep = manager._parkRecordsInvalidatedByCorridors([PARCEL_ID], [spanning]);

        expect(sweep.unapplied).toEqual([]);
        expect(spanning.applied).toBe(true);
    });

    it('still parks a spanning block when the cut goes through one of its buildings', () => {
        const inWest = turf.polygon([[[0.0001, 0.0002], [0.0003, 0.0002], [0.0003, 0.0008], [0.0001, 0.0008], [0.0001, 0.0002]]]);
        const severed = blockRecord('block-one-cut', inWest, BLOCK);
        const { manager } = buildWorld([severed]);

        const sweep = manager._parkRecordsInvalidatedByCorridors([PARCEL_ID], [severed]);

        expect(sweep.unapplied.map(entry => entry.proposalId)).toEqual(['block-one-cut']);
        expect(severed.applied).toBe(false);
    });

    it('parks only the divided block when both stand on the same parcel', () => {
        const divided = blockRecord('block-divided', BLOCK);
        const safe = blockRecord('block-safe', SAFE_BLOCK);
        const { manager } = buildWorld([divided, safe]);

        manager._parkRecordsInvalidatedByCorridors([PARCEL_ID], [divided, safe]);

        expect(divided.applied).toBe(false);
        expect(safe.applied).toBe(true);
    });
});
