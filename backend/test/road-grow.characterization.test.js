// Characterization test for the additive half of a road merge (proposals/apply/road-grow.js).
// Both methods are I/O orchestration, so we assert their OBSERVABLE EFFECTS: which parcels are
// re-formed, which are left strictly alone, and what ends up recorded on the road. Deleting the
// growth tail — or widening it to touch parcels the drawing never reached — makes these fail.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const roadGrow = require('../../frontend/js/proposals/apply/road-grow.js');
const corridorGrow = require('../../frontend/js/proposals/corridor-grow.js');

const GLOBAL_KEYS = [
    '_normalizeProposalId', '_getParcelIdFromFeature', '_ensureParcelIdOnProperties',
    '_buildSyntheticToken', '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties',
    '_extractRootParcelId', '_extractRootParcelNumber', '_assignOwnershipDetails', 'corridorIsTrack',
    'proposalStorage', 'turf', 'window'
];
const saved = {};

function spy(retval) {
    const fn = (...args) => { fn.calls.push(args); return typeof retval === 'function' ? retval(...args) : retval; };
    fn.calls = [];
    return fn;
}

const box = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});

function parcelFeature(id, geometry, extraProps = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, BROJ_CESTICE: id, rootParcelId: id, rootParcelNumber: id, ...extraProps },
        geometry
    };
}

let hidden;
let mapLayers;

beforeEach(() => {
    GLOBAL_KEYS.forEach(key => { saved[key] = globalThis[key]; });
    hidden = [];
    mapLayers = [];

    globalThis._normalizeProposalId = value => (value === undefined || value === null ? '' : String(value));
    globalThis._getParcelIdFromFeature = feature => feature?.properties?.parcelId ?? null;
    globalThis._ensureParcelIdOnProperties = (props, id) => { props.parcelId = id; };
    globalThis._buildSyntheticToken = value => String(value);
    globalThis._extractRootParcelId = value => String(value || '').split('#')[0];
    globalThis._extractRootParcelNumber = value => String(value || '').split('#')[0];
    globalThis._resolveRootParcelIdFromProperties = (props, fallback) =>
        globalThis._extractRootParcelId(props?.rootParcelId || props?.parentParcelId || props?.parcelId || fallback);
    globalThis._resolveRootParcelNumberFromProperties = props =>
        globalThis._extractRootParcelNumber(props?.rootParcelNumber || props?.BROJ_CESTICE || 'parcel');
    globalThis._assignOwnershipDetails = () => { };
    globalThis.corridorIsTrack = () => false;
    globalThis.turf = turf;
    globalThis.proposalStorage = { save: spy(), _indexProposal: spy() };
    globalThis.window = {
        __corridorGrow: corridorGrow,
        turf,
        parcelLayer: { eachLayer: callback => mapLayers.forEach(callback) },
        hideParcelLayerById: id => { hidden.push(String(id)); },
        addRoadParcel: () => { },
        isRoadParcel: () => false
    };
});

afterEach(() => {
    GLOBAL_KEYS.forEach(key => {
        if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
    });
});

// A ProposalManager-shaped `this`: the growth methods themselves are real, their collaborators spies.
function makeManager(overrides = {}) {
    let minted = 0;
    const manager = Object.assign({}, roadGrow, {
        _addFeaturesToMap: spy(),
        _persistParcelFeature: spy(),
        _addProposalAsAncestor: spy(),
        _setDescendantProposalOnParcels: spy(),
        _markParcelsModifiedBatch: spy(),
        _upsertParcelProperties: spy(),
        _getParcelLayerById: () => null,
        // The numbering itself is unit-tested in corridor-grow.test.js; here we only record that
        // the growth hands it the continuation, and give every new feature an id so work proceeds.
        _assignSyntheticChildIdentities: spy(function (proposalId, features) {
            features.forEach(feature => { feature.properties.parcelId = `minted-${++minted}`; });
        })
    }, overrides);
    return manager;
}

describe('_growRoadFabricForCorridor', () => {
    // The road already runs along the west; the drawing added the strip to its east.
    const newGround = box(15.8830, 43.7300, 15.8835, 43.7320);
    const underIt = parcelFeature('HR-1', box(15.8820, 43.7305, 15.8845, 43.7315));
    const farAway = parcelFeature('HR-9', box(15.8700, 43.7200, 15.8710, 43.7210));
    const ownCorridor = parcelFeature('HR-old#road-1', box(15.8831, 43.7302, 15.8834, 43.7312), {
        isCorridor: true, proposalId: 'road-1'
    });

    function hostRecord() {
        return {
            proposalId: 'road-1',
            title: 'Ulica',
            parentParcelIds: ['HR-old'],
            childParcelIds: ['HR-old#road-1-1'],
            roadProposal: {
                definition: { width: 10 },
                parentParcelIds: ['HR-old'],
                childParcelIds: ['HR-old#road-1-1']
            }
        };
    }

    it('re-forms the parcels under the new ground and nothing else', () => {
        mapLayers = [{ feature: underIt }, { feature: farAway }];
        const manager = makeManager();
        const host = hostRecord();

        const summary = manager._growRoadFabricForCorridor('road-1', host, { newGround });

        expect(summary).toEqual({ corridorParcels: 1, cutParcels: 1, consumedParcels: 0 });
        expect(hidden).toEqual(['HR-1']);
        // The distant parcel is never persisted, never re-parented, never hidden.
        const persistedIds = manager._persistParcelFeature.calls.map(([feature]) => feature.properties.parentParcelId);
        expect(persistedIds).not.toContain('HR-9');
        expect(host.parentParcelIds).not.toContain('HR-9');
    });

    it('adds to the road instead of replacing what it already formed', () => {
        mapLayers = [{ feature: underIt }];
        const manager = makeManager();
        const host = hostRecord();

        manager._growRoadFabricForCorridor('road-1', host, { newGround });

        expect(host.childParcelIds).toContain('HR-old#road-1-1'); // the road's existing fabric survives
        expect(host.childParcelIds.length).toBeGreaterThan(1);
        expect(host.parentParcelIds).toEqual(expect.arrayContaining(['HR-old', 'HR-1']));
        // The record and its roadProposal mirror stay the same set.
        expect(host.roadProposal.childParcelIds).toEqual(host.childParcelIds);
        expect(host.roadProposal.parentParcelIds).toEqual(host.parentParcelIds);
    });

    it('never cuts ground the road (or a road merging into it) already holds', () => {
        mapLayers = [{ feature: ownCorridor }];
        const manager = makeManager();
        const host = hostRecord();

        const summary = manager._growRoadFabricForCorridor('road-1', host, { newGround });

        expect(summary.cutParcels).toBe(0);
        expect(hidden).toEqual([]);
    });

    it('leaves an absorbed road’s corridor alone as well', () => {
        const absorbedCorridor = parcelFeature('HR-b#road-2', box(15.8831, 43.7302, 15.8834, 43.7312), {
            isCorridor: true, proposalId: 'road-2'
        });
        mapLayers = [{ feature: absorbedCorridor }];
        const manager = makeManager();

        const summary = manager._growRoadFabricForCorridor('road-1', hostRecord(), {
            newGround,
            absorbedProposalIds: ['road-2']
        });

        expect(summary.cutParcels).toBe(0);
    });

    it('continues the road’s slice numbering instead of restarting it', () => {
        mapLayers = [{ feature: underIt }];
        const manager = makeManager();
        const host = hostRecord();
        host.childParcelIds = ['HR-old#road-1-1', 'HR-old#road-1-7'];
        host.roadProposal.childParcelIds = host.childParcelIds.slice();

        manager._growRoadFabricForCorridor('road-1', host, { newGround });

        const [, , options] = manager._assignSyntheticChildIdentities.calls[0];
        expect(options.startIndexByRootId['HR-old']).toBe(8);
    });

    it('marks a parcel it covers whole as consumed and keeps no remainder', () => {
        const swallowed = parcelFeature('HR-2', box(15.88305, 43.73055, 15.88345, 43.73145));
        mapLayers = [{ feature: swallowed }];
        const manager = makeManager();
        const host = hostRecord();

        const summary = manager._growRoadFabricForCorridor('road-1', host, { newGround });

        expect(summary).toMatchObject({ cutParcels: 1, consumedParcels: 1 });
        expect(hidden).toEqual(['HR-2']);
        // One feature only: the corridor piece. No remainder was minted for a parcel with none.
        const added = manager._addFeaturesToMap.calls[0][0];
        expect(added).toHaveLength(1);
        expect(added[0].properties.isCorridor).toBe(true);
    });

    it('does nothing at all when the drawing added no ground', () => {
        mapLayers = [{ feature: underIt }];
        const manager = makeManager();
        expect(manager._growRoadFabricForCorridor('road-1', hostRecord(), { newGround: null })).toBeNull();
        expect(manager._addFeaturesToMap.calls).toHaveLength(0);
        expect(hidden).toEqual([]);
    });
});

describe('_adoptCorridorFabric', () => {
    it('moves an absorbed road’s parcels to the host without touching the map', () => {
        const manager = makeManager();
        const host = {
            proposalId: 'road-1', title: 'Ulica',
            parentParcelIds: ['HR-old'], childParcelIds: ['HR-old#road-1-1'],
            roadProposal: { parentParcelIds: ['HR-old'], childParcelIds: ['HR-old#road-1-1'] }
        };
        const absorbed = {
            proposalId: 'road-2',
            parentParcelIds: ['HR-b'], childParcelIds: ['HR-b#road-2-1', 'HR-b#road-2-2'],
            roadProposal: { parentParcelIds: ['HR-b'], childParcelIds: ['HR-b#road-2-1'] }
        };

        const result = manager._adoptCorridorFabric('road-2', absorbed, 'road-1', host);

        expect(result).toEqual({ adoptedParcels: 2, adoptedParents: 1 });
        expect(host.childParcelIds).toEqual(expect.arrayContaining(['HR-old#road-1-1', 'HR-b#road-2-1', 'HR-b#road-2-2']));
        expect(host.parentParcelIds).toEqual(expect.arrayContaining(['HR-old', 'HR-b']));
        // Ownership changes on the parcels themselves...
        expect(manager._upsertParcelProperties.calls.map(([id]) => id))
            .toEqual(['HR-b#road-2-1', 'HR-b#road-2-2']);
        const props = { isCorridor: true };
        manager._upsertParcelProperties.calls[0][1](props);
        expect(props.proposalId).toBe('road-1');
        expect(props.ancestorProposal).toBe('road-1');
        expect(props.roadName).toBe('Ulica');
        // ...and nothing is re-cut or re-drawn.
        expect(manager._addFeaturesToMap.calls).toHaveLength(0);
        expect(hidden).toEqual([]);
    });
});
