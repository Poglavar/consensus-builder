// Taking ONE record off the map, without rebuilding the plan.
//
// Unapply used to be a record flip that leaned on the whole-plan rebuild: reset every derived layer
// back to pristine cadastre, then replay whatever was still standing. That is why applying or
// unapplying a single proposal from the list cost the entire plan — 13 s on a 112-road plan.
//
// The replacement is `_undoProposalPayload` (take this record's result off) plus `_deriveGroundUnder`
// (recompute the parcels whose take set changed, and nothing else). These tests drive the real
// arrangement engine over a real parcel, so they fail if the pieces are not removed, if the parent
// does not come back, or if another record's ground is disturbed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
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

// ~111 m square of cadastre.
const PARCEL = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
    parcelId: 'HR-A', PARCEL_ID: 'HR-A', BROJ_CESTICE: '1234/5'
});
// A ribbon crossing it end to end, so the parcel is left with a strip and two remainders.
const RIBBON = turf.polygon([[[0.0004, -0.0002], [0.0006, -0.0002], [0.0006, 0.0012], [0.0004, 0.0012], [0.0004, -0.0002]]]);

function layerFor(feature) {
    return { feature, toGeoJSON: () => JSON.parse(JSON.stringify(feature)) };
}

// The browser's parcel registry, plus the show/hide state the map keeps for each entry.
function buildWorld() {
    const byId = new Map([['HR-A', layerFor(JSON.parse(JSON.stringify(PARCEL)))]]);
    const visible = new Set(['HR-A']);
    const records = new Map();

    const win = {
        parcelLayerById: byId,
        __parcelArrangement: arrangement,
        __planOrder: planOrder,
        __cadastreAncestry: {
            loadedCadastreParcels: () => Array.from(byId.entries())
                .filter(([id]) => String(id).indexOf('#') === -1)
                .map(([id, layer]) => ({ id, feature: layer.feature }))
        },
        removeParcelLayerById: id => { visible.delete(String(id)); byId.delete(String(id)); },
        showParcelLayerById: id => visible.add(String(id)),
        hideParcelLayerById: id => visible.delete(String(id)),
        parks: [],
        squares: [],
        lakes: [],
        transitStations: [],
        proposedBuildings: []
    };

    installGlobal('window', win);
    installGlobal('turf', turf);
    installGlobal('setProposalApplied', setProposalApplied);
    installGlobal('proposalStorage', {
        save: vi.fn(),
        getAllProposals: () => Array.from(records.values()),
        getProposal: id => records.get(String(id))
    });

    const manager = {
        _addFeaturesToMap: features => features.forEach(feature => {
            const id = String(feature.properties.parcelId);
            byId.set(id, layerFor(feature));
            visible.add(id);
        }),
        _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
        _coordinatedReadjustmentGroundByParcel: ProposalManager._coordinatedReadjustmentGroundByParcel,
        _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
        _deriveCorridorFabricBody: ProposalManager._deriveCorridorFabricBody,
        _parcelsClaimedByDerivedGround: ProposalManager._parcelsClaimedByDerivedGround,
        _deriveGroundUnder: ProposalManager._deriveGroundUnder,
        _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
        _undoProposalPayload: ProposalManager._undoProposalPayload,
        _releaseUnappliedRecord: ProposalManager._releaseUnappliedRecord
    };

    return { byId, visible, records, win, manager };
}

const road = (proposalId, polygon) => ({
    proposalId,
    goal: 'road-track',
    applied: true,
    roadProposal: { definition: { polygon } }
});

const pieceIds = byId => Array.from(byId.keys()).filter(id => id.indexOf('#') !== -1);

describe('a road cut, then taken back', () => {
    it('cuts only the parcel it crosses, and gives it back whole when the road is unapplied', async () => {
        const { byId, visible, records, manager } = buildWorld();
        const record = road('road-1', RIBBON);
        records.set('road-1', record);

        await manager._deriveGroundUnder([turf.feature(RIBBON.geometry)]);

        // The parcel is now a corridor strip and two remainders, and the parcel itself is hidden.
        expect(pieceIds(byId).length).toBe(3);
        expect(visible.has('HR-A')).toBe(false);
        expect(pieceIds(byId).every(id => visible.has(id))).toBe(true);

        // Unapply: flip the record, take its payload off, derive the ground it held without it.
        setProposalApplied(record, false, { stamp: false });
        const freed = await manager._releaseUnappliedRecord(record);

        expect(freed).toBeTruthy();
        expect(pieceIds(byId)).toEqual([]);
        expect(visible.has('HR-A')).toBe(true);
    });

    it('leaves a second road standing when the first is unapplied', async () => {
        const { byId, visible, records, manager } = buildWorld();
        // A second cadastral parcel, well clear of the first, with its own road.
        const far = turf.polygon([[[1, 1], [1.001, 1], [1.001, 1.001], [1, 1.001], [1, 1]]], {
            parcelId: 'HR-B', PARCEL_ID: 'HR-B', BROJ_CESTICE: '9999/1'
        });
        byId.set('HR-B', layerFor(far));
        visible.add('HR-B');
        const farRibbon = turf.polygon([[[1.0004, 0.9998], [1.0006, 0.9998], [1.0006, 1.0012], [1.0004, 1.0012], [1.0004, 0.9998]]]);

        const first = road('road-1', RIBBON);
        const second = road('road-2', farRibbon);
        records.set('road-1', first);
        records.set('road-2', second);
        await manager._deriveGroundUnder([turf.feature(RIBBON.geometry), turf.feature(farRibbon.geometry)]);
        expect(pieceIds(byId).length).toBe(6);

        setProposalApplied(first, false, { stamp: false });
        await manager._releaseUnappliedRecord(first);

        const left = pieceIds(byId);
        expect(left.length).toBe(3);
        expect(left.every(id => id.startsWith('HR-B#'))).toBe(true);
        expect(visible.has('HR-A')).toBe(true);
        expect(visible.has('HR-B')).toBe(false);
    });
});

describe('what a record put on the map', () => {
    it('takes back its buildings and leaves everyone else\'s alone', async () => {
        const { win, manager } = buildWorld();
        win.proposedBuildings = [
            { properties: { proposalId: 'mine', id: 'b1' } },
            { properties: { proposalId: 'yours', id: 'b2' } },
            { properties: { id: 'surveyed' } }
        ];
        win.parks = [{ properties: { proposalId: 'mine' } }, { properties: { proposalId: 'other' } }];

        manager._undoProposalPayload({ proposalId: 'mine' });

        expect(win.proposedBuildings.map(f => f.properties.id)).toEqual(['b2', 'surveyed']);
        expect(win.parks).toHaveLength(1);
        expect(win.parks[0].properties.proposalId).toBe('other');
    });

    it('takes back its derived parcels — and only those', async () => {
        const { byId, manager } = buildWorld();
        byId.set('HR-A#mine', layerFor({ type: 'Feature', properties: { parcelId: 'HR-A#mine', ancestorProposal: 'mine' } }));
        byId.set('HR-A#yours', layerFor({ type: 'Feature', properties: { parcelId: 'HR-A#yours', ancestorProposal: 'yours' } }));
        // A remainder belongs to no one: it is what is LEFT of the parcel, and must survive.
        byId.set('HR-A#rest', layerFor({ type: 'Feature', properties: { parcelId: 'HR-A#rest', parentParcelId: 'HR-A' } }));

        manager._undoProposalPayload({ proposalId: 'mine' });

        expect(Array.from(byId.keys()).sort()).toEqual(['HR-A', 'HR-A#rest', 'HR-A#yours']);
    });

    it('never removes a cadastral parcel, whatever a record claims', async () => {
        const { byId, manager } = buildWorld();
        byId.get('HR-A').feature.properties.proposalId = 'mine';

        manager._undoProposalPayload({ proposalId: 'mine' });

        expect(byId.has('HR-A')).toBe(true);
    });
});

describe('ground that is spoken for stays hidden', () => {
    it('keeps a parcel hidden while a readjustment\'s plots stand on it', async () => {
        const { byId, visible, records, manager } = buildWorld();
        // No road over it, so the arrangement leaves it untouched — but a plan's plots are there.
        byId.set('HR-A#plot-1', layerFor({
            type: 'Feature',
            properties: { parcelId: 'HR-A#plot-1', ancestorProposal: 'lr-1', rootParcelId: 'HR-A' }
        }));
        visible.delete('HR-A');
        records.set('lr-1', { proposalId: 'lr-1', goal: 'reparcellization', applied: true });

        await manager._deriveCorridorFabric({ parcelIds: ['HR-A'] });

        // The old rule was "no pieces → show", which would have put the cadastral parcel back on
        // the map underneath the plots standing on it.
        expect(visible.has('HR-A')).toBe(false);
    });

    it('shows it again once nothing derived claims it', async () => {
        const { byId, visible, manager } = buildWorld();
        byId.set('HR-A#plot-1', layerFor({
            type: 'Feature',
            properties: { parcelId: 'HR-A#plot-1', ancestorProposal: 'lr-1', rootParcelId: 'HR-A' }
        }));
        visible.delete('HR-A');

        manager._undoProposalPayload({ proposalId: 'lr-1' });
        await manager._deriveCorridorFabric({ parcelIds: ['HR-A'] });

        expect(visible.has('HR-A')).toBe(true);
    });

    it('fills a coordinated plan\'s reserved road band without duplicating its plots', async () => {
        const { byId, visible, records, manager } = buildWorld();
        const west = turf.polygon([[[0, 0], [0.0004, 0], [0.0004, 0.001], [0, 0.001], [0, 0]]]);
        const east = turf.polygon([[[0.0006, 0], [0.001, 0], [0.001, 0.001], [0.0006, 0.001], [0.0006, 0]]]);
        const planId = 'coordinated-plan';
        const readjustment = {
            proposalId: 'plots',
            coordinatedPlanId: planId,
            goal: 'reparcellization',
            applied: true,
            reparcellization: { polygons: [{ geometry: west.geometry }, { geometry: east.geometry }] }
        };
        const record = { ...road('road-1', RIBBON), coordinatedPlanId: planId };
        records.set(readjustment.proposalId, readjustment);
        records.set(record.proposalId, record);
        [west, east].forEach((plot, index) => {
            const id = `HR-A#plot-${index + 1}`;
            plot.properties = {
                parcelId: id,
                ancestorProposal: readjustment.proposalId,
                rootParcelId: 'HR-A',
                baseParcelIds: ['HR-A']
            };
            byId.set(id, layerFor(plot));
            visible.add(id);
        });
        visible.delete('HR-A');

        await manager._deriveGroundUnder([turf.feature(RIBBON.geometry)]);

        const live = Array.from(byId.entries())
            .filter(([id]) => id.includes('#'))
            .map(([, layer]) => layer.feature);
        expect(live.filter(feature => feature.properties.isCorridor === true)).toHaveLength(1);
        expect(live.filter(feature => feature.properties.ancestorProposal === 'plots')).toHaveLength(2);
        const total = live.reduce((sum, feature) => sum + turf.area(feature), 0);
        expect(total).toBeCloseTo(turf.area(PARCEL), 0);
    });
});

describe('deriving from inside the fabric queue', () => {
    it('does not enqueue behind the operation it is part of', async () => {
        installGlobal('proposalStorage', { save: vi.fn(), getProposal: () => null, getAllProposals: () => [] });
        const manager = {
            _fabricChangeTail: null,
            _enqueueFabricChange: ProposalManager._enqueueFabricChange,
            deriveForNewProposal: ProposalManager.deriveForNewProposal,
            deriveCorridorIncrementally: vi.fn(async () => ({ added: 0, removed: 0 }))
        };

        // Without the `_fabricQueue` opt-out this waits on the slot it is running in: a deadlock,
        // not a delay. A timeout is the only way to tell the two apart.
        const inQueue = manager._enqueueFabricChange(() => manager.deriveForNewProposal(
            { proposalId: 'r', goal: 'road-track' },
            { _fabricQueue: true }
        ));
        const timeout = new Promise(resolve => setTimeout(() => resolve('DEADLOCK'), 250));
        await expect(Promise.race([inQueue, timeout])).resolves.not.toBe('DEADLOCK');
        expect(manager.deriveCorridorIncrementally).toHaveBeenCalledOnce();
    });
});
