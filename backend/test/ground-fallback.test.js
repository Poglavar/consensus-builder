// The screen a visitor gets when the parcel register cannot be loaded.
//
// Two things must never blur: "the register failed" and "there is no register" (unsurveyed-ground.md
// explains why a failed request must not read as an empty answer). So the classification is pinned
// first. Then the part that turns a choice into ground — a session source that fetch.js consults
// instead of the network (a register link; the Schelling plan is a layer, never ground) — is exercised for real, and the wiring into fetch.js, index.html and the
// four locales is pinned against the source, because nothing about it is observable from a return value.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const Identity = require('../../frontend/js/parcels/custom-url-identity.js');
const sourceUrl = 'https://data.example.org/parcels.geojson';
const sourceId = Identity.sourceId(sourceUrl);

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
afterEach(() => vi.unstubAllGlobals());

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

describe('the Schelling plan is a layer, not ground', () => {
    it('keeps no Schelling source and drops one an older tab remembered', () => {
        expect(Fallback.schellingSource).toBeUndefined();
        globalThis.sessionStorage.setItem('cb_ground_source:zagreb', JSON.stringify({ kind: 'schelling', algorithm: 'meridians-parallels', params: { lat: 46 } }));
        expect(Fallback.restoreFromSession('zagreb')).toBeNull();
        expect(globalThis.sessionStorage.getItem('cb_ground_source:zagreb')).toBeNull();
    });

    it('forgets a descriptor it cannot read rather than guessing', () => {
        globalThis.sessionStorage.setItem('cb_ground_source:zagreb', '{not json');
        expect(Fallback.restoreFromSession('zagreb')).toBeNull();
        expect(globalThis.sessionStorage.getItem('cb_ground_source:zagreb')).toBeNull();
    });

    it('does not offer the screen while a source is already answering, or after the visitor said not now', () => {
        Fallback.installSource('zagreb', { kind: 'custom-url', fetchCell: () => ({ features: [] }), describe: () => null });
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
        }, view, sourceId);
        expect(sample.total).toBe(5);
        expect(sample.rejected).toBe(2);
        expect(sample.features.length).toBe(2);
        expect(sample.overlapping).toBe(1);
        expect(sample.features[0].properties).toMatchObject({ sourceId, sourceParcelId: '7',
            sourceIdentityKind: 'native-id', provenance: 'user-url', estimated: false });
        expect(sample.features[0].properties.id).toBe(sample.features[0].properties.parcelId);
        expect(sample.features[1].properties).toMatchObject({ sourceId, sourceParcelId: null, sourceIdentityKind: 'geometry-content' });
    });

    it('refuses ids that name two different parcels', () => {
        expect(() => Fallback.validateFeatureCollection({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: { id: 'A' }, geometry: square(15.975, 45.805) },
                { type: 'Feature', properties: { id: 'A' }, geometry: square(15.976, 45.805) }
            ]
        }, null, sourceId)).toThrow(/share the id URL:.*:native:A/);
        expect(() => Fallback.validateFeatureCollection({ type: 'Feature' }, null, sourceId)).toThrow(/FeatureCollection/);
    });

    it('keeps source identity through probe, viewport fetch, exact lookup and session restore', async () => {
        const feature = { type: 'Feature', properties: { id: 'gml.42', sourceId: 'untrusted', sourceParcelId: 'wrong' }, geometry: square(1, 1) };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [feature] }) })));
        const view = { west: 0.9, south: 0.9, east: 1.1, north: 1.1 };
        // Exercise the complete collection and the viewport-query branch.
        for (const url of [sourceUrl, 'https://data.example.org/collections/parcels/items']) {
            const source = await Fallback.probeCustomUrl(url, view);
            const first = (await source.fetchCell({ latLonBbox: '0.9,0.9,1.1,1.1' })).features[0];
            expect(first.properties).toMatchObject({ sourceId: source.id, sourceParcelId: 'gml.42', sourceIdentityKind: 'native-id' });
            expect(source.fetchByIds([first.properties.parcelId]).features).toEqual([first]);
            Fallback.installSource('nowhere', source);
            const descriptor = globalThis.sessionStorage.getItem('cb_ground_source:nowhere');
            Fallback.clearSource('nowhere');
            globalThis.sessionStorage.setItem('cb_ground_source:nowhere', descriptor);
            const restored = Fallback.restoreFromSession('nowhere');
            expect(restored.id).toBe(source.id);
            expect((await restored.fetchCell({ latLonBbox: '0.9,0.9,1.1,1.1' })).features).toEqual([first]);
        }
    });
});

describe('the wiring', () => {
    it('loads the fallback before the transport, with its stylesheet', () => {
        const scriptIndex = path => {
            const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return html.search(new RegExp(`[\"']${escapedPath}(?:\\?[^\"']*)?[\"']`));
        };
        const fallback = scriptIndex('js/parcels/ground-fallback.js');
        const fetch = scriptIndex('js/parcels/fetch.js');
        expect(fallback).toBeGreaterThan(-1);
        expect(scriptIndex('js/parcels/custom-url-identity.js')).toBeLessThan(fallback);
        expect(scriptIndex('js/parcels/custom-url-identity.js')).toBeGreaterThan(scriptIndex('js/bets/sha256.js'));
        expect(fetch).toBeGreaterThan(fallback);
        expect(scriptIndex('js/schelling/schelling-layer.js')).toBeGreaterThan(-1);
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
        expect(reference.length).toBeGreaterThan(30);
        locales.forEach(locale => {
            const dict = dictOf(locale);
            expect(leafKeys(dict.groundFallback).sort(), locale).toEqual(reference);
        });
        // Every key the dialog asks for exists; a typo here would silently show the English fallback.
        const used = Array.from(fallbackSource.matchAll(/t\('(groundFallback\.[a-zA-Z.]+)'/g), m => m[1]);
        expect(used).toContain('groundFallback.options.ocr.title');
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
