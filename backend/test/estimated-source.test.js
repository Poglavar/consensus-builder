import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createStore, belongsToCity, schema } = require('../../frontend/js/parcels/estimated-source.js');

// Covers persistence, source queries, and replacement guards for browser-local parcel estimates.
function memoryStorage(initial = new Map()) {
    return {
        values: initial,
        getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
        setItem(key, value) { this.values.set(key, String(value)); },
        removeItem(key) { this.values.delete(key); }
    };
}

const feature = (id, west = 15, south = 45) => ({
    type: 'Feature', id, properties: { area_m2: 250, generatorNote: 'kept', estimated: true,
        source_features: undefined, fetched_at: undefined, snapshot_at: undefined },
    geometry: { type: 'Polygon', coordinates: [[[west, south], [west + 0.001, south], [west + 0.001, south + 0.001], [west, south + 0.001], [west, south]]] }
});
const collection = (...features) => ({ type: 'FeatureCollection', features, demo: { stats: { groundCoverage: 0.7 }, retained: true } });
const input = (features, west = 14, south = 44) => ({ collection: collection(...features), imageUrl: 'data:image/png;base64,abc', bounds: [west, south, west + 2, south + 2] });

describe('estimated parcel local source', () => {
    it('persists across fresh stores with stable city-qualified IDs and provenance', () => {
        const storage = memoryStorage();
        const firstStore = createStore(storage);
        const saved = firstStore.save('fixture-city', input([feature('plot-1')]));
        const again = createStore(storage).read('fixture-city');
        const parcel = saved.collection.features[0];
        expect(saved.schema).toBe(schema);
        expect(again.collection.features[0].id).toBe(parcel.id);
        expect(parcel.id).toMatch(/^EST:[a-f0-9]{64}:[a-f0-9]{64}$/);
        expect(belongsToCity(parcel.id, 'fixture-city')).toBe(true);
        expect(belongsToCity(`${parcel.id}#p-park-1`, 'fixture-city')).toBe(true);
        expect(belongsToCity(parcel.id, 'other-city')).toBe(false);
        expect(belongsToCity('EST:invalid', 'fixture-city')).toBe(false);
        expect(belongsToCity(parcel.id, '')).toBe(false);
        expect(parcel.properties).toMatchObject({ parcelId: parcel.id, id: parcel.id, parcel_id: parcel.id,
            sourceId: expect.stringMatching(/^estimated-local:sha256:/), sourceParcelId: 'plot-1',
            estimated: true, provenance: 'imagery-estimate', accuracy: 'unvalidated',
            sourceIdentityKind: 'geometry-content', parcelIdentityKind: 'geometry-sha256-v1', generatorNote: 'kept' });
        expect(again.collection.demo).toEqual({ stats: { groundCoverage: 0.7 }, retained: true });
        expect(createStore(storage).save('other-city', input([feature('plot-1')])).collection.features[0].id).not.toBe(parcel.id);
        expect(createStore(storage).save('fixture-city', input([feature('plot-1', 16)])).collection.features[0].id).not.toBe(parcel.id);
    });

    it('serves defensive GeoJSON by cell, identity and geometry bbox, with active control', () => {
        const storage = memoryStorage();
        const store = createStore(storage);
        const saved = store.save('fixture-city', input([feature('inside'), feature('outside', 17, 47)]));
        const source = store.readSource('fixture-city');
        expect(source.kind).toBe('estimated-local');
        expect(source.describe()).toEqual({ kind: 'estimated-local' });
        expect(source.fetchCell({ latLonBbox: '14.9,44.9,15.1,45.1' }).features.map(f => f.id)).toEqual([saved.collection.features[0].id]);
        expect(source.fetchByIds([saved.collection.features[1].id, 'missing']).absentIds).toEqual(['missing']);
        expect(source.fetchUnderGeometry(feature('query').geometry).features.map(f => f.id)).toEqual([saved.collection.features[0].id]);
        const fetched = source.fetchByIds([saved.collection.features[0].id]).features[0];
        fetched.properties.estimated = false;
        expect(store.read('fixture-city').collection.features[0].properties.estimated).toBe(true);
        fetched.properties.estimated = true;
        const resaved = store.save('fixture-city', { ...input([fetched]), collection: collection(fetched) });
        expect(resaved.collection.features[0].properties.sourceParcelId).toBe('inside');
        expect(store.setActive('fixture-city', false).active).toBe(false);
        expect(store.readSource('fixture-city')).toBeNull();
        expect(store.setActive('fixture-city', true).active).toBe(true);
        expect(store.readSource('fixture-city')).not.toBeNull();
    });

    it('rejects invalid data, preserves old data on storage failure, and guards referenced removals', () => {
        const storage = memoryStorage();
        const store = createStore(storage);
        const saved = store.save('fixture-city', input([feature('keep'), feature('remove', 16)]));
        expect(() => store.save('fixture-city', input([feature('keep')]), { referencedIds: [saved.collection.features[1].id] }))
            .toThrow(expect.objectContaining({ code: 'estimate-in-use' }));
        expect(store.read('fixture-city').collection.features).toHaveLength(2);
        expect(() => store.save('fixture-city', input([feature('keep', 181)]))).toThrow();
        expect(store.read('fixture-city').collection.features).toHaveLength(2);
        expect(() => store.save('fixture-city', { ...input([feature('keep')]), bounds: [null, 44, 46, 46] })).toThrow();
        expect(() => store.save('fixture-city', { ...input([feature('keep')]), bounds: [15, 45, 15, 46] })).toThrow();
        const throwingStorage = {
            getItem: storage.getItem.bind(storage),
            setItem() { throw new Error('quota exceeded'); },
            removeItem: storage.removeItem.bind(storage)
        };
        expect(() => createStore(throwingStorage).save('fixture-city', input([feature('new')]))).toThrow(expect.objectContaining({ code: 'estimate-storage' }));
        expect(store.read('fixture-city').collection.features).toHaveLength(2);
        expect(store.save('fixture-city', input([feature('keep')]), { referencedIds: [saved.collection.features[0].id] }).collection.features).toHaveLength(1);
        const empty = store.save('fixture-city', input([]), { referencedIds: [] });
        expect(empty.collection.features).toEqual([]);
        storage.setItem('cb_estimated_parcels:bad', '{');
        expect(() => store.read('bad')).toThrow(expect.objectContaining({ code: 'estimate-corrupt' }));
    });

    it('keeps the previous source when a storage read fails and restores it after a bad readback', () => {
        const storage = memoryStorage();
        const store = createStore(storage);
        const previous = store.save('fixture-city', input([feature('keep')]));
        let reads = 0;
        const unreadable = { ...storage, getItem(key) {
            if (++reads === 2) throw new Error('read denied');
            return storage.getItem(key);
        } };
        expect(() => createStore(unreadable).save('fixture-city', input([feature('new', 16)])))
            .toThrow(expect.objectContaining({ code: 'estimate-storage' }));
        expect(store.read('fixture-city').collection.features[0].id).toBe(previous.collection.features[0].id);

        let writes = 0;
        const corrupting = { ...storage, setItem(key, value) {
            storage.setItem(key, ++writes === 1 ? '{}' : value);
        } };
        expect(() => createStore(corrupting).save('fixture-city', input([feature('new', 16)])))
            .toThrow(expect.objectContaining({ code: 'estimate-storage' }));
        expect(store.read('fixture-city').collection.features[0].id).toBe(previous.collection.features[0].id);
    });
});
