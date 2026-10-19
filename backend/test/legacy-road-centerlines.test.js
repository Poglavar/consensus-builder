// Tests for frontend/js/legacy-road-centerlines.js as the drawing tool's street loader: existing
// street centre lines (/osm-road) are fetched for the viewport at zoom ≥ 14 whether or not their
// reference layer is shown, cached by bbox key, and offered as snap lines (road-editor.md decision 4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODULE = require.resolve('../../frontend/js/legacy-road-centerlines.js');

const GLOBALS = ['map', 'wgs84BboxParam', 'getBackendBase', 'fetchJsonWithRetry', 'LegacyRoadCenterlines',
    'toggleLegacyRoadCenterlines', 'refreshLegacyRoadCenterlines', 'updateStatus'];
let saved;
let view;
let fetched;
let responder;

const line = (osmId, name, coordinates) => ({
    type: 'Feature',
    properties: { osm_id: osmId, name, highway_type: 'residential' },
    geometry: { type: 'LineString', coordinates }
});

function loadFresh() {
    delete require.cache[MODULE];
    return require(MODULE);
}

beforeEach(() => {
    saved = Object.fromEntries(GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    view = { zoom: 16, key: 'A' };
    fetched = [];
    responder = url => ({ type: 'FeatureCollection', features: [line(1, 'Ulica ' + url.slice(-1), [[15.97, 45.8], [15.971, 45.8]])] });
    globalThis.map = { getZoom: () => view.zoom, getBounds: () => ({ key: view.key }) };
    globalThis.wgs84BboxParam = bounds => `bbox=${bounds.key}`;
    globalThis.getBackendBase = () => 'http://api.test';
    globalThis.fetchJsonWithRetry = vi.fn(async url => {
        fetched.push(url);
        return responder(url);
    });
});

afterEach(() => {
    vi.useRealTimers();
    GLOBALS.forEach(name => {
        if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
        else delete globalThis[name];
    });
    delete require.cache[MODULE];
});

describe('street lines for snapping', () => {
    it('fetches the viewport once and serves the same bbox from the cache', async () => {
        const loader = loadFresh();
        expect(globalThis.LegacyRoadCenterlines).toBe(loader);
        const first = await loader.ensureLoaded();
        const again = await loader.ensureLoaded();
        expect(fetched).toEqual(['http://api.test/osm-road?bbox=A']);
        expect(again).toBe(first);
        expect(loader.features()).toBe(first);
        expect(first[0].properties.name).toBe('Ulica A');
    });

    it('fetches nothing below zoom 14', async () => {
        const loader = loadFresh();
        view.zoom = 13;
        expect(await loader.ensureLoaded()).toEqual([]);
        expect(fetched).toEqual([]);
        expect(loader.MIN_ZOOM).toBe(14);
    });

    it('turns every line part into a named snap line with its box', async () => {
        responder = () => ({
            type: 'FeatureCollection',
            features: [
                line(77, '  Ilica  ', [[15.96, 45.81], [15.965, 45.812], [15.97, 45.811]]),
                {
                    type: 'Feature',
                    properties: { osm_id: 78, name: null },
                    geometry: { type: 'MultiLineString', coordinates: [[[15.9, 45.8], [15.91, 45.8]], [[15.92, 45.8], [15.93, 45.79]], [[15.94, 45.8]]] }
                }
            ]
        });
        const loader = loadFresh();
        await loader.ensureLoaded();
        const lines = loader.snapLines();
        expect(lines).toHaveLength(3); // one LineString + two usable MultiLineString parts
        expect(lines[0]).toEqual({
            points: [{ lat: 45.81, lng: 15.96 }, { lat: 45.812, lng: 15.965 }, { lat: 45.811, lng: 15.97 }],
            bbox: [15.96, 45.81, 15.97, 45.812],
            name: 'Ilica',
            wayId: '77'
        });
        expect(lines[2]).toMatchObject({ name: null, wayId: '78', bbox: [15.92, 45.79, 15.93, 45.8] });
        expect(loader.snapLines()).toBe(lines); // built once per viewport
    });

    it('offers no footway, path or steps as a snap line', async () => {
        responder = () => ({
            type: 'FeatureCollection',
            features: [
                line(80, 'Vlaška ulica', [[15.98, 45.81], [15.985, 45.81]]),
                { type: 'Feature', properties: { osm_id: 81, name: 'Staza', highway: 'footway' }, geometry: { type: 'LineString', coordinates: [[15.98, 45.82], [15.985, 45.82]] } },
                { type: 'Feature', properties: { osm_id: 82, name: null, highway_type: 'steps' }, geometry: { type: 'LineString', coordinates: [[15.98, 45.83], [15.985, 45.83]] } }
            ]
        });
        const loader = loadFresh();
        await loader.ensureLoaded();
        expect(loader.snapLines().map(entry => entry.wayId)).toEqual(['80']);
    });

    it('never lets a slower answer for a viewport the map has left replace the newer one', async () => {
        let releaseA;
        responder = url => (url.endsWith('A')
            ? new Promise(resolve => { releaseA = () => resolve({ features: [line(1, 'Old', [[0, 0], [1, 1]])] }); })
            : { features: [line(2, 'New', [[0, 0], [1, 1]])] });
        const loader = loadFresh();
        const slow = loader.ensureLoaded();
        view.key = 'B';
        await loader.ensureLoaded();
        releaseA();
        await slow;
        expect(loader.features()[0].properties.name).toBe('New');
    });

    it('keeps the lines it has when a fetch fails, and says so', async () => {
        const loader = loadFresh();
        await loader.ensureLoaded();
        const before = loader.features();
        view.key = 'B';
        globalThis.fetchJsonWithRetry = vi.fn(async () => { throw new Error('offline'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await loader.ensureLoaded()).toBe(before);
        expect(loader.features()).toBe(before);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('debounces the moveend reload', async () => {
        vi.useFakeTimers();
        const loader = loadFresh();
        loader.scheduleLoad();
        loader.scheduleLoad();
        expect(fetched).toEqual([]);
        await vi.advanceTimersByTimeAsync(400);
        expect(fetched).toEqual(['http://api.test/osm-road?bbox=A']);
    });
});
