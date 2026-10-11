import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');

function bootTransport(city, fetch, parcels = { source: 'parcel-bg' }, BrowserParcelSources = {}) {
    const window = {
        fetch,
        BrowserParcelSources,
        CityConfigManager: { getCityConfig: () => ({ id: city, parcels }) },
        getBackendBase: () => 'https://api.urbangametheory.xyz',
        getCurrentCityId: () => city,
        getCurrentDataSource: () => 'backend'
    };
    const context = vm.createContext({
        window,
        fetch,
        URL,
        URLSearchParams,
        console,
        setTimeout
    });
    vm.runInContext(source, context);
    return window.__cadastralGroundTransport;
}

describe('cadastral parcel fetch transport', () => {
    it('loads Belgrade proposal ground through the Serbian parcel endpoint', async () => {
        const feature = {
            type: 'Feature',
            properties: { parcelId: 'SR-716090-2581/1' },
            geometry: { type: 'Polygon', coordinates: [] }
        };
        const fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ type: 'FeatureCollection', features: [feature] })
        }));
        const transport = bootTransport('belgrade', fetch);

        const result = await transport.fetchByIds(['SR-716090-2581/1']);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe(
            'https://api.urbangametheory.xyz/parcel-bg?parcel_id=SR-716090-2581%2F1'
        );
        expect(result.status).toBe('ready');
        expect(result.absentIds).toEqual([]);
        expect(result.features[0].properties.parcelId).toBe('SR-716090-2581/1');
    });

    it('queries configured live parcel sources through BrowserParcelSources without route fallback', async () => {
        const feature = { type: 'Feature', properties: { parcelId: 'PL-SAMPLE-7' }, geometry: { type: 'Polygon', coordinates: [] } };
        const queryIds = vi.fn(async () => ({ complete: true, features: [feature], absentIds: [] }));
        const fetch = vi.fn();
        const transport = bootTransport('sample', fetch,
            { source: 'parcel-source', sourceId: 'pl-sample-source' }, { queryIds });

        const result = await transport.fetchByIds(['PL-SAMPLE-7']);

        expect(result.features[0].properties.parcelId).toBe('PL-SAMPLE-7');
        expect(queryIds).toHaveBeenCalledWith('pl-sample-source', ['PL-SAMPLE-7'], { city: 'sample' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
