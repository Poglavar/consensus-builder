// A road edit that divides ground somebody else needed WHOLE sweeps them off the map.
//
// "Off the map" was only ever half done: the sweep flipped `applied` to false and stopped there. A
// record's buildings, parks, squares and lakes live in presentation collections keyed to it, so a
// block swept away by a road edit stayed drawn, looking applied, while every other part of the app
// read the record as unapplied. These tests pin that a swept record leaves as thoroughly as an
// explicitly unapplied one does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const applyRoute = require('../../frontend/js/proposals/apply/route.js');
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

function blockRecord(proposalId, footprint) {
    return {
        proposalId,
        title: `Block ${proposalId}`,
        goal: 'buildings',
        applied: true,
        buildingProposal: { parentParcelIds: [PARCEL_ID] },
        geometry: { buildings: [turf.feature(footprint.geometry)] }
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
        turf,
        removeParcelLayerById: id => byId.delete(String(id)),
        parks: [],
        squares: [],
        lakes: [],
        transitStations: [],
        // What the map is actually drawing.
        proposedBuildings: records.map(record => ({
            type: 'Feature',
            geometry: record.geometry.buildings[0].geometry,
            properties: { proposalId: String(record.proposalId) }
        }))
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
        _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
        _parcelsClaimedByDerivedGround: ProposalManager._parcelsClaimedByDerivedGround,
        _deriveGroundUnder: ProposalManager._deriveGroundUnder,
        _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
        _undoProposalPayload: ProposalManager._undoProposalPayload,
        _releaseUnappliedRecord: ProposalManager._releaseUnappliedRecord,
        _sweepGroundNoLongerWhole: ProposalManager._sweepGroundNoLongerWhole
    };
    return { win, manager, byId };
}

describe('sweeping a record whose ground stopped being whole', () => {
    it('takes its buildings OFF the map, not just its applied flag', () => {
        const divided = blockRecord('block-divided', BLOCK);
        const { win, manager } = buildWorld([divided]);

        const sweep = manager._sweepGroundNoLongerWhole([PARCEL_ID]);

        expect(sweep.unapplied.map(entry => entry.proposalId)).toEqual(['block-divided']);
        expect(divided.applied).toBe(false);
        // The bug: this used to still hold the block, so it stayed drawn on the map looking applied.
        expect(win.proposedBuildings.some(f => f.properties.proposalId === 'block-divided')).toBe(false);
    });

    it('leaves a block that still fits inside one piece alone, on the map and applied', () => {
        const safe = blockRecord('block-safe', SAFE_BLOCK);
        const { win, manager } = buildWorld([safe]);

        const sweep = manager._sweepGroundNoLongerWhole([PARCEL_ID]);

        expect(sweep.unapplied).toEqual([]);
        expect(safe.applied).toBe(true);
        expect(win.proposedBuildings.some(f => f.properties.proposalId === 'block-safe')).toBe(true);
    });

    it('sweeps only the divided block when both stand on the same parcel', () => {
        const divided = blockRecord('block-divided', BLOCK);
        const safe = blockRecord('block-safe', SAFE_BLOCK);
        const { win, manager } = buildWorld([divided, safe]);

        manager._sweepGroundNoLongerWhole([PARCEL_ID]);

        expect(divided.applied).toBe(false);
        expect(safe.applied).toBe(true);
        expect(win.proposedBuildings.map(f => f.properties.proposalId)).toEqual(['block-safe']);
    });
});
