import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BrowserSources = require('../../frontend/js/browser-source-readers.js');
const SourceRuntime = require('../../frontend/js/source-runtime.js');

const response = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

describe('browser source readers', () => {
    it('builds Photon URL parameters, forwards the signal, and returns the raw response', async () => {
        const body = { type: 'FeatureCollection', features: [{ properties: { name: 'Place' } }] };
        const fetchImpl = vi.fn(async () => response(body));
        const signal = new AbortController().signal;
        const result = await BrowserSources.geocoder().search({ q: 'Central', lang: 'en', limit: 7 }, { fetchImpl, signal });
        const [url, options] = fetchImpl.mock.calls[0];
        expect(new URL(url).origin + new URL(url).pathname).toBe('https://photon.komoot.io/api/');
        expect(new URL(url).searchParams.get('q')).toBe('Central');
        expect(new URL(url).searchParams.get('lang')).toBe('en');
        expect(new URL(url).searchParams.get('limit')).toBe('7');
        expect(options).toEqual({ signal });
        expect(result).toBe(body);
    });

    it('uses the selected canonical per-city custom geocoder through the Photon adapter', async () => {
        const custom = SourceRuntime.source('geocoding', 'photon', {
            id: 'custom-photon', endpoint: 'https://geocode.example.test/search'
        }, { id: 'custom-geocoder', kind: 'custom' });
        const global = { CityConfigManager: { getCurrentCityConfig: () => ({ sources: { geocoding: custom } }) } };
        const fetchImpl = vi.fn(async () => response({ features: [] }));
        await expect(BrowserSources.geocoder(global).search({ q: 'Harbor' }, { fetchImpl })).resolves.toEqual({ features: [] });
        const [url] = fetchImpl.mock.calls[0];
        expect(new URL(url).origin).toBe('https://geocode.example.test');
        expect(new URL(url).searchParams.get('q')).toBe('Harbor');
    });

    it('passes Photon requests and errors through the server requestJson helper', async () => {
        const signal = new AbortController().signal;
        const body = { features: [{ id: 'raw' }] };
        const requestJson = vi.fn(async () => body);
        await expect(BrowserSources.geocoder().search({ q: 'River' }, { requestJson, signal })).resolves.toBe(body);
        const [url, options] = requestJson.mock.calls[0];
        expect(new URL(url).searchParams.get('q')).toBe('River');
        expect(options).toEqual({ signal });

        const failure = new Error('server request failed');
        const failingRequest = vi.fn(async () => { throw failure; });
        await expect(BrowserSources.geocoder().search({ q: 'River' }, { requestJson: failingRequest, signal })).rejects.toBe(failure);
    });

    it('rejects a failed direct Photon response with its HTTP status', async () => {
        await expect(BrowserSources.geocoder().search({}, { fetchImpl: async () => response({}, { ok: false, status: 429 }) }))
            .rejects.toThrow('HTTP 429 from Photon');
    });

    it('resolves terrain endpoint overrides, configured API base, local default, and production default', () => {
        const reader = BrowserSources.terrainReader({});
        expect(reader.url({ __CORRIDOR_TERRAIN_PROFILE_URL__: 'https://override.example.test/profile' }))
            .toBe('https://override.example.test/profile');
        expect(reader.url({ __ZAGREB_RUNTIME_CONFIG__: { zagrebApiBaseUrl: 'https://api.example.test/root///' } }))
            .toBe('https://api.example.test/root/terrain/profile');
        expect(reader.url({ location: { hostname: 'localhost', origin: 'http://localhost:8080' } }))
            .toBe('http://localhost:3001/api/terrain/profile');
        expect(reader.url({ location: { hostname: 'app.example.test', origin: 'https://app.example.test' } }))
            .toBe('https://app.example.test/api/terrain/profile');
    });

    it('posts terrain profiles to custom endpoints and preserves NoData null elevations', async () => {
        const source = SourceRuntime.source('terrain-profile', 'dgu-dtm-20m', {
            id: 'custom-terrain', endpoint: 'https://terrain.example.test/profile', source: 'survey-dtm', datum: 'LOCAL-2020'
        }, { id: 'custom-terrain-profile', kind: 'custom' });
        const request = { coordinates: [[15, 45], [15.01, 45.01]], stepM: 20 };
        const result = { source: 'survey-dtm', datum: 'LOCAL-2020', points: [{ dM: 0, elevAslM: 104 }, { dM: 20, elevAslM: null }] };
        const fetchImpl = vi.fn(async () => response(result));
        const signal = new AbortController().signal;
        const reader = BrowserSources.terrain.open(source);
        await expect(reader.profile(request, { fetchImpl, signal, global: { location: { href: 'https://app.example.test/' } } })).resolves.toBe(result);
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://terrain.example.test/profile', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal
        });
        expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('timeout');
        expect(result.points[1].elevAslM).toBeNull();
    });

    it('rejects terrain responses with the wrong source, wrong datum, missing points, or too few points', async () => {
        const reader = BrowserSources.terrainReader({});
        const valid = { source: 'dgu-dtm-20m', datum: 'EVRF2000', points: [{ dM: 0 }, { dM: 1 }] };
        const answers = [
            { ...valid, source: 'other-source' },
            { ...valid, datum: 'other-datum' },
            { source: valid.source, datum: valid.datum },
            { ...valid, points: [{ dM: 0 }] }
        ];
        for (const answer of answers) {
            await expect(reader.profile({}, { fetchImpl: async () => response(answer), global: {} }))
                .rejects.toThrow('Invalid terrain source response.');
        }
    });

    it('loads transit GeoJSON from the configured URL unchanged and rejects failed responses', async () => {
        const body = { type: 'FeatureCollection', features: [] };
        const fetchImpl = vi.fn(async () => response(body));
        await expect(BrowserSources.loadTransit({ id: 'fixture-transit', url: 'https://transit.example.test/routes.json' }, { fetchImpl }))
            .resolves.toBe(body);
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://transit.example.test/routes.json');
        await expect(BrowserSources.loadTransit({ id: 'fixture-transit-failed', url: 'https://transit.example.test/fail.json' }, {
            fetchImpl: async () => response({}, { ok: false, status: 503 })
        })).rejects.toThrow('fixture-transit-failed responded 503');
    });

    it('retains basemap defaults and keeps runtime API keys out of the source catalogue', () => {
        const osm = BrowserSources.basemap('openstreetmap');
        expect(osm).toEqual({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
        });
        const key = 'runtime-key-marker';
        const maptiler = BrowserSources.basemap('maptiler', { apiKey: key });
        expect(maptiler.url).toBe(`https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`);
        expect(maptiler.options).toMatchObject({ maxZoom: 22, tileSize: 512, zoomOffset: -1 });
        expect(JSON.stringify(SourceRuntime.catalogue())).not.toContain(key);
        expect(JSON.stringify(BrowserSources.basemaps.source('maptiler'))).not.toContain(key);
    });

    it('returns reality-mesh auth context to the caller without cataloguing the access token', () => {
        const token = 'runtime-token-marker';
        expect(BrowserSources.realityAuthentication({ accessToken: token })).toEqual({ apiToken: token, assetId: 2275207 });
        const catalogue = JSON.stringify(SourceRuntime.catalogue());
        expect(catalogue).not.toContain(token);
        expect(catalogue).toContain('google-photorealistic');
        expect(BrowserSources.reality.adapters().find(adapter => adapter.id === 'cesium-ion-3dtiles').custom).toBe(false);
    });

    it('keeps configured source identities and public configuration separate from runtime context', () => {
        const terrain = BrowserSources.terrain.source('dgu-dtm-20m');
        const photon = BrowserSources.geocoding.source('photon');
        expect(terrain).toMatchObject({ id: 'dgu-dtm-20m', abstraction: 'terrain-profile', adapter: 'dgu-dtm-20m', kind: 'default' });
        expect(photon).toMatchObject({ id: 'photon', abstraction: 'geocoding', adapter: 'photon', kind: 'default' });
        expect(terrain.config).toMatchObject({ source: 'dgu-dtm-20m', datum: 'EVRF2000', path: '/terrain/profile' });
        expect(photon.config.endpoint).toBe('https://photon.komoot.io/api/');
        expect(BrowserSources.geocoding.adapters().find(adapter => adapter.id === 'photon').custom).toBe(true);
        expect(BrowserSources.reality.source('google-photorealistic')).toMatchObject({ kind: 'default', adapter: 'cesium-ion-3dtiles' });
        const serialized = JSON.stringify(SourceRuntime.catalogue());
        expect(serialized).not.toContain('runtime-context-marker');
        expect(serialized).not.toContain('runtime-token-marker');
    });
});
