// What the ingest does to a pan.
//
// Panning into unvisited ground lands a fetch of a few thousand parcels, and the ingest used to
// hurt the drag three ways: a whole-list prep pass (up to ~90 ms synchronous before any layer was
// built), a repaint scheduled per added batch (each repainting the dirtied region), and yields on a
// COUNT of features rather than on the clock. These tests run the real ingest in a vm with a fake
// Leaflet whose canvas records exactly the calls the real one would receive.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ingest.js', import.meta.url), 'utf8');

function makeContext({ geoJsonThrowsAt = null } = {}) {
    const members = new Set();
    const byId = new Map();
    const cache = { byId: new Map() };
    const log = [];
    let geoJsonCalls = 0;

    // A Leaflet whose Canvas carries the 1.9.4 internals the subclass extends. The base methods
    // record themselves so the hold's behaviour is observed, not assumed.
    class BaseCanvas {
        constructor(options) { this.options = options; this._map = {}; }
        _requestRedraw(layer) { log.push('schedule-redraw'); if (layer) this._extendRedrawBounds(layer); }
        _extendRedrawBounds() { log.push('extend-bounds'); }
        _draw() { log.push('draw'); }
        _redraw() { log.push('redraw'); }
    }
    BaseCanvas.extend = function (overrides) {
        class Sub extends BaseCanvas { }
        Object.assign(Sub.prototype, overrides);
        return Sub;
    };

    const context = {
        console,
        performance,
        Map,
        Set,
        Promise,
        setTimeout,
        clearTimeout,
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        dispatchEvent() { },
        convertGeoJSON: value => value,
        ensureParcelLayerInitialized() { },
        addParcelLayerToMapIfAppropriate() { },
        getParcelStyle: () => ({}),
        isParcelReplacedByChildren: () => false,
        yieldToBrowser: async () => { log.push('yield'); },
        fastRemoveParcelLayersByIds: (ids) => { log.push(`remove:${ids.size}`); return ids.size; },
        parcelLayerById: byId,
        ParcelsState: { getParcelCache: () => cache, bumpParcelCoverageVersion() { } },
        parcelLayer: {
            // Real Leaflet fires renderer._requestRedraw from the layer's onAdd — that per-add
            // repaint request is the exact thing the hold exists to absorb, so the fake must make
            // it or the hold has nothing to prove.
            addLayer(layer) {
                members.add(layer);
                log.push('add');
                if (layer.__renderer && typeof layer.__renderer._requestRedraw === 'function') {
                    layer.__renderer._requestRedraw(layer);
                }
            },
            removeLayer(layer) { members.delete(layer); },
            hasLayer(layer) { return members.has(layer); }
        },
        setParcelLayerById(id, layer) { byId.set(String(id), layer); },
        hideParcelLayerById() { return false; },
        indexParcelLayer() { },
        L: {
            Canvas: BaseCanvas,
            Util: { requestAnimFrame: (fn, ctx) => { log.push('raf'); fn.call(ctx); return 1; } },
            canvas: (options) => new BaseCanvas(options),
            geoJSON(collection, options) {
                geoJsonCalls += 1;
                if (geoJsonThrowsAt !== null && geoJsonCalls === geoJsonThrowsAt) {
                    throw new Error('boom mid-ingest');
                }
                const layers = collection.features.map(feature => {
                    const layer = { feature, options: {}, on() { }, __renderer: options.renderer, _pxBounds: {} };
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
    return { context, byId, cache, members, log };
}

const parcel = (id) => ({
    type: 'Feature',
    properties: { parcelId: id },
    geometry: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]] }
});
const many = (count, prefix = 'HR') => Array.from({ length: count }, (_, i) => parcel(`${prefix}-${i}`));

describe('redraws are held for the whole ingest', () => {
    it('adds N batches under ONE hold: bounds extend throughout, one repaint on release', async () => {
        const { context, members, log } = makeContext();
        await context.ingestParcelFeatures(many(300), { skipConversion: true });

        expect(members.size).toBe(300);
        // Under the hold, adds extend the dirty rect but schedule nothing…
        expect(log.filter(entry => entry === 'schedule-redraw')).toHaveLength(0);
        // …and the release schedules exactly one repaint for everything.
        expect(log.filter(entry => entry === 'raf')).toHaveLength(1);
        // The repaint comes AFTER the last layer went in.
        expect(log.lastIndexOf('add')).toBeLessThan(log.indexOf('raf'));
    });

    it('releases the hold even when a batch throws — a stuck hold swallows every later repaint', async () => {
        const { context, log } = makeContext({ geoJsonThrowsAt: 2 });
        await context.ingestParcelFeatures(many(300), { skipConversion: true });
        // The first batch's adds still dirtied the canvas, so the release must still repaint.
        expect(log.filter(entry => entry === 'raf')).toHaveLength(1);
    });
});

describe('the work is interleaved, not phased', () => {
    it('with replaceExisting, each slice removes ITS ancestors before ITS adds', async () => {
        const { context, byId, members, log } = makeContext();
        // Pre-existing layers for every id, so each is a replacement.
        many(240).forEach(feature => {
            const layer = { feature };
            members.add(layer);
            byId.set(String(feature.properties.parcelId), layer);
        });
        await context.ingestParcelFeatures(many(240), { skipConversion: true, replaceExisting: true });

        const removes = log.filter(entry => entry.startsWith('remove:'));
        // More than one remove call = the removal was per slice, not one up-front sweep…
        expect(removes.length).toBeGreaterThan(1);
        // …and every slice's removal precedes its own adds: the first add comes after the first
        // remove, and more adds follow the LAST remove (the final slice's).
        expect(log.indexOf('add')).toBeGreaterThan(log.findIndex(entry => entry.startsWith('remove:')));
        const lastRemoveAt = log.length - 1 - [...log].reverse().findIndex(entry => entry.startsWith('remove:'));
        expect(log.lastIndexOf('add')).toBeGreaterThan(lastRemoveAt);
    });

    it('still skips parcels already on the map, and still fills the store for every feature', async () => {
        const { context, cache, members } = makeContext();
        await context.ingestParcelFeatures(many(50), { skipConversion: true });
        const again = await context.ingestParcelFeatures(many(50), { skipConversion: true });
        expect(again).toHaveLength(0);
        expect(members.size).toBe(50);
        expect(cache.byId.size).toBe(50);
    });
});

describe('the derivation breathes on the clock', () => {
    const manager = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
    const body = manager.slice(
        manager.indexOf('async _deriveCorridorFabricBody(options = {}) {'),
        manager.indexOf('const undecided = new Set(')
    );

    it('yields when 12 ms have passed, not every Nth item', () => {
        expect(body).toContain('const breatheIfDue = async () => {');
        expect(body).toContain('>= 12');
        expect(body).not.toContain('await breathe();\n        }');
    });

    it('clips ONE parcel per step, so the clock is consulted between clips', () => {
        // fabricOver over a 40-parcel slice was itself an unbreakable 20-120 ms block — a budget
        // consulted every 40th step bounds nothing.
        expect(body).toContain('A.fabricOver(parcels.slice(i, i + 1), takes, hitsById)');
    });

    it('the filter hands its intersections to the clip loop instead of recomputing them', () => {
        // takesOverlapping-then-arrangementOf ran every (parcel × take) exact clip twice: once to
        // decide the parcel mattered, once to arrange it. The filter now keeps what it computed.
        expect(body).toContain('A.takeHitsOn(entry.feature, takes)');
        expect(body).not.toContain('A.takesOverlapping(');
        expect(body).toContain("hitsById.set(String(entry.id), hits)");
    });
});

describe('the repaint cost is measured, not guessed', () => {
    it('the shared canvas keeps stats and mapLoad prints them', () => {
        const ingest = source;
        expect(ingest).toContain('fullDraws');
        expect(ingest).toContain("global.__parcelCanvasStats = stats;");
        const mapLoad = readFileSync(new URL('../../frontend/js/map-load-debug.js', import.meta.url), 'utf8');
        expect(mapLoad).toContain('__parcelCanvasStats');
        expect(mapLoad).toContain('full repaints');
    });
});
