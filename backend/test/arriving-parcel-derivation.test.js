// A cadastral parcel that arrives AFTER the corridors were applied.
//
// Pieces were materialised when a road was applied, over whatever cadastre happened to be loaded at
// that moment, and tile arrivals were presentation-only ("The canonical rebuild owns fabric
// materialization"). So panning a parcel into view afterwards left it whole underneath a road that
// plainly crossed it — silently, with nothing to say it had been missed. These tests drive the real
// arrangement engine over a parcel that shows up late.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
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

// ~111 m square of cadastre, and a ribbon crossing it end to end.
const PARCEL = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
    parcelId: 'HR-A', PARCEL_ID: 'HR-A', BROJ_CESTICE: '1234/5'
});
// Well clear of the ribbon — a pan across open country.
const FAR_PARCEL = turf.polygon([[[1, 1], [1.001, 1], [1.001, 1.001], [1, 1.001], [1, 1]]], {
    parcelId: 'HR-B', PARCEL_ID: 'HR-B', BROJ_CESTICE: '9999/1'
});
const RIBBON = turf.polygon([[[0.0004, -0.0002], [0.0006, -0.0002], [0.0006, 0.0012], [0.0004, 0.0012], [0.0004, -0.0002]]]);

const layerFor = feature => ({ feature, toGeoJSON: () => JSON.parse(JSON.stringify(feature)) });

function buildWorld(loadedParcels) {
    const byId = new Map(loadedParcels.map(feature => [String(feature.properties.parcelId), layerFor(feature)]));
    const road = {
        proposalId: 'road-1',
        goal: 'road-track',
        applied: true,
        roadProposal: { definition: { polygon: RIBBON } }
    };

    const win = {
        parcelLayerById: byId,
        __parcelArrangement: arrangement,
        __planOrder: planOrder,
        __cadastreAncestry: {
            loadedCadastreParcels: () => Array.from(byId.entries())
                .filter(([id]) => String(id).indexOf('#') === -1)
                .map(([id, layer]) => ({ id, feature: layer.feature }))
        },
        removeParcelLayerById: id => byId.delete(String(id)),
        showParcelLayerById: () => { },
        hideParcelLayerById: () => { }
    };

    installGlobal('window', win);
    installGlobal('turf', turf);
    installGlobal('applyRoute', applyRoute);
    installGlobal('appliedOf', proposal => proposal?.applied === true);
    installGlobal('proposalStorage', {
        save: vi.fn(),
        getAllProposals: () => [road],
        getProposal: id => (String(id) === 'road-1' ? road : null)
    });

    const manager = {
        _addFeaturesToMap: features => features.forEach(feature => {
            byId.set(String(feature.properties.parcelId), layerFor(feature));
        }),
        _rebuildInProgress: false,
        _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
        _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
        _deriveCorridorFabricBody: ProposalManager._deriveCorridorFabricBody,
        _parcelsClaimedByDerivedGround: ProposalManager._parcelsClaimedByDerivedGround,
        deriveArrivingParcels: ProposalManager.deriveArrivingParcels
    };
    return { byId, manager };
}

const pieceIds = byId => Array.from(byId.keys()).filter(id => id.indexOf('#') !== -1);

describe('a parcel that arrives after the road did', () => {
    it('cuts it against the standing road instead of leaving it whole', async () => {
        const { byId, manager } = buildWorld([PARCEL]);
        // It came in from a tile fetch, so nothing has derived it yet.
        expect(pieceIds(byId)).toEqual([]);

        const fabric = await manager.deriveArrivingParcels(['HR-A']);

        expect(fabric).toBeTruthy();
        // The strip the road takes, plus the two remainders either side of it.
        expect(pieceIds(byId).length).toBe(3);
    });

    it('leaves an arrival no road reaches alone', async () => {
        const { byId, manager } = buildWorld([FAR_PARCEL]);

        expect(await manager.deriveArrivingParcels(['HR-B'])).toBeNull();
        expect(pieceIds(byId)).toEqual([]);
    });

    it('ignores piece ids — only cadastral parcels are derived', async () => {
        const { manager } = buildWorld([PARCEL]);
        expect(await manager.deriveArrivingParcels(['HR-A#1', 'HR-A#2'])).toBeNull();
    });

    it('stays out of the way of a whole-plan rebuild', async () => {
        const { byId, manager } = buildWorld([PARCEL]);
        manager._rebuildInProgress = true;

        expect(await manager.deriveArrivingParcels(['HR-A'])).toBeNull();
        expect(pieceIds(byId)).toEqual([]);
    });
});
