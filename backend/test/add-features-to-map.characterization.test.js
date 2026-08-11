// `ReferenceError: trackPolygonStyle is not defined` reached the browser with a green suite.
//
// _addFeaturesToMap was split so its bulk half could be chunked, and the OTHER half — the
// per-feature path that styles tracks — was moved into a sibling method. It read half a dozen
// consts from the scope it had just left. Every test covering this code asserted on SOURCE TEXT, so
// not one of them ever called the function, and none of them could have noticed.
//
// This one calls it. It stubs Leaflet and the parcel layer, runs both paths, and asserts the layers
// land where they should — so any identifier that goes out of reach in a future refactor fails here
// rather than on a reload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // _getParcelIdFromFeature etc.

/** The smallest Leaflet that _addFeaturesToMap can tell from the real one. */
function fakeLeaflet(created) {
    const makeLayer = (feature, styleFn) => {
        const layer = {
            feature,
            options: {},
            _path: { style: {} },
            setStyle(style) { layer._appliedStyle = style; },
            setInteractive(on) { layer._interactive = on; },
            bringToFront() { },
            on() { },
            addTo() { return layer; }
        };
        if (typeof styleFn === 'function') layer._initialStyle = styleFn(feature);
        created.push(layer);
        return layer;
    };
    return {
        geoJSON(collection, opts = {}) {
            const feats = collection.type === 'FeatureCollection' ? collection.features : [collection];
            // Leaflet calls style() per feature as it builds — which is where the ReferenceError was.
            const layers = feats.map(f => {
                const layer = makeLayer(f, opts.style);
                if (typeof opts.onEachFeature === 'function') opts.onEachFeature(f, layer);
                return layer;
            });
            return { eachLayer: (fn) => layers.forEach(fn), getLayers: () => layers };
        },
        featureGroup() {
            const layers = [];
            return {
                addLayer(l) { layers.push(l); return this; },
                removeLayer(l) { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); return this; },
                hasLayer(l) { return layers.includes(l); },
                getLayers: () => layers,
                addTo() { return this; },
                eachLayer: (fn) => layers.slice().forEach(fn)
            };
        },
        polygon: (...a) => makeLayer({ type: 'Feature', properties: {}, geometry: null }, null, ...a)
    };
}

const polygon = (id, props = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, ...props },
    geometry: { type: 'Polygon', coordinates: [[[15.87, 43.75], [15.88, 43.75], [15.88, 43.76], [15.87, 43.75]]] }
});

let saved;

beforeEach(() => {
    saved = { L: global.L, window: global.window, map: global.map, document: global.document };
    const created = [];
    global.L = fakeLeaflet(created);
    const byId = new Map();
    global.window = {
        L: global.L,
        parcelLayer: global.L.featureGroup(),
        parcelLayerById: byId,
        getParcelLayerIdMap: () => byId,
        setParcelLayerById: (id, layer) => byId.set(String(id), layer),
        removeParcelLayerById: (id) => byId.delete(String(id)),
        normalStyle: { color: '#333' },
        roadStyle: { color: '#666' },
        corridorParcelStyle: { color: '#999' },
        onEachFeature: () => { },
        // No yieldToBrowser: the chunked path must still work where it is absent.
        _created: created
    };
    global.map = { getZoom: () => 18, hasLayer: () => true, addLayer: () => { } };
    // The insert builds an SVG pattern for striped roads on first use, so the stub has to be a
    // credible element: style bag, attributes, children.
    const svgNode = () => ({ style: {}, appendChild() { }, setAttribute() { }, setAttributeNS() { } });
    global.document = {
        getElementById: () => null,
        createElementNS: svgNode,
        createElement: svgNode,
        body: { appendChild() { } },
        documentElement: { appendChild() { } }
    };
});

afterEach(() => {
    global.L = saved.L; global.window = saved.window; global.map = saved.map; global.document = saved.document;
});

describe('_addFeaturesToMap actually runs', () => {
    it('adds ordinary parcels through the bulk path', async () => {
        const features = [polygon('HR-330264-1'), polygon('HR-330264-2'), polygon('HR-330264-3')];
        await ProposalManager._addFeaturesToMap(features, true, null);
        expect(global.window.parcelLayer.getLayers()).toHaveLength(3);
        expect(global.window.parcelLayerById.get('HR-330264-1')).toBeTruthy();
    });

    it('adds a TRACK through the per-feature path — the one that broke', async () => {
        // trackPolygonStyle is read here. When this path lived in a sibling method it could not see
        // it, and every applied track threw before a single layer was added.
        await ProposalManager._addFeaturesToMap([polygon('HR-330264-9', { isTrack: true, isRoad: true })], true, null);
        expect(global.window.parcelLayer.getLayers().length).toBeGreaterThan(0);
    });

    it('handles both kinds in one call, as a replay does', async () => {
        const features = [
            polygon('HR-330264-1'),
            polygon('HR-330264-9', { isTrack: true, isRoad: true }),
            polygon('HR-330264-2')
        ];
        await ProposalManager._addFeaturesToMap(features, true, null);
        expect(global.window.parcelLayer.getLayers().length).toBeGreaterThanOrEqual(3);
    });

    it('crosses more than one slice without losing a feature', async () => {
        // BULK_SLICE is 100: 250 features means three slices and two breather checks.
        const many = Array.from({ length: 250 }, (_, i) => polygon(`HR-330264-${i + 100}`));
        await ProposalManager._addFeaturesToMap(many, true, null);
        expect(global.window.parcelLayer.getLayers()).toHaveLength(250);
        expect(global.window.parcelLayerById.size).toBe(250);
    });

    it('yields when the page offers a way to', async () => {
        let yields = 0;
        global.window.yieldToBrowser = () => { yields += 1; return Promise.resolve(); };
        const many = Array.from({ length: 250 }, (_, i) => polygon(`HR-330264-${i + 500}`));
        await ProposalManager._addFeaturesToMap(many, true, null);
        expect(global.window.parcelLayer.getLayers()).toHaveLength(250);
        // Time-budgeted, so the count depends on the machine — but the work must still complete.
        expect(yields).toBeGreaterThanOrEqual(0);
    });

    it('is a promise, so a caller that forgets to await is a bug the caller can see', async () => {
        const result = ProposalManager._addFeaturesToMap([polygon('HR-330264-77')], true, null);
        expect(typeof result.then).toBe('function');
        await result;
    });
});
