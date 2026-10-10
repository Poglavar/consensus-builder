// The screen a visitor gets when the parcel register cannot be loaded.
//
// Two things must never blur: "the register failed" and "there is no register" (unsurveyed-ground.md
// explains why a failed request must not read as an empty answer). So the classification is pinned
// first. Then the part that turns a choice into ground — a session source that fetch.js consults
// instead of the network — is exercised for real, and the wiring into fetch.js, index.html and the
// four locales is pinned against the source, because nothing about it is observable from a return value.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The module reads sessionStorage as it loads, so the fake has to exist first.
function fakeStorage() {
    const data = new Map();
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: key => { data.delete(key); },
        clear: () => data.clear(),
        get size() { return data.size; }
    };
}
globalThis.sessionStorage = fakeStorage();
globalThis.CityConfigManager = {
    getCurrentCityId: () => 'zagreb',
    getCityLabel: id => (id === 'zagreb' ? 'Zagreb, Croatia' : id),
    getAvailableCities: () => [
        { id: 'zagreb', parcels: { strategy: 'grid', source: 'oss-wfs' } },
        { id: 'nowhere', parcels: { strategy: 'none' } }
    ]
};
const Grid = require('../../frontend/js/parcels/schelling-grid.js');
const Fallback = require('../../frontend/js/parcels/ground-fallback.js');

const fetchSource = read('../../frontend/js/parcels/fetch.js');
const fallbackSource = read('../../frontend/js/parcels/ground-fallback.js');
const html = read('../../frontend/index.html');
const mapCore = read('../../frontend/js/map-core.js');
const locales = ['en', 'hr', 'sr', 'es'];
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

beforeEach(() => {
    globalThis.sessionStorage.clear();
    Fallback.clearSource('zagreb');
    Fallback.clearSource('nowhere');
    delete globalThis.addRoadParcel;
});

describe('what went wrong is named, not guessed', () => {
    it('keeps "no register" apart from a failed request', () => {
        const error = new Error('No parcel register is on record for nowhere.');
        error.code = 'no-register';
        expect(Fallback.classify(error)).toMatchObject({ kind: 'no-register', retryable: false });
        expect(Fallback.classify(new Error('HTTP 503'), { parcelSettings: { strategy: 'none' } }).kind).toBe('no-register');
        expect(Fallback.classify(null, { parcelSettings: { source: 'none' } }).kind).toBe('no-register');
    });

    it('offers a retry only when a retry can plausibly help', () => {
        const http = status => Object.assign(new Error(`Parcel request failed: HTTP ${status}`), { status });
        expect(Fallback.classify(http(503))).toMatchObject({ kind: 'temporary', retryable: true, detail: 'HTTP 503' });
        expect(Fallback.classify(http(429)).retryable).toBe(true);
        expect(Fallback.classify(http(403))).toMatchObject({ kind: 'refused', retryable: false });
        expect(Fallback.classify(http(404)).retryable).toBe(false);
        expect(Fallback.classify(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'temporary', retryable: true });
        expect(Fallback.classify(new Error('Parcel response was not JSON: Unexpected token <'))).toMatchObject({ kind: 'broken', retryable: true });
        expect(Fallback.classify(new Error('something odd'))).toMatchObject({ kind: 'unknown', retryable: true });
    });
});

describe('a Schelling plan becomes the ground source for the session', () => {
    it('answers a cell with the plan’s parcels in WGS84 and marks its streets as roads', () => {
        const marked = [];
        globalThis.addRoadParcel = id => marked.push(id);
        const source = Fallback.schellingSource({ lat: 45.8 });
        expect(source.kind).toBe('schelling');
        expect(source.plan.code).toBe('45x30-8x8-30-12@46N');
        // fetch.js hands over "minLng,minLat,maxLng,maxLat", i.e. west,south,east,north.
        const answer = source.fetchCell({ latLonBbox: '15.970,45.800,15.980,45.806', city: 'zagreb' });
        expect(answer.returnsWGS84).toBe(true);
        expect(answer.features.length).toBeGreaterThan(50);
        const streets = answer.features.filter(f => f.properties.isRoad);
        expect(marked.length).toBe(streets.length);
        expect(marked).toContain(streets[0].properties.parcelId);
    });

    it('rebuilds parcels by id and declares the rest absent, as the repository requires', () => {
        const source = Fallback.schellingSource({ lat: 45.8 });
        const cell = source.fetchCell({ latLonBbox: '15.970,45.800,15.980,45.806' });
        const ids = cell.features.slice(0, 3).map(f => f.properties.parcelId);
        const answer = source.fetchByIds([...ids, 'HR-330264-123']);
        expect(answer.features.map(f => f.properties.parcelId)).toEqual(ids);
        expect(answer.absentIds).toEqual(['HR-330264-123']);
    });

    it('lays each latitude band out from that band\'s own plan, wherever the source was chosen', () => {
        // Explore spans the world: a plan chosen in Tokyo (36°N) used to lay 36°N blocks and ids over
        // Helsinki; a stranger starting in Helsinki derives the 60°N plan, and so must this source.
        const helsinki = { latLonBbox: '24.930,60.165,24.940,60.170' };
        const fromTokyo = Fallback.schellingSource({ lat: 35.68 }).fetchCell(helsinki).features;
        const fromHelsinki = Fallback.schellingSource({ lat: 60.17 }).fetchCell(helsinki).features;
        expect(fromTokyo.length).toBeGreaterThan(0);
        expect(fromTokyo.map(f => f.properties.parcelId)).toEqual(fromHelsinki.map(f => f.properties.parcelId));
        expect(fromTokyo[0].properties.parcelId).toMatch(/@60N:/);
        expect(fromTokyo.map(f => f.geometry)).toEqual(fromHelsinki.map(f => f.geometry));
        // and rebuilds any band's parcels by id
        const ids = fromTokyo.slice(0, 2).map(f => f.properties.parcelId);
        expect(Fallback.schellingSource({ lat: 35.68 }).fetchByIds(ids).features.map(f => f.properties.parcelId)).toEqual(ids);
    });

    it('splits a cell across two bands at the half degree, each piece in one band only', () => {
        const source = Fallback.schellingSource({ lat: 45.8 });
        const features = source.fetchCell({ latLonBbox: '15.970,45.496,15.976,45.504' }).features;
        const bands = new Set(features.map(f => /@(\d+)N:/.exec(f.properties.parcelId)[1]));
        expect([...bands].sort()).toEqual(['45', '46']);
        const ids = features.map(f => f.properties.parcelId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const feature of features) {
            const lats = feature.geometry.coordinates[0].map(p => p[1]);
            const centre = (Math.min(...lats) + Math.max(...lats)) / 2;
            const band = Number(/@(\d+)N:/.exec(feature.properties.parcelId)[1]);
            expect(Math.round(centre)).toBe(band);
        }
    });

    it('is installed per city, remembered for the tab, and restored on reload', () => {
        expect(Fallback.activeSource('zagreb')).toBeNull();
        const source = Fallback.schellingSource({ lat: 45.8, streetWidthM: 10 });
        Fallback.installSource('zagreb', source);
        expect(Fallback.activeSource('zagreb')).toBe(source);
        expect(Fallback.activeSource('nowhere')).toBeNull();
        const stored = JSON.parse(globalThis.sessionStorage.getItem('cb_ground_source:zagreb'));
        expect(stored).toMatchObject({ kind: 'schelling', algorithm: 'meridians-parallels', params: { streetWidthM: 10, lat: 46 } });

        // A reload: the in-memory map is gone, the tab's storage is not.
        Fallback.clearSource('zagreb');
        globalThis.sessionStorage.setItem('cb_ground_source:zagreb', JSON.stringify(stored));
        const restored = Fallback.restoreFromSession('zagreb');
        expect(restored.kind).toBe('schelling');
        expect(restored.plan.code).toBe(source.plan.code);
    });

    it('forgets a descriptor it cannot read rather than guessing', () => {
        globalThis.sessionStorage.setItem('cb_ground_source:zagreb', '{not json');
        expect(Fallback.restoreFromSession('zagreb')).toBeNull();
        expect(globalThis.sessionStorage.getItem('cb_ground_source:zagreb')).toBeNull();
    });

    it('does not offer the screen while a source is already answering, or after the visitor said not now', () => {
        Fallback.installSource('zagreb', Fallback.schellingSource({ lat: 45.8 }));
        expect(Fallback.onGroundUnavailable({ city: 'zagreb', error: new Error('HTTP 503') })).toBe(false);
        globalThis.sessionStorage.setItem('cb_ground_fallback_dismissed:nowhere', '1');
        expect(Fallback.onGroundUnavailable({ city: 'nowhere', error: new Error('HTTP 503') })).toBe(false);
    });
});

describe('a register link the visitor knows of', () => {
    it('recognises the three documented URL shapes and builds a bounded query for each', () => {
        const box = { west: 15.97, south: 45.8, east: 15.99, north: 45.81 };
        expect(Fallback.detectUrlKind('https://gis.example.org/arcgis/rest/services/Cadastre/FeatureServer/0')).toBe('arcgis');
        expect(Fallback.detectUrlKind('https://api.example.org/ogc/collections/parcels/items?f=json')).toBe('ogc');
        expect(Fallback.detectUrlKind('https://data.example.org/parcels?bbox={bbox}')).toBe('bbox-template');
        expect(Fallback.detectUrlKind('https://data.example.org/parcels.geojson')).toBe('geojson');

        const arcgis = new URL(Fallback.urlForBox('https://gis.example.org/arcgis/rest/services/Cadastre/FeatureServer/0', 'arcgis', box));
        expect(arcgis.pathname).toMatch(/\/FeatureServer\/0\/query$/);
        expect(arcgis.searchParams.get('f')).toBe('geojson');
        expect(arcgis.searchParams.get('outSR')).toBe('4326');
        expect(JSON.parse(arcgis.searchParams.get('geometry'))).toMatchObject({ xmin: 15.97, ymax: 45.81 });

        const ogc = new URL(Fallback.urlForBox('https://api.example.org/ogc/collections/parcels/items', 'ogc', box));
        expect(ogc.searchParams.get('bbox')).toBe('15.97,45.8,15.99,45.81');
        expect(ogc.searchParams.get('f')).toBe('json');

        expect(Fallback.urlForBox('https://data.example.org/parcels?bbox={bbox}', 'bbox-template', box))
            .toBe('https://data.example.org/parcels?bbox=15.97,45.8,15.99,45.81');
        expect(Fallback.urlForBox('https://data.example.org/parcels.geojson', 'geojson', box)).toBe('https://data.example.org/parcels.geojson');
    });

    const square = (x, y, size = 0.001) => ({
        type: 'Polygon',
        coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
    });

    it('keeps closed polygons, skips everything else, and counts what overlaps the view', () => {
        const view = { west: 15.97, south: 45.80, east: 15.99, north: 45.81 };
        const sample = Fallback.validateFeatureCollection({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: { OBJECTID: 7 }, geometry: square(15.975, 45.805) },
                { type: 'Feature', properties: {}, geometry: square(16.5, 46.5) },
                { type: 'Feature', properties: { id: 'pt' }, geometry: { type: 'Point', coordinates: [15.98, 45.8] } },
                { type: 'Feature', properties: { id: 'metres' }, geometry: square(458900, 5074000) },
                { type: 'Feature', properties: { OBJECTID: 7 }, geometry: square(15.975, 45.805) }
            ]
        }, view);
        expect(sample.total).toBe(5);
        expect(sample.rejected).toBe(2);
        expect(sample.features.length).toBe(2);
        expect(sample.overlapping).toBe(1);
        expect(sample.features[0].properties).toMatchObject({ parcelId: 'URL:7', id: 'URL:7', provenance: 'user-url', estimated: false });
        expect(sample.features[1].properties.parcelId).toMatch(/^URL:g[0-9a-f]{8}$/);
    });

    it('refuses ids that name two different parcels', () => {
        expect(() => Fallback.validateFeatureCollection({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: { id: 'A' }, geometry: square(15.975, 45.805) },
                { type: 'Feature', properties: { id: 'A' }, geometry: square(15.976, 45.805) }
            ]
        }, null)).toThrow(/share the id URL:A/);
        expect(() => Fallback.validateFeatureCollection({ type: 'Feature' }, null)).toThrow(/FeatureCollection/);
    });

    it('derives the same id for the same anonymous geometry every time', () => {
        const feature = { type: 'Feature', properties: {}, geometry: square(15.975, 45.805) };
        expect(Fallback.externalFeatureId(feature)).toBe(Fallback.externalFeatureId(JSON.parse(JSON.stringify(feature))));
        expect(Fallback.externalFeatureId({ type: 'Feature', id: 'gml.42', properties: {}, geometry: square(1, 1) })).toBe('URL:gml.42');
    });
});

describe('the wiring', () => {
    it('loads the grid and the fallback before the transport, with their stylesheet', () => {
        const scriptIndex = path => {
            const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return html.search(new RegExp(`[\"']${escapedPath}(?:\\?[^\"']*)?[\"']`));
        };
        const grid = scriptIndex('js/parcels/schelling-grid.js');
        const fallback = scriptIndex('js/parcels/ground-fallback.js');
        const fetch = scriptIndex('js/parcels/fetch.js');
        expect(grid).toBeGreaterThan(-1);
        expect(fallback).toBeGreaterThan(grid);
        expect(fetch).toBeGreaterThan(fallback);
        expect(html).toContain("'css/ground-fallback.css'");
    });

    it('lets a session source stand in for the network, per cell and per id', () => {
        const fetchCell = fetchSource.slice(fetchSource.indexOf('async function fetchCell('), fetchSource.indexOf('async function fetchBounds('));
        expect(fetchCell).toContain('groundOverride(context.city)');
        expect(fetchCell).toContain('override.fetchCell(');
        expect(fetchCell).toContain('noRegisterError(context.city)');
        const fetchByIds = fetchSource.slice(fetchSource.indexOf('async function fetchByIds('), fetchSource.indexOf('function datasetToLatLng('));
        expect(fetchByIds).toContain('override.fetchByIds(ids)');
    });

    it('raises a typed error for a city with no register, never a generic failure', () => {
        expect(fetchSource).toContain("error.code = 'no-register'");
        const fetchBounds = fetchSource.slice(fetchSource.indexOf('async function fetchBounds('), fetchSource.indexOf('async function fetchUnderGeometry('));
        expect(fetchBounds).toContain('noRegisterError(city)');
    });

    it('offers the screen when a viewport fetch fails, and still rethrows', () => {
        const fetchParcelData = fetchSource.slice(fetchSource.indexOf('async function fetchParcelData('), fetchSource.indexOf('async function refreshParcelDataWithBusyState('));
        expect(fetchParcelData).toContain('ParcelGroundFallback?.onGroundUnavailable?.(');
        expect(fetchParcelData).toContain('throw error;');
        const refresh = fetchSource.slice(fetchSource.indexOf('async function refreshParcelDataWithBusyState('));
        expect(refresh).toContain('resetDismissal');
        expect(mapCore).toContain("fetchParcelDataReported(undefined, 'initial map load');");
    });

    it('says every sentence in every locale', () => {
        const leafKeys = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) =>
            (value && typeof value === 'object') ? leafKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]);
        const en = dictOf('en');
        const reference = leafKeys(en.groundFallback).sort();
        expect(reference.length).toBeGreaterThan(50);
        locales.forEach(locale => {
            const dict = dictOf(locale);
            expect(leafKeys(dict.groundFallback).sort(), locale).toEqual(reference);
        });
        // Every key the dialog asks for exists; a typo here would silently show the English fallback.
        const used = Array.from(fallbackSource.matchAll(/t\('(groundFallback\.[a-zA-Z.]+)'/g), m => m[1]);
        expect(used.length).toBeGreaterThan(40);
        const available = new Set(reference.map(key => `groundFallback.${key}`));
        used.forEach(key => expect(available.has(key), key).toBe(true));
    });

    it('offers exactly the four ways on, retry first and only when retryable', () => {
        const options = fallbackSource.slice(fallbackSource.indexOf('function renderOptions()'), fallbackSource.indexOf('function backButton()'));
        expect(options).toContain('if (verdict.retryable)');
        const order = ['retry', 'url', 'ocr', 'schelling'].map(key => options.indexOf(`option('${key}'`));
        expect(order.every(index => index > -1)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });
});
