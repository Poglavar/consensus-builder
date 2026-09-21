import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');

function bootTransport(city, fetch) {
    const window = {
        fetch,
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
});
