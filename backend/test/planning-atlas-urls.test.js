// URL-configured Atlas sources must retain identity/evidence and isolate download failures.
import { describe, expect, it, vi } from 'vitest';
import { parseAtlasSources, createAtlasUrlProvider } from '../planning/atlas-url-sources.js';
import { createPlanningSources, planningRepresentations, planningRecord } from '../planning/sources.js';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { setupPlanningRoutes } from '../routes/planning.js';

const metadata = { id: 'atlas-example', city: 'example', label: 'Atlas · Example', edition: 'sample',
    url: 'https://example.com/slices.geojson' };
const collection = () => ({ type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: [{ type: 'Feature', properties: { slice_id: 17, jurisdiction: 'Example',
        family1_treatment: 'allowed', family1_maxheightft: 35, family1_maxheightft_method: 'estimation' },
    geometry: { type: 'Polygon', coordinates: [[[10,40],[10.001,40],[10.001,40.001],[10,40.001],[10,40]]] } }] });
const query = { city: metadata.city, source: metadata.id, bbox: [10,40,10.002,40.002], limit: 10 };
const response = data => new Response(JSON.stringify(data));
const config = (...entries) => JSON.stringify(entries);

describe('Atlas URL configuration', () => {
    it('is opt-in, supports multiple datasets and normalizes public URLs without fetching', () => {
        expect(parseAtlasSources()).toEqual([]);
        const fetchImpl = vi.fn();
        const sources = createPlanningSources(config(metadata, { ...metadata, id: 'atlas-second', default: false,
            url: 'https://EXAMPLE.com:443/second.geojson' }), { fetchImpl });
        expect(sources.filter(s => s.descriptor.city === 'example').map(s => [s.descriptor.id, s.descriptor.default]))
            .toEqual([['atlas-example', true], ['atlas-second', false]]);
        expect(sources.at(-1).descriptor.url).toBe('https://example.com/second.geojson');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([
        'invalid json', '{}', 'null', config({ ...metadata, id: '' }), config({ ...metadata, city: 'Bad city' }),
        config({ ...metadata, edition: '' }), config({ ...metadata, label: '' }), config({ ...metadata, default: 'yes' }),
        config({ ...metadata, url: 'file:///tmp/slices.geojson' }), config({ ...metadata, url: 'http://example.com/data' }),
        config({ ...metadata, url: 'https://[::1]/data' }), config({ ...metadata, url: 'https://example.com/data?api_key=hidden' }),
        config({ ...metadata, url: 'https://user:hidden@example.com/data' }), config({ ...metadata, headers: { Authorization: 'hidden' } }),
        config(metadata, metadata), JSON.stringify(Array(21).fill(metadata))
    ])('rejects malformed or unsafe configuration without echoing its contents: %#', value => {
        expect(() => parseAtlasSources(value)).toThrow(/^Invalid PLANNING_ATLAS_SOURCES configuration\./);
        try { parseAtlasSources(value); } catch (error) { expect(error.message).not.toContain('hidden'); }
    });
    it('refuses source IDs already owned by a built-in provider', () => {
        expect(() => createPlanningSources(config({ ...metadata, id: 'nyc-r6a-pilot-2026-10-19' }))).toThrow(/conflicts/);
    });
    it('retains an explicitly configured parcel provider and rejects malformed provider IDs', () => {
        const sources = createPlanningSources(config({ ...metadata, parcelSourceId: 'us-co-oit-statewide-parcels' }));
        expect(sources.at(-1).descriptor).toMatchObject({ parcelSourceId: 'us-co-oit-statewide-parcels', parcelStudy: 'direct-dimensions.v1' });
        expect(() => parseAtlasSources(config({ ...metadata, parcelSourceId: '../invalid' }))).toThrow(/Invalid PLANNING_ATLAS_SOURCES/);
    });
});

describe('Atlas URL loading', () => {
    it('loads once across concurrent viewport/record reads and retains provider identity, bounds and evidence', async () => {
        const fetchImpl = vi.fn(async () => response(collection()));
        const sources = createPlanningSources(config(metadata), { fetchImpl });
        const [viewport, record] = await Promise.all([
            planningRepresentations({}, query, sources),
            planningRecord({}, { city: 'example', source: metadata.id, recordId: '17' }, sources)
        ]);
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(metadata.url);
        expect(viewport.items[0]).toMatchObject({ id: 'atlas-example:17', role: 'permitted', volumes: [],
            source: { ...metadata, bbox: [10,40,10.001,40.001] },
            constraints: [expect.objectContaining({ quantity: 'height', value: 35, evidence: 'estimated' })] });
        expect(record.items[0].source.version).toBe(viewport.items[0].source.version);
        await planningRepresentations({}, { ...query, scenario: 'family4' }, sources);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it.each([() => { throw new Error('private transport detail'); },
        () => Promise.reject(new Error('private transport detail')), () => response({ features: [] }),
        () => new Response('not json'), () => new Response('unavailable', { status: 503 })])(
        'reports an unavailable dataset and permits a later retry: %#', async failed => {
            const fetchImpl = vi.fn().mockImplementationOnce(failed).mockImplementation(async () => response(collection()));
            const source = createAtlasUrlProvider(metadata, { fetchImpl });
            await expect(source.query({}, query)).rejects.toMatchObject({ status: 503,
                message: 'Atlas URL could not be loaded as a valid slices dataset.' });
            expect((await source.query({}, query)).items).toHaveLength(1);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    it('distinguishes a valid dataset outside the viewport from an unavailable source', async () => {
        const source = createAtlasUrlProvider(metadata, { fetchImpl: async () => response(collection()) });
        expect(await source.query({}, { ...query, bbox: [11,40,11.001,40.001] })).toMatchObject({
            items: [], nextAfter: null, summary: { cachedResults: 0 } });
    });
    it.each([
        data => { data.features = []; },
        data => { data.features.push(structuredClone(data.features[0])); },
        data => { data.features[0].properties.slice_id = {}; },
        data => { data.features[0].geometry.coordinates[0][0][0] = 181; },
        data => { data.features[0].geometry.coordinates[0].pop(); },
        data => { data.crs.properties.name = 'EPSG:3857'; }
    ])('rejects invalid geography or identity before exposing a source: %#', mutate => {
        const data = collection(); mutate(data);
        expect(() => createAtlasProvider(data, metadata)).toThrow(/Invalid Atlas|Duplicate Atlas/);
    });
    it('exposes configured URLs through the existing sources, representations and record routes', async () => {
        const fetchImpl = vi.fn(async () => response(collection()));
        const handlers = {}, sources = createPlanningSources(config(metadata), { fetchImpl });
        setupPlanningRoutes({ get: (path, fn) => { handlers[path] = fn; } }, {}, { sources });
        const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() };
        await handlers['/planning/sources']({ query: { city: 'example' } }, res);
        expect(res.json.mock.lastCall[0].sources).toEqual([expect.objectContaining(metadata)]);
        expect(fetchImpl).not.toHaveBeenCalled();
        await handlers['/planning/representations']({ query: { ...query, bbox: query.bbox.join(',') } }, res);
        expect(res.json.mock.lastCall[0].items[0].id).toBe('atlas-example:17');
        await handlers['/planning/record']({ query: { city: 'example', source: metadata.id, recordId: '17' } }, res);
        expect(res.json.mock.lastCall[0].items[0].source.url).toBe(metadata.url);
        expect(res.status).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
