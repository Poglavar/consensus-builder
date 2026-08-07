import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ingest.js', import.meta.url), 'utf8');

function makeContext({ replaced }) {
    const members = new Set();
    const byId = new Map();
    const cache = { byId: new Map() };
    const context = {
        console,
        performance,
        Map,
        Set,
        setTimeout,
        clearTimeout,
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        dispatchEvent() {},
        convertGeoJSON: value => value,
        ensureParcelLayerInitialized() {},
        addParcelLayerToMapIfAppropriate() {},
        getParcelStyle: () => ({}),
        isParcelReplacedByChildren: () => replaced,
        parcelLayerById: byId,
        ParcelsState: {
            getParcelCache: () => cache,
            bumpParcelCoverageVersion() {}
        },
        parcelLayer: {
            addLayer(layer) { members.add(layer); },
            removeLayer(layer) { members.delete(layer); },
            hasLayer(layer) { return members.has(layer); }
        },
        setParcelLayerById(id, layer) { byId.set(String(id), layer); },
        hideParcelLayerById(id) {
            const layer = byId.get(String(id));
            if (!layer) return false;
            members.delete(layer);
            return true;
        },
        indexParcelLayer() {},
        L: {
            geoJSON(collection, options) {
                const layers = collection.features.map(feature => {
                    const layer = { feature, options: {}, on() {} };
                    options.onEachFeature(feature, layer);
                    return layer;
                });
                return { eachLayer(callback) { layers.forEach(callback); } };
            }
        }
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return { context, byId, cache, members };
}

function parcel(id) {
    return {
        type: 'Feature',
        properties: { parcelId: id },
        geometry: {
            type: 'Polygon',
            coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]]
        }
    };
}

describe('cadastral ingest under a standing formation', () => {
    it('indexes claimed cadastral ground but keeps it hidden from the live partition', async () => {
        const { context, byId, cache, members } = makeContext({ replaced: true });

        await context.ingestParcelFeatures([parcel('HR-1')], { skipConversion: true });

        expect(byId.has('HR-1')).toBe(true);
        expect(cache.byId.has('HR-1')).toBe(true);
        expect(members.has(byId.get('HR-1'))).toBe(false);
    });

    it('shows unclaimed cadastral ground', async () => {
        const { context, byId, members } = makeContext({ replaced: false });

        await context.ingestParcelFeatures([parcel('HR-2')], { skipConversion: true });

        expect(members.has(byId.get('HR-2'))).toBe(true);
    });
});
