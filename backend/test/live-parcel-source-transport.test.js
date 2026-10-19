// Exercises the browser adapter boundary for registered live sources, including explicit-city
// reads, completeness checks, and failures without an HTTP parcel-route fallback.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sourceId = 'ca-on-toronto-property-boundary';
const toronto = { id: 'toronto', parcels: { source: 'parcel-source', sourceId, gridSize: 0.005, requiresBackend: true } };
const cityConfigs = [toronto, { id: 'explore', parcels: { source: 'none' } },
    { id: 'different_city', parcels: { source: 'parcel-bg' } },
    { id: 'point_city', parcels: { source: 'parcel-source', sourceId: 'point-source', strategy: 'point' } },
    { id: 'slow_city', parcels: { source: 'parcel-source', sourceId: 'slow-source', idBatchSize: 3 } },
    { id: 'invalid_batch', parcels: { source: 'parcel-source', sourceId: 'slow-source', idBatchSize: 0 } }];
const polygon = { type: 'Polygon', coordinates: [[[-79.385, 43.65], [-79.38, 43.65], [-79.38, 43.655], [-79.385, 43.65]]] };
const parcel = { type: 'Feature', properties: { parcelId: 'CA-ON-TORONTO-123' }, geometry: polygon };
const response = payload => ({ ok: true, status: 200, json: async () => payload });

function boot(fetch, currentCity = 'toronto', BrowserParcelSources = {}) {
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
    const window = { fetch, BrowserParcelSources, CityConfigManager: manager, current_environment: 'development',
        getBackendBase: () => 'http://localhost:4638', getCurrentCityId: manager.getCurrentCityId,
        location: { hostname: 'localhost', protocol: 'http:', search: '?backend=http://localhost:4638' } };
    const context = vm.createContext({ window, fetch, localStorage: storage, PersistentStorage: storage,
        document: { addEventListener() {} }, URL, URLSearchParams, console, setTimeout });
    for (const path of ['data-source.js', 'parcels/fetch.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8'), context);
    }
    return { transport: window.__cadastralGroundTransport, window };
}

describe('live parcel source browser transport', () => {
    it('loads a grid cell by querying the browser adapter directly with WGS84 bounds and city', async () => {
        const browserSources = { queryBounds: vi.fn(async () => ({ sourceId, complete: true, features: [parcel] })) };
        const fetch = vi.fn();
        const { transport } = boot(fetch, 'toronto', browserSources);
        const result = await transport.fetchBounds(null, { keys: ['-15877,8730'] });

        expect(result).toMatchObject({ status: 'ready', returnsWGS84: true, features: [parcel] });
        expect(browserSources.queryBounds).toHaveBeenCalledOnce();
        const [calledSource, bounds, options] = browserSources.queryBounds.mock.calls[0];
        expect(calledSource).toBe(sourceId);
        expect(bounds).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]));
        expect(bounds[0]).toBeCloseTo(-79.385);
        expect(bounds[1]).toBeCloseTo(43.65);
        expect(bounds[2]).toBeCloseTo(-79.38);
        expect(bounds[3]).toBeCloseTo(43.655);
        expect(options).toEqual({ city: 'toronto' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('resolves exact IDs for an explicit city, preserving returned parcel IDs and confirmed absences', async () => {
        const missing = 'CA-ON-TORONTO-404';
        const browserSources = { queryIds: vi.fn(async () => ({ sourceId, complete: true,
            features: [parcel], absentIds: [missing] })) };
        const fetch = vi.fn();
        const { transport } = boot(fetch, 'explore', browserSources);
        const result = await transport.fetchByIds(['CA-ON-TORONTO-123', missing], { city: 'toronto' });

        expect(result.features.map(feature => feature.properties.parcelId)).toEqual(['CA-ON-TORONTO-123']);
        expect(result.absentIds).toEqual([missing]);
        expect(browserSources.queryIds).toHaveBeenCalledWith(sourceId, ['CA-ON-TORONTO-123', missing], { city: 'toronto' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('selects an imported provider by configuration without depending on the city name', async () => {
        const fetch = vi.fn(async () => response({ features: [{ ...parcel, properties: { parcelId: 'SR-1-2' } }] }));
        const { transport } = boot(fetch, 'different_city');
        await transport.fetchByIds(['SR-1-2']);
        expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/parcel-bg');
    });

    it('queries authored geometry through the browser adapter and passes its city', async () => {
        const browserSources = { queryGeometry: vi.fn(async () => ({ sourceId, complete: true, features: [parcel] })) };
        const fetch = vi.fn();
        const { transport } = boot(fetch, 'toronto', browserSources);
        const result = await transport.fetchUnderGeometry(polygon, { city: 'toronto', srid: 4326 });

        expect(result).toMatchObject({ status: 'ready', returnsWGS84: true, features: [parcel], absentIds: [] });
        expect(browserSources.queryGeometry).toHaveBeenCalledWith(sourceId, polygon, { city: 'toronto' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('queries a point through the browser adapter and rejects a changed source identity', async () => {
        const point = [-79.382, 43.652];
        const feature = { ...parcel, properties: { parcelId: 'CA-ON-TORONTO-123' } };
        const browserSources = { queryPoint: vi.fn().mockResolvedValueOnce({
            sourceId: 'point-source', complete: true, queryType: 'point', features: [feature]
        }).mockResolvedValueOnce({ complete: true, queryType: 'point', features: [feature] }) };
        const fetch = vi.fn();
        const { transport } = boot(fetch, 'point_city', browserSources);

        await expect(transport.fetchPoint(point, { city: 'point_city' })).resolves.toMatchObject({
            status: 'ready', complete: true, queryType: 'point', features: [feature]
        });
        expect(browserSources.queryPoint).toHaveBeenNthCalledWith(1, 'point-source', point, { city: 'point_city' });
        await expect(transport.fetchPoint(point, { city: 'point_city' })).rejects.toThrow(/incomplete point/);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('splits slow-source ID requests and rejects an ID batch that omits both a feature and absence', async () => {
        const ids = Array.from({ length: 8 }, (_, index) => `slow:${index}`);
        const browserSources = { queryIds: vi.fn(async (_sourceId, batch) => ({ complete: true,
            features: batch.filter(id => id !== 'slow:4').map(id => ({ ...parcel, properties: { parcelId: id } })),
            absentIds: batch.filter(id => id === 'slow:4') })) };
        const fetch = vi.fn();
        const { transport } = boot(fetch, 'slow_city', browserSources);
        const result = await transport.fetchByIds(ids);
        expect(browserSources.queryIds.mock.calls.map(([, batch, options]) => [batch, options]))
            .toEqual([[ids.slice(0, 3), { city: 'slow_city' }], [ids.slice(3, 6), { city: 'slow_city' }], [ids.slice(6), { city: 'slow_city' }]]);
        expect(result.features.map(feature => feature.properties.parcelId)).toEqual(ids.filter(id => id !== 'slow:4'));
        expect(result.absentIds).toEqual(['slow:4']);

        browserSources.queryIds.mockClear().mockResolvedValue({ complete: true, features: [], absentIds: [] });
        await expect(transport.fetchByIds(['slow:missing'])).rejects.toThrow(/omitted requested IDs/);
        expect(fetch).not.toHaveBeenCalled();

        browserSources.queryIds.mockClear();
        const invalid = boot(fetch, 'invalid_batch', browserSources).transport;
        await expect(invalid.fetchByIds(ids)).rejects.toThrow(/batch size/);
        expect(browserSources.queryIds).not.toHaveBeenCalled();
    });

    it('surfaces browser adapter failures and rejects incomplete bounds, IDs, and footprints', async () => {
        const failure = Object.assign(new Error('provider unavailable'), { code: 'parcel-source-unavailable', status: 502 });
        const browserSources = {
            queryBounds: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ complete: false, features: [] }),
            queryIds: vi.fn().mockResolvedValue({ complete: false, features: [], absentIds: [] }),
            queryGeometry: vi.fn().mockResolvedValue({ complete: false, features: [] })
        };
        const { transport } = boot(vi.fn(), 'toronto', browserSources);
        await expect(transport.fetchBounds(null, { keys: ['-15877,8730'] })).rejects.toBe(failure);
        await expect(transport.fetchBounds(null, { keys: ['-15877,8730'] })).rejects.toThrow(/incomplete viewport/);
        await expect(transport.fetchByIds(['CA-ON-TORONTO-123'])).rejects.toThrow(/incomplete ID/);
        await expect(transport.fetchUnderGeometry(polygon)).rejects.toThrow(/incomplete footprint/);
    });
});
