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
        setTimeout,
        AbortController
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

    it('fetches HMLR cell blocks in one source query and answers each cell with the parcels overlapping it', async () => {
        const square = (id, west, south, size) => ({ type: 'Feature', properties: { parcelId: id }, geometry: { type: 'Polygon',
            coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] } });
        const west = square('WEST', 0.0002, 0.0002, 0.0002), across = square('ACROSS', 0.0008, 0.0002, 0.0004), east = square('EAST', 0.0015, 0.0002, 0.0002);
        const queryBounds = vi.fn(async () => ({ complete: true, features: [west, across, east] }));
        const hmlr = { source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', gridSize: 0.001 };
        const transport = bootTransport('oxford', vi.fn(), hmlr, { queryBounds }, { datasetToWgs84: (e, n) => [n, e] });

        expect(transport.cellBlockSide({ city: 'oxford' })).toBe(5);
        const block = await transport.fetchCellBlock(null, { city: 'oxford', keys: ['0,0', '1,0'] });
        expect(queryBounds).toHaveBeenCalledTimes(1);
        expect(queryBounds.mock.calls[0][0]).toBe('gb-hmlr-browser-v1');
        expect(queryBounds.mock.calls[0][1]).toEqual([0, 0, 0.002, 0.001]);
        expect(block.cells.map(({ key, result }) => [key, result.features.map(item => item.properties.parcelId)]))
            .toEqual([['0,0', ['WEST', 'ACROSS']], ['1,0', ['ACROSS', 'EAST']]]);
    });

    it('loads IDs saved under an earlier source from that source and current IDs from the current one', async () => {
        const feature = id => ({ type: 'Feature', properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [] } });
        const queryIds = vi.fn(async (_source, ids) => ({ complete: true, features: ids.map(feature), absentIds: [] }));
        const london = { source: 'parcel-source', sourceId: 'gb-hmlr-browser-v1', idPrefix: 'GB-HMLR-BROWSER-v1-',
            historicalSources: [{ sourceId: 'gb-hmlr-city-of-london', idPrefix: 'GB-HMLR-LONDON-' }] };
        const transport = bootTransport('london', vi.fn(), london, { queryIds });

        const result = await transport.fetchByIds(['GB-HMLR-LONDON-50654735', 'GB-HMLR-BROWSER-v1-7', 'GB-HMLR-LONDON-2']);

        expect(queryIds.mock.calls.map(([source, ids]) => [source, ids])).toEqual([
            ['gb-hmlr-city-of-london', ['GB-HMLR-LONDON-50654735', 'GB-HMLR-LONDON-2']],
            ['gb-hmlr-browser-v1', ['GB-HMLR-BROWSER-v1-7']]
        ]);
        expect(result.absentIds).toEqual([]);
    });

    it('queries Poland\'s collective EGiB WFS in 3x3 blocks, one ~3 s request per block', () => {
        const poland = bootTransport('szczecin', vi.fn(), { source: 'parcel-source', sourceId: 'pl-gugik-egib-wfs', gridSize: 0.001 });
        expect(poland.cellBlockSide({ city: 'szczecin' })).toBe(3);
    });

    it('queries HSAC Haryana district layers in 4x4 blocks, not the uq-keyed layers they replace', () => {
        const haryana = bootTransport('panipat', vi.fn(), { source: 'parcel-source', sourceId: 'in-hr-hsac-panipat-outlines', gridSize: 0.001 });
        expect(haryana.cellBlockSide({ city: 'panipat' })).toBe(4);
        const keyed = bootTransport('panipat', vi.fn(), { source: 'parcel-source', sourceId: 'in-hr-hsac-panipat', gridSize: 0.001 });
        expect(keyed.cellBlockSide({ city: 'panipat' })).toBe(1);
    });

    it('keeps every other source on per-cell queries', () => {
        const other = bootTransport('richmond', vi.fn(), { source: 'parcel-source', sourceId: 'us-va-richmond-parcels', gridSize: 0.001 });
        const legacy = bootTransport('zagreb', vi.fn(), { source: 'parcel-bg' });
        expect(other.cellBlockSide({ city: 'richmond' })).toBe(1);
        expect(legacy.cellBlockSide({ city: 'zagreb' })).toBe(1);
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

    it('reports a body that fails mid-read by its own name and message, not a read-only-message TypeError', async () => {
        // A DOMException's message is a getter: the old wrapper assigned to it and threw
        // "Cannot set property message … which has only a getter", hiding the real reason.
        class ReadOnlyMessageError extends Error {
            get message() { return 'The operation was aborted.'; }
            get name() { return 'AbortError'; }
        }
        const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new ReadOnlyMessageError(); } }));
        const transport = bootTransport('belgrade', fetch);

        const failure = await transport.fetchByIds(['SR-716090-2581/1']).catch(error => error);

        // (an Error of the page's own realm, so no instanceof across the vm boundary)
        expect(failure.name).toBe('AbortError');
        expect(failure.message).toContain('The operation was aborted.');
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
