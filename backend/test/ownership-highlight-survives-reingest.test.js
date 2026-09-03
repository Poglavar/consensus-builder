// Ownership classification is derived from authoritative fabric features and cached only for the
// current city + fabric revision. Leaflet features are presentation data and are never stamped.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SAVED = {};
const KEYS = ['ParcelsOwnershipHighlight', 'LiveParcelFabric', 'ParcelPresenter', 'CityConfigManager', 'refreshParcelStylesForAppliedProposals', 'getOwnershipType', 'map'];

function layerFor(parcelId, properties = {}) {
    return { feature: { type: 'Feature', properties: { parcelId, ...properties }, geometry: null } };
}

let refreshes;
let revision;
let layers;

beforeEach(() => {
    KEYS.forEach(key => { SAVED[key] = globalThis[key]; });
    refreshes = 0;
    revision = 1;
    layers = [];
    globalThis.refreshParcelStylesForAppliedProposals = () => { refreshes += 1; };
    globalThis.getOwnershipType = label => (String(label).includes('GRAD') ? 'government' : 'private individual');
    globalThis.CityConfigManager = { getCurrentCityId: () => 'sibenik' };
    globalThis.LiveParcelFabric = {
        snapshot: () => ({ revision }),
        featureId: feature => feature?.properties?.parcelId || null,
        list: () => layers.map(layer => layer.feature),
        get: id => layers.find(layer => layer.feature.properties.parcelId === String(id))?.feature || null
    };
    globalThis.ParcelPresenter = {
        getIdForLayer: candidate => layers.includes(candidate) ? candidate.feature.properties.parcelId : null
    };
    globalThis.map = null;
    delete globalThis.ParcelsOwnershipHighlight;
    // Fresh module state per test: the cache is the thing under test.
    delete require.cache[require.resolve('../../frontend/js/parcels/ownership-highlight.js')];
    require('../../frontend/js/parcels/ownership-highlight.js');
});

afterEach(() => {
    KEYS.forEach(key => {
        if (SAVED[key] === undefined) delete globalThis[key]; else globalThis[key] = SAVED[key];
    });
});

function setFabricLayers(nextLayers) {
    layers = nextLayers;
}

describe('ownership type follows the live fabric revision', () => {
    it('answers a presentation-layer query from the authoritative feature', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        const classified = layerFor('HR-1', { ownershipType: 'government' });
        setFabricLayers([classified]);
        await api.calculateOwnershipTypesForAllParcels();

        expect(api.typeFor(classified)).toBe('government');
    });

    it('does not return a classification cached for an older fabric revision', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        setFabricLayers([layerFor('HR-1', { ownershipType: 'company' })]);
        await api.calculateOwnershipTypesForAllParcels();

        const replacement = layerFor('HR-1', { ownershipList: [{ ownerLabel: 'GRAD ŠIBENIK' }] });
        revision = 2;
        setFabricLayers([replacement]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(api.typeFor(replacement)).toBe('government');
    });

    it('classifies ground without mutating its feature', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        const fresh = layerFor('HR-2', { ownershipList: [{ ownerLabel: 'GRAD ŠIBENIK' }] });
        setFabricLayers([fresh]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(fresh.feature.properties.ownershipType).toBeUndefined();
        expect(api.typeFor(fresh)).toBe('government');
    });

    it('repaints after every pass, so a classified parcel shows up without another event', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        setFabricLayers([layerFor('HR-1', { ownershipType: 'government' })]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(refreshes).toBeGreaterThan(0);
    });

    it('has no answer for ground it has never seen', () => {
        const unknown = layerFor('HR-999');
        setFabricLayers([unknown]);
        setFabricLayers([]);
        expect(globalThis.ParcelsOwnershipHighlight.typeFor(unknown)).toBeNull();
    });
});

describe('styleFor', () => {
    it('gives private individual a red fill, distinct from government blue', () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        expect(api.styleFor('private individual').fillColor).toBe('#e74c3c');
        expect(api.styleFor('government').fillColor).toBe('#4a90e2');
        expect(api.styleFor('nonsense')).toBeNull();
    });
});
