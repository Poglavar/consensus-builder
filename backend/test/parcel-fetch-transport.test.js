import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');
const progressSource = readFileSync(new URL('../../frontend/js/parcels/source-progress.js', import.meta.url), 'utf8');

function bootPage(city, fetch, parcels = { source: 'parcel-bg' }, BrowserParcelSources = {}, globals = {}) {
    const window = {
        fetch,
        BrowserParcelSources,
        CityConfigManager: { getCityConfig: () => ({ id: city, parcels }) },
        getBackendBase: () => 'https://api.urbangametheory.xyz',
        getCurrentCityId: () => city,
        getCurrentDataSource: () => 'backend',
        ...globals
    };
    const context = vm.createContext({
        window,
        fetch,
        URL,
        URLSearchParams,
        console,
        setTimeout
    });
    vm.runInContext(progressSource, context);
    vm.runInContext(source, context);
    return window;
}
const bootTransport = (...args) => bootPage(...args).__cadastralGroundTransport;

describe('cadastral parcel fetch transport', () => {
    it('forwards browser source progress through the viewport transport', async () => {
        const detail = { phase: 'source-download', authority: 'Oxford', loadedBytes: 5e6, totalBytes: 20e6 };
        const onProgress = vi.fn();
        const queryBounds = vi.fn(async (_source, _bounds, options) => {
            options.onProgress(detail);
            return { complete: true, features: [] };
        });
        const page = bootPage('oxford', vi.fn(), { source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', gridSize: 100 },
            { queryBounds }, { datasetToWgs84: (e, n) => [e / 1e5, n / 1e5] });
        await page.__cadastralGroundTransport.fetchBounds(null, { keys: ['0,0'], onProgress });
        expect(queryBounds).toHaveBeenCalledWith('gb-hmlr-browser-v1', [0, 0, 0.001, 0.001], { city: 'oxford', onProgress });
        expect(onProgress).toHaveBeenCalledWith(detail);
    });

    it('renders live counters once per change, then replaces them with the completed status', async () => {
        const updateStatus = vi.fn();
        const detail = { phase: 'source-download', authority: 'Oxford', loadedBytes: 5e6, totalBytes: 20e6 };
        const page = bootPage('oxford', vi.fn(), { source: 'parcel-source' }, {}, {
            updateStatus,
            CadastralParcelRepository: { async ensureBounds(_bounds, { onProgress }) {
                onProgress(detail); onProgress(detail);
                onProgress({ phase: 'source-decompress', authority: 'Oxford' });
                onProgress({ phase: 'source-process', authority: 'Oxford', processedFeatures: 250, totalFeatures: 1000 });
                onProgress({ phase: 'source-prepare' });
                return { features: [{ id: 'parcel' }] };
            } }
        });
        await page.fetchParcelData([0, 0, 0.001, 0.001]);
        expect(updateStatus.mock.calls).toEqual([
            ['Checking cadastral ground…'],
            ['Downloading Oxford… 5.0 / 20.0 MB', { transient: true }],
            ['Decompressing Oxford…', { transient: true }],
            ['Unpacking and processing Oxford… 250 / 1,000 parcels', { transient: true }],
            ['Preparing parcels for the map…', { transient: true }],
            ['Loaded 1 cadastral parcels.']
        ]);
    });

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
