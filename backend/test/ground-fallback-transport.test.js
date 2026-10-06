// Exercise the session plan through the World's Fair transport, including its no-cadastre guards.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function boot(city = 'explore') {
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
        ParcelSourceSettings: { clearFailure: vi.fn() }
    };
    const context = vm.createContext({ window, console, URL, URLSearchParams, setTimeout });
    for (const path of ['schelling-grid.js', 'ground-fallback.js', 'fetch.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/parcels/${path}`, import.meta.url), 'utf8'), context);
    }
    return { window, transport: window.__cadastralGroundTransport, fetch };
}

describe('session ground on the World’s Fair branch', () => {
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

    it('loads and rebuilds real Schelling parcels in a place with no cadastral source', async () => {
        const { window, transport, fetch } = boot();
        const source = window.ParcelGroundFallback.schellingSource({ lat: 44 });
        window.ParcelGroundFallback.installSource('explore', source);
        const result = await transport.fetchBounds(null, { keys: ['-15877,8730'] });
        expect(result.returnsWGS84).toBe(true);
        expect(result.features.length).toBeGreaterThan(0);
        const feature = result.features[0];
        expect(feature.properties).toMatchObject({ provenance: 'schelling-point', estimated: true });
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
        expect(offer).toHaveBeenCalledWith({ error: failure, bounds: 'view-bounds', city: 'live' });
        expect(window._fetchParcelDataInProgress).toBe(false);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(window.fetchParcelDataReported(undefined, 'initial map load')).resolves.toBeNull();
            expect(window.updateStatus).toHaveBeenLastCalledWith('Cadastral ground failed to load: Failed to fetch');
            expect(errors).toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }
    });
});
