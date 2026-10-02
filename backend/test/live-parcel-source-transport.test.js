// Exercises provider selection at the frontend boundary, including explicit-city reads and failures.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sourceId = 'ca-on-toronto-property-boundary';
const toronto = { id: 'toronto', parcels: { source: 'parcel-source', sourceId, gridSize: 0.005, requiresBackend: true } };
const cityConfigs = [toronto, { id: 'explore', parcels: { source: 'none' } },
    { id: 'different_city', parcels: { source: 'parcel-bg' } }];
const polygon = { type: 'Polygon', coordinates: [[[-79.385, 43.65], [-79.38, 43.65], [-79.38, 43.655], [-79.385, 43.65]]] };
const parcel = { type: 'Feature', properties: { parcelId: 'CA-ON-TORONTO-123' }, geometry: polygon };
const response = payload => ({ ok: true, status: 200, json: async () => payload });

function boot(fetch, currentCity = 'toronto') {
    const storage = { getItem: () => null, setItem() {} };
    const manager = {
        getCurrentCityId: () => currentCity,
        getCurrentCityConfig: () => cityConfigs.find(c => c.id === currentCity),
        getCityConfig: id => cityConfigs.find(c => c.id === id),
        getAvailableCities: () => cityConfigs,
        requiresBackendDataSource: () => true,
        hasParcelData: () => currentCity !== 'explore',
        datasetToLatLng: (e, n) => [n, e]
    };
    const window = { fetch, CityConfigManager: manager, current_environment: 'development',
        getCurrentCityId: manager.getCurrentCityId,
        location: { hostname: 'localhost', protocol: 'http:', search: '?backend=http://localhost:4638' } };
    const context = vm.createContext({ window, fetch, localStorage: storage, PersistentStorage: storage,
        document: { addEventListener() {} }, URL, URLSearchParams, console, setTimeout });
    for (const path of ['data-source.js', 'parcels/fetch.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8'), context);
    }
    return { transport: window.__cadastralGroundTransport, window };
}

describe('live parcel source transport', () => {
    it('loads a grid cell through the gateway in WGS84', async () => {
        const fetch = vi.fn(async () => response({ type: 'FeatureCollection', complete: true, features: [parcel] }));
        const { transport } = boot(fetch);
        const result = await transport.fetchBounds(null, { keys: ['-15877,8730'] });
        expect(result).toMatchObject({ status: 'ready', returnsWGS84: true, features: [parcel] });
        const url = new URL(fetch.mock.calls[0][0]);
        expect(url.origin).toBe('http://localhost:4638');
        expect(url.pathname).toBe(`/parcel-sources/${sourceId}`);
        const coords = url.searchParams.get('bbox').split(',').map(Number);
        expect(coords[0]).toBeCloseTo(-79.385);
        expect(coords[1]).toBeCloseTo(43.65);
        expect(coords[2]).toBeCloseTo(-79.38);
        expect(coords[3]).toBeCloseTo(43.655);
    });

    it('resolves another city explicitly while the current view has no parcels', async () => {
        const fetch = vi.fn(async () => response({ complete: true, features: [parcel], absentIds: ['CA-ON-TORONTO-404'] }));
        const { transport } = boot(fetch, 'explore');
        const result = await transport.fetchByIds(['CA-ON-TORONTO-123', 'CA-ON-TORONTO-404'], { city: 'toronto' });
        expect(result.absentIds).toEqual(['CA-ON-TORONTO-404']);
        expect(new URL(fetch.mock.calls[0][0]).pathname).toBe(`/parcel-sources/${sourceId}`);
    });

    it('selects an imported provider by configuration without depending on the city name', async () => {
        const fetch = vi.fn(async () => response({ features: [{ ...parcel, properties: { parcelId: 'SR-1-2' } }] }));
        const { transport } = boot(fetch, 'different_city');
        await transport.fetchByIds(['SR-1-2']);
        expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/parcel-bg');
    });

    it('uses the same source for an authored footprint', async () => {
        const fetch = vi.fn(async () => response({ complete: true, features: [parcel] }));
        const { transport } = boot(fetch);
        const result = await transport.fetchUnderGeometry(polygon);
        expect(result.features).toEqual([parcel]);
        expect(fetch.mock.calls[0][0]).toBe(`http://localhost:4638/parcel-sources/${sourceId}/under`);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ geometry: polygon, srid: 4326 });
    });

    it('never accepts incomplete cells, IDs or footprints as missing ground', async () => {
        const fetch = vi.fn(async () => response({ features: [], complete: false }));
        const { transport } = boot(fetch);
        await expect(transport.fetchBounds(null, { keys: ['-15877,8730'] })).rejects.toThrow(/incomplete/);
        await expect(transport.fetchByIds(['CA-ON-TORONTO-123'])).rejects.toThrow(/incomplete/);
        await expect(transport.fetchUnderGeometry(polygon)).rejects.toThrow(/incomplete/);
    });
});
