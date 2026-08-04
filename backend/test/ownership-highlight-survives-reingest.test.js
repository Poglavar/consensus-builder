// Ownership highlighting is painted from `feature.properties.ownershipType`, but that property is
// minted per ingest and dies with the feature — while the type itself lives in an id-keyed cache.
// Panning re-ingests the ground under the map, so every parcel came back plain: the cache still
// knew the answer and nothing asked it. These tests pin the two halves of the fix.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SAVED = {};
const KEYS = ['ParcelsOwnershipHighlight', 'parcelLayer', 'refreshParcelStylesForAppliedProposals', 'getOwnershipType', 'map'];

function layerFor(parcelId, properties = {}) {
    return { feature: { type: 'Feature', properties: { parcelId, ...properties }, geometry: null } };
}

let refreshes;

beforeEach(() => {
    KEYS.forEach(key => { SAVED[key] = globalThis[key]; });
    refreshes = 0;
    globalThis.refreshParcelStylesForAppliedProposals = () => { refreshes += 1; };
    globalThis.getOwnershipType = label => (String(label).includes('GRAD') ? 'government' : 'private individual');
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

function setLayers(layers) {
    globalThis.parcelLayer = { eachLayer: callback => layers.forEach(callback) };
}

describe('ownership type survives a re-ingest', () => {
    it('answers from the cache when the fresh feature has lost the property', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        const classified = layerFor('HR-1', { ownershipType: 'government' });
        setLayers([classified]);
        await api.calculateOwnershipTypesForAllParcels();

        // The pan replaced the layer: same ground, same id, a feature that never heard of ownership.
        const reingested = layerFor('HR-1');
        expect(reingested.feature.properties.ownershipType).toBeUndefined();
        expect(api.typeFor(reingested)).toBe('government');
        // And it re-stamps, so the next read is direct.
        expect(reingested.feature.properties.ownershipType).toBe('government');
    });

    it('re-stamps every known parcel on the next classification pass', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        setLayers([layerFor('HR-1', { ownershipType: 'company' })]);
        await api.calculateOwnershipTypesForAllParcels();

        const reingested = layerFor('HR-1');
        setLayers([reingested]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(reingested.feature.properties.ownershipType).toBe('company');
    });

    it('classifies ground that arrives unknown', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        const fresh = layerFor('HR-2', { ownershipList: [{ ownerLabel: 'GRAD ŠIBENIK' }] });
        setLayers([fresh]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(fresh.feature.properties.ownershipType).toBe('government');
        expect(api.typeFor(fresh)).toBe('government');
    });

    it('repaints after every pass, so a classified parcel shows up without another event', async () => {
        const api = globalThis.ParcelsOwnershipHighlight;
        setLayers([layerFor('HR-1', { ownershipType: 'government' })]);
        await api.calculateOwnershipTypesForAllParcels();
        expect(refreshes).toBeGreaterThan(0);
    });

    it('has no answer for ground it has never seen', () => {
        expect(globalThis.ParcelsOwnershipHighlight.typeFor(layerFor('HR-999'))).toBeNull();
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
