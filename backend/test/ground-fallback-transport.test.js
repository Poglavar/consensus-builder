// Exercise the session plan through the World's Fair transport, including its no-cadastre guards.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const EstimatedParcelSource = require('../../frontend/js/parcels/estimated-source.js');

function boot(city = 'explore', globals = {}) {
    const configs = [
        { id: 'explore', parcels: { source: 'none', gridSize: 0.005 } },
        { id: 'live', parcels: { source: 'parcel-source', sourceId: 'test-source', gridSize: 0.005 } }
    ];
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const window = {
        CityConfigManager: {
            getCurrentCityId: () => city,
            getAvailableCities: () => configs,
            datasetToLatLng: (e, n) => [n, e]
        },
        getCurrentCityId: () => city,
        getBackendBase: () => 'http://localhost:3195',
        fetchWithRetry: fetch,
        map: { getBounds: () => 'view-bounds' },
        updateStatus: vi.fn(),
        ParcelSourceSettings: { clearFailure: vi.fn() },
        ...globals
    };
    const context = vm.createContext({ window, console, URL, URLSearchParams, setTimeout, AbortController });
    for (const path of ['ground-fallback.js', 'fetch.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/parcels/${path}`, import.meta.url), 'utf8'), context);
    }
    return { window, transport: window.__cadastralGroundTransport, fetch };
}

describe('session ground on the World’s Fair branch', () => {
    it('restores saved estimates in a fresh tab and serves IDs, cells and proposal footprints locally', async () => {
        const entries = new Map();
        const localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
        const geometry = { type: 'Polygon', coordinates: [[[15.97,44],[15.971,44],[15.971,44.001],[15.97,44.001],[15.97,44]]] };
        const record = EstimatedParcelSource.createStore(localStorage).save('explore', {
            collection: { type:'FeatureCollection', features:[{ type:'Feature', id:'plot', properties:{ estimated:true }, geometry }] },
            bounds:[15.96,43.99,15.98,44.01]
        });
        const { window, transport, fetch } = boot('explore', { localStorage, EstimatedParcelSource });
        const id = record.collection.features[0].id;
        expect(window.ParcelGroundFallback.activeSource('explore').kind).toBe('estimated-local');
        expect((await transport.fetchBounds(null, { keys:['3194,8800'] })).features.map(f => f.properties.parcelId)).toEqual([id]);
        expect((await transport.fetchByIds([id])).features[0].properties.estimated).toBe(true);
        expect((await transport.fetchUnderGeometry(geometry)).features[0].properties.parcelId).toBe(id);
        expect(transport.supportsRoadIds()).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        window.ParcelGroundFallback.clearSource('explore');
        expect(boot('explore', { localStorage, EstimatedParcelSource }).window.ParcelGroundFallback.activeSource('explore')).toBeNull();
        expect(EstimatedParcelSource.createStore(localStorage).read('explore').collection.features).toHaveLength(1);
    });
    it('offers the no-register choices without fetching a backend or changing empty ground', async () => {
        const { window, transport, fetch } = boot();
        const offer = vi.fn();
        window.ParcelGroundFallback = { ...window.ParcelGroundFallback, onGroundUnavailable: offer };
        await expect(window.fetchParcelData()).resolves.toBeNull();
        expect(offer).toHaveBeenCalledWith(expect.objectContaining({
            city: 'explore', bounds: 'view-bounds', error: expect.objectContaining({ code: 'no-register' })
        }));
        await expect(transport.fetchBounds(null, { keys: ['-15877,8730'] })).resolves.toMatchObject({ features: [] });
        await expect(transport.fetchByIds(['missing'])).resolves.toMatchObject({ absentIds: ['missing'] });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('loads and rebuilds a visitor’s own register in a place with no cadastral source', async () => {
        const { window, transport, fetch } = boot();
        const parcel = { type: 'Feature', properties: { parcelId: 'CUSTOM-1', provenance: 'custom-url' },
            geometry: { type: 'Polygon', coordinates: [[[15.97, 44], [15.971, 44], [15.971, 44.001], [15.97, 44]]] } };
        const source = {
            id: 'custom:test', kind: 'custom-url', label: 'Your register link',
            fetchCell: () => ({ features: [parcel], returnsWGS84: true }),
            fetchByIds: ids => ({ features: ids.includes('CUSTOM-1') ? [parcel] : [], absentIds: ids.filter(id => id !== 'CUSTOM-1') }),
            describe: () => null
        };
        window.ParcelGroundFallback.installSource('explore', source);
        const result = await transport.fetchBounds(null, { keys: ['-15877,8730'] });
        expect(result.returnsWGS84).toBe(true);
        expect(result.features.length).toBeGreaterThan(0);
        const feature = result.features[0];
        expect(feature.properties).toMatchObject({ provenance: 'custom-url' });
        const byId = await transport.fetchByIds([feature.properties.parcelId, 'missing']);
        expect(byId.features).toEqual([feature]);
        expect(byId.absentIds).toEqual(['missing']);
        window.CadastralParcelRepository = { ensureBounds: vi.fn(async () => result) };
        await expect(window.fetchParcelData()).resolves.toEqual(result);
        expect(window.CadastralParcelRepository.ensureBounds).toHaveBeenCalledWith('view-bounds', expect.any(Object));
        expect(window.updateStatus).toHaveBeenLastCalledWith(expect.stringContaining(source.label));
        expect(window.ParcelSourceSettings.clearFailure).toHaveBeenCalledWith(window);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('offers the fallback on a live-source failure and preserves rejection and failure reporting', async () => {
        const { window } = boot('live');
        const failure = new TypeError('Failed to fetch');
        const offer = vi.fn();
        window.ParcelGroundFallback = { ...window.ParcelGroundFallback, onGroundUnavailable: offer };
        window.CadastralParcelRepository = { ensureBounds: vi.fn(async () => { throw failure; }) };
        await expect(window.fetchParcelData()).rejects.toBe(failure);
        expect(offer).toHaveBeenCalledWith({ error: failure, bounds: 'view-bounds', city: 'live',
            message: 'Cadastral ground failed to load: Failed to fetch' });
        expect(window._fetchParcelDataInProgress).toBe(false);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(window.fetchParcelDataReported(undefined, 'initial map load')).resolves.toBeNull();
            // Logged for the Activity log; the banner carries it, so the status line is not asked to.
            expect(window.updateStatus).toHaveBeenLastCalledWith('Cadastral ground failed to load: Failed to fetch', { floating: false });
            expect(errors).toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }
    });
});
