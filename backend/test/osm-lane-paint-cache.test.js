// A street's lanes do not change when the map moves, so panning must not recompute them. This drives
// the real layer — enable, then pan by firing the map's own `moveend`, exactly as Leaflet would —
// against a stubbed Leaflet and map, and COUNTS the work: how many cross-sections were reconstructed,
// how many times the OSM ways were fetched, how many polygons were built. Without the cache every one
// of those numbers grows with every pan, which is the bug this exists to keep fixed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const segmentation = require(path.join(here, '../../frontend/js/road-segmentation.js'));
const translatorModule = require(path.join(here, '../../frontend/js/osm-profile.js'));
const profiles = require(path.join(here, '../../frontend/js/corridor-profile.js'));

const DONJI_GRAD = JSON.parse(readFileSync(path.join(here, 'fixtures/osm-donji-grad.json'), 'utf8'));
const block = DONJI_GRAD.gundulic;
const street = block.ways.find(way => way.osm_id === block.streetId);

const project = (lat, lng) => [lng * 1000, lat * 1000];
const unproject = (x, y) => [y / 1000, x / 1000];
const toLngLat = ([x, y]) => { const [lat, lng] = unproject(x, y); return [lng, lat]; };

const counters = { fetches: 0, polygons: 0, profiled: 0 };

// A road parcel around the street, as the parcel layer holds it (lng/lat GeoJSON).
function parcelFeature(id, shift = 0) {
    const half = 8;
    const pts = street.pointsXY.map(([x, y]) => [x + shift, y]);
    const spine = [[pts[0][0], pts[0][1] - 10], ...pts, [pts[1][0], pts[1][1] + 10]];
    const left = [];
    const right = [];
    for (let i = 0; i < spine.length; i += 1) {
        const a = spine[Math.max(0, i - 1)];
        const b = spine[Math.min(spine.length - 1, i + 1)];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        left.push([spine[i][0] + nx * half, spine[i][1] + ny * half]);
        right.push([spine[i][0] - nx * half, spine[i][1] - ny * half]);
    }
    const ring = left.concat(right.reverse());
    ring.push(ring[0].slice());
    return {
        type: 'Feature',
        properties: { parcelId: id, isRoad: true },
        geometry: { type: 'Polygon', coordinates: [ring.map(toLngLat)] }
    };
}

// The smallest Leaflet this layer actually uses.
function fakeLeaflet() {
    const group = () => {
        const members = new Set();
        return {
            addLayer(l) { members.add(l); return this; },
            removeLayer(l) { members.delete(l); return this; },
            hasLayer(l) { return members.has(l); },
            clearLayers() { members.clear(); return this; },
            addTo(target) { target.addLayer(this); return this; }
        };
    };
    const shape = kind => (...args) => ({ kind, args, addTo(g) { g.addLayer(this); return this; } });
    return {
        layerGroup: () => group(),
        polygon: (...args) => { counters.polygons += 1; return shape('polygon')(...args); },
        polyline: shape('polyline'),
        canvas: () => ({ kind: 'canvas' })
    };
}

// A map that really keeps its listeners, so a pan is fired the way Leaflet fires one.
function fakeMap() {
    const layers = new Set();
    const panes = {};
    const listeners = new Map();
    return {
        zoom: 18,
        getZoom() { return this.zoom; },
        getBounds() { return { intersects: () => true }; },
        getPane(name) { return panes[name]; },
        createPane(name) { panes[name] = { style: {} }; return panes[name]; },
        hasLayer(l) { return layers.has(l); },
        addLayer(l) { layers.add(l); return this; },
        removeLayer(l) { layers.delete(l); return this; },
        on(events, fn) { String(events).split(' ').forEach(e => listeners.set(e, fn)); return this; },
        off(events) { String(events).split(' ').forEach(e => listeners.delete(e)); return this; },
        fire(event) { const fn = listeners.get(event); if (fn) fn(); }
    };
}

const settle = async (ms = 0, rounds = 12) => {
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
// Past the layer's 450 ms move debounce, then let the idle slices drain.
const pan = async () => { globalThis.map.fire('moveend'); await settle(520); };

describe('a street is painted once, not on every pan', () => {
    beforeEach(() => {
        counters.fetches = 0;
        counters.polygons = 0;
        counters.profiled = 0;

        globalThis.L = fakeLeaflet();
        globalThis.map = fakeMap();
        globalThis.RoadSegmentation = segmentation;
        globalThis.wgs84ToHTRS96 = project;
        globalThis.htrs96ToWGS84 = unproject;
        globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
        globalThis.buildCorridorStrips = profiles.buildCorridorStrips;
        globalThis.corridorStripSurface = profiles.corridorStripSurface;
        globalThis.getBboxFromBounds = () => '0,0,1000,1000';
        globalThis.getBackendBase = () => '';

        // Count every reconstruction: this is the expensive step the cache exists to avoid.
        globalThis.OsmProfile = {
            osmProfileForSegment(input) {
                counters.profiled += 1;
                return translatorModule.osmProfileForSegment(input);
            }
        };

        const features = [parcelFeature('road-1'), parcelFeature('road-2', 60)];
        globalThis.parcelLayer = {
            eachLayer(fn) { features.forEach(feature => fn({ feature, getBounds: () => ({}) })); }
        };
        globalThis.fetch = async () => {
            counters.fetches += 1;
            return {
                ok: true,
                json: async () => ({
                    features: block.ways.map(way => ({
                        properties: way.properties,
                        geometry: { type: 'LineString', coordinates: way.pointsXY.map(toLngLat) }
                    }))
                })
            };
        };

        // A fresh module instance per test: it is a singleton holding its own cache.
        delete require.cache[require.resolve('../../frontend/js/osm-lane-paint.js')];
        require('../../frontend/js/osm-lane-paint.js');
    });

    afterEach(() => {
        ['L', 'map', 'RoadSegmentation', 'OsmProfile', 'wgs84ToHTRS96', 'htrs96ToWGS84',
            'corridorProfileFromOsmTags', 'buildCorridorStrips', 'corridorStripSurface',
            'getBboxFromBounds', 'getBackendBase', 'parcelLayer', 'fetch',
            'toggleOsmLanePaint', 'refreshOsmLanePaint', 'refreshOsmLanePaintForProposals', 'OsmLanePaint']
            .forEach(key => { delete globalThis[key]; });
    });

    it('paints the streets on the way in, fetching the ways once for the whole viewport', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        expect(counters.polygons).toBeGreaterThan(0);
        expect(counters.profiled).toBeGreaterThan(0);
        expect(counters.fetches).toBe(1);
    });

    it('does no work at all when the map moves over ground it has already painted', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        const after = { ...counters };
        expect(after.profiled).toBeGreaterThan(0);

        await pan();
        await pan();

        expect(counters.profiled, 'cross-sections reconstructed').toBe(after.profiled);
        expect(counters.polygons, 'polygons built').toBe(after.polygons);
        expect(counters.fetches, 'OSM fetches').toBe(after.fetches);
    });

    it('keeps the painted streets when the map zooms out past the layer\'s range and back', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        const after = { ...counters };

        globalThis.map.zoom = 12;
        await pan();
        globalThis.map.zoom = 18;
        await pan();

        expect(counters.profiled, 'zooming out and back must not repaint').toBe(after.profiled);
    });

    // The paint stops where a proposal starts, so applying or editing one moves that boundary and the
    // streets have to be read again — otherwise an edited cross-section stays hidden under the OSM
    // reconstruction of what the street used to be.
    it('repaints when a proposal changes what is drawn over the street', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        const after = { ...counters };

        globalThis.refreshOsmLanePaintForProposals();
        await settle();

        expect(counters.profiled).toBeGreaterThan(after.profiled);
    });

    it('does nothing on a proposal change while the layer is switched off', async () => {
        globalThis.refreshOsmLanePaintForProposals();
        await settle();
        expect(counters.profiled).toBe(0);
        expect(counters.fetches).toBe(0);
    });
});
