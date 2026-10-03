// Checks complete transient snapshot reads, reversible native identity and fail-closed refresh boundaries.
import { describe, expect, it, vi } from 'vitest';
import { createGeojsonSnapshotParcelSource, encodeSnapshotNativeId, decodeSnapshotNativeId } from '../parcels/geojson-snapshot-source.js';

const descriptor = { id: 'snapshot', endpoint: 'https://example.org/2026.geojson', idPrefix: 'JP-2026-',
    idFields: ['city', 'sheet', 'native'], outFields: ['city', 'sheet', 'native', 'lot'], parcelNumberField: 'lot',
    maxSnapshotBytes: 100000, maxSnapshotFeatures: 100, maxFeatures: 100, maxBboxKm2: 25 };
const square = (west = 135.5, south = 34.68) => ({ type: 'Polygon', coordinates: [[[west, south],
    [west + .001, south], [west + .001, south + .001], [west, south + .001], [west, south]]] });
const feature = (native = 'H001', geometry = square()) => ({ type: 'Feature', geometry,
    properties: { city: '27128', sheet: '大阪~中央 / 図1', native, lot: '21-1', owner: 'not requested' } });
const collection = features => ({ type: 'FeatureCollection', features });
const response = (data, options) => new Response(JSON.stringify(data), options);
const nativeId = value => descriptor.idPrefix + encodeSnapshotNativeId(['27128', '大阪~中央 / 図1', value]);
const bounds = [135.4999, 34.6799, 135.5011, 34.6811];
const adapter = (data, changes = {}, options = {}) => createGeojsonSnapshotParcelSource({ ...descriptor, ...changes },
    { fetchImpl: vi.fn(async () => response(data)), ...options });

describe('GeoJSON snapshot parcel source', () => {
    it('encodes Japanese keys reversibly without tilde delimiter collisions', () => {
        const key = encodeSnapshotNativeId(['27128', '大阪~中央 / 図1', 'H001']);
        expect(key.split('~')).toHaveLength(3);
        expect(key).toContain('%7E');
        expect(decodeSnapshotNativeId(key, 3)).toEqual(['27128', '大阪~中央 / 図1', 'H001']);
        expect(() => decodeSnapshotNativeId(key.replace('%7E', '~'), 3)).toThrow();
        expect(() => decodeSnapshotNativeId('27128~%ZZ~H001', 3)).toThrow();
        expect(() => decodeSnapshotNativeId('27128~%e5%a4%a7~H001', 3)).toThrow();
        expect(() => encodeSnapshotNativeId(['', 'x'])).toThrow();
    });
    it('returns complete bounds, exact absences and native metadata with fresh result objects', async () => {
        const fetchImpl = vi.fn(async () => response(collection([feature()])));
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        const found = await source.queryBounds(bounds);
        expect(found).toMatchObject({ complete: true, returnsWGS84: true, sourceId: 'snapshot' });
        expect(found.features[0]).toMatchObject({ id: nativeId('H001'),
            properties: { parcelNumber: '21-1', sourceParcelId: nativeId('H001').slice(descriptor.idPrefix.length) } });
        expect(found.features[0].properties.sourceProperties).not.toHaveProperty('owner');
        found.features[0].geometry.coordinates[0][0][0] = 0;
        const exact = await source.queryIds([nativeId('H001'), nativeId('absent'), nativeId('H001')]);
        expect(exact.features).toHaveLength(1);
        expect(exact.features[0].geometry.coordinates[0][0][0]).toBe(135.5);
        expect(exact.absentIds).toEqual([nativeId('absent')]);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it('uses polygon intersection rather than just a footprint bounding box', async () => {
        const triangle = { type: 'Polygon', coordinates: [[[135.5, 34.68], [135.503, 34.68],
            [135.5, 34.683], [135.5, 34.68]]] };
        const source = adapter(collection([feature('inside', square(135.5001, 34.6801)),
            feature('outside', square(135.502, 34.682))]));
        const result = await source.queryGeometry(triangle);
        expect(result.features.map(f => f.id)).toEqual([nativeId('inside')]);
    });
    it('accepts an empty complete snapshot and explicit CRS84', async () => {
        const source = adapter({ ...collection([]), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC::CRS84' } } });
        expect((await source.queryBounds(bounds)).features).toEqual([]);
        expect((await source.queryIds([nativeId('absent')])).absentIds).toEqual([nativeId('absent')]);
    });
    it('pins optional published revision and feature count, rejecting changed or missing revisions', async () => {
        const pinned = { ...descriptor, expectedEtag: '"verified"', expectedSnapshotFeatures: 1 };
        for (const etag of ['"changed"', null]) {
            const source = createGeojsonSnapshotParcelSource(pinned, { fetchImpl: async () => response(collection([feature()]),
                { headers: etag ? { ETag: etag } : {} }) });
            await expect(source.queryBounds(bounds)).rejects.toThrow(/revision/);
        }
        const fetchImpl = async () => response(collection([]), { headers: { ETag: '"verified"' } });
        await expect(createGeojsonSnapshotParcelSource(pinned, { fetchImpl }).queryBounds(bounds)).rejects.toThrow(/count/);
        const good = createGeojsonSnapshotParcelSource(pinned, { fetchImpl: async () => response(collection([feature()]),
            { headers: { ETag: '"verified"' } }) });
        expect((await good.queryBounds(bounds)).features).toHaveLength(1);
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, expectedSnapshotFeatures: -1 })).toThrow();
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, expectedEtag: 'unquoted' })).toThrow();
    });
    it.each([{ exceededTransferLimit: true }, { complete: false }])('rejects explicitly incomplete snapshots', async flags => {
        await expect(adapter({ ...collection([feature()]), ...flags }).queryBounds(bounds)).rejects.toThrow(/incomplete/);
    });
    it.each([null, { type: 'FeatureCollection' }, collection([{ ...feature(), geometry: null }]),
        collection([{ ...feature(), geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } }]),
        collection([{ ...feature(), properties: { city: '27128', sheet: 'map' } }]),
        { ...collection([feature()]), crs: { type: 'name', properties: { name: 'EPSG:3857' } } },
        collection([feature(), feature()]), collection([feature(), feature('H001', square(135.51))])
    ])('rejects an invalid or duplicate source snapshot', async data => {
        await expect(adapter(data).queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
    });
    it('enforces declared byte limits before reading', async () => {
        const fetchImpl = vi.fn(async () => response(collection([]), { headers: { 'Content-Length': '100001' } }));
        await expect(createGeojsonSnapshotParcelSource(descriptor, { fetchImpl }).queryBounds(bounds)).rejects.toThrow(/byte limit/);
    });
    it('enforces actual streamed bytes even without or with a false length header', async () => {
        for (const headers of [{}, { 'Content-Length': '1' }]) {
            const fetchImpl = vi.fn(async () => response(collection([feature()]), { headers }));
            const source = createGeojsonSnapshotParcelSource({ ...descriptor, maxSnapshotBytes: 50 }, { fetchImpl });
            await expect(source.queryBounds(bounds)).rejects.toThrow(/byte limit/);
        }
    });
    it('rejects truncated length, snapshot feature overflow and query feature overflow', async () => {
        const fetchImpl = vi.fn(async () => response(collection([]), { headers: { 'Content-Length': '100' } }));
        await expect(createGeojsonSnapshotParcelSource(descriptor, { fetchImpl }).queryBounds(bounds)).rejects.toThrow(/content length/);
        await expect(adapter(collection([feature('a'), feature('b')]), { maxSnapshotFeatures: 1 }).queryBounds(bounds)).rejects.toThrow(/feature limit/);
        await expect(adapter(collection([feature('a'), feature('b')]), { maxFeatures: 1 }).queryBounds(bounds)).rejects.toThrow(/feature limit/);
    });
    it.each([403, 500, 206])('rejects HTTP %s including partial snapshot responses', async status => {
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl: async () => response(collection([]), { status }) });
        await expect(source.queryBounds(bounds)).rejects.toThrow(`HTTP ${status}`);
    });
    it('rejects invalid client requests before fetching', async () => {
        const fetchImpl = vi.fn(); const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        for (const ids of [[], ['wrong-source'], ['JP-2026-27128~%ZZ~x'], [nativeId('x')].concat(Array(80).fill(nativeId('y')))]) {
            await expect(source.queryIds(ids)).rejects.toMatchObject({ status: 400 });
        }
        expect(() => source.queryBounds([0, 0, 10, 10])).toThrow(/too large/);
        expect(() => source.queryGeometry({ type: 'Point', coordinates: [135.5, 34.68] })).toThrow();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('shares single-flight reads across adapter instances but isolates fetch implementations', async () => {
        let resolveFetch;
        const fetchImpl = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
        const first = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        const second = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        const pending = [first.queryBounds(bounds), second.queryIds([nativeId('H001')])];
        expect(fetchImpl).toHaveBeenCalledOnce(); resolveFetch(response(collection([feature()])));
        await Promise.all(pending);
        const differentFetch = vi.fn(async () => response(collection([])));
        await createGeojsonSnapshotParcelSource(descriptor, { fetchImpl: differentFetch }).queryBounds(bounds);
        expect(differentFetch).toHaveBeenCalledOnce();
    });
    it('expires after five minutes, fails closed on refresh and retries without stale fallback', async () => {
        let clock = 0;
        const fetchImpl = vi.fn().mockImplementationOnce(async () => response(collection([feature()])))
            .mockImplementationOnce(async () => response(collection([]), { status: 503 }))
            .mockImplementationOnce(async () => response(collection([])));
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl, now: () => clock });
        await source.queryBounds(bounds); clock = 299999;
        expect((await source.queryIds([nativeId('H001')])).features).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledOnce(); clock = 300000;
        await expect(source.queryBounds(bounds)).rejects.toThrow('HTTP 503');
        expect((await source.queryIds([nativeId('H001')])).absentIds).toEqual([nativeId('H001')]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
    it('retries invalid JSON and rejects nonpositive configured limits', async () => {
        const fetchImpl = vi.fn().mockImplementationOnce(async () => new Response('invalid JSON'))
            .mockImplementationOnce(async () => response(collection([])));
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        await expect(source.queryBounds(bounds)).rejects.toMatchObject({ status: 502 });
        expect((await source.queryBounds(bounds)).complete).toBe(true);
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, maxSnapshotBytes: 0 })).toThrow();
    });
});

describe('multiple published snapshot resources', () => {
    const resource = (value, west = 135.5) => ({ endpoint: `https://example.org/${value}.geojson`,
        bbox: [west, 34.68, west + .01, 34.69], idNamespace: { field: 'city', value },
        expectedEtag: '"verified"', expectedSnapshotFeatures: 1 });
    const multi = changes => ({ ...descriptor, snapshots: [resource('27128'), resource('13101', 139.5)], ...changes });
    const featureFor = (value, west = 135.5) => ({ ...feature(), properties: { ...feature().properties, city: value }, geometry: square(west) });
    const fetcher = (fail = false) => vi.fn(async url => {
        const city = new URL(url).pathname.slice(1).split('.')[0];
        return city === '13101' && fail ? new Response('unavailable', { status: 503 })
            : response(collection([featureFor(city, city === '13101' ? 139.5 : 135.5)]), { headers: { ETag: '"verified"' } });
    });
    it('selects bounds, footprint and IDs without fetching unrelated failures', async () => {
        const fetchImpl = fetcher(true), source = createGeojsonSnapshotParcelSource(multi(), { fetchImpl });
        expect((await source.queryBounds(bounds)).features[0].id).toBe(nativeId('H001'));
        expect((await source.queryGeometry(square())).features).toHaveLength(1);
        expect((await source.queryIds([nativeId('H001')])).features).toHaveLength(1);
        const unknown = descriptor.idPrefix + encodeSnapshotNativeId(['unknown', 'map', 'id']);
        expect((await source.queryIds([unknown])).absentIds).toEqual([unknown]);
        expect((await source.queryBounds([140, 35, 140.001, 35.001])).features).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledOnce();
        await expect(source.queryBounds([139.5, 34.68, 139.501, 34.681])).rejects.toThrow(/503/);
        const other = descriptor.idPrefix + encodeSnapshotNativeId(['13101', '大阪~中央 / 図1', 'H001']);
        await expect(source.queryIds([nativeId('H001'), other])).rejects.toThrow(/503/);
    });
    it('combines namespaces, validates every ID first and enforces aggregate limits', async () => {
        const fetchImpl = fetcher(), source = createGeojsonSnapshotParcelSource(multi(), { fetchImpl });
        const other = descriptor.idPrefix + encodeSnapshotNativeId(['13101', '大阪~中央 / 図1', 'H001']);
        await expect(source.queryIds([nativeId('H001'), 'bad-prefix'])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect((await source.queryIds([nativeId('H001'), other])).features).toHaveLength(2);
        await expect(source.queryIds(Array(81).fill(other))).rejects.toMatchObject({ status: 400 });
        const capped = createGeojsonSnapshotParcelSource(multi({ maxFeatures: 1 }), { fetchImpl: fetcher() });
        await expect(capped.queryIds([nativeId('H001'), other])).rejects.toThrow(/feature limit/);
    });
    it('rejects foreign native namespaces and polygons outside the declared extent', async () => {
        for (const bad of [featureFor('foreign'), featureFor('27128', 135.52)]) {
            const fetchImpl = async () => response(collection([bad]), { headers: { ETag: '"verified"' } });
            await expect(createGeojsonSnapshotParcelSource(multi(), { fetchImpl }).queryBounds(bounds)).rejects.toThrow(/namespace|extent/);
        }
    });
    it('rejects repeated configuration namespaces/endpoints, invalid namespace fields and extents', () => {
        for (const snapshots of [[resource('27128'), resource('27128', 139.5)],
            [resource('27128'), { ...resource('13101'), endpoint: resource('27128').endpoint }],
            [{ ...resource('27128'), idNamespace: { field: 'notPublished', value: '27128' } }],
            [{ ...resource('27128'), bbox: [135, 35, 134, 34] }]]) {
            expect(() => createGeojsonSnapshotParcelSource(multi({ snapshots }))).toThrow();
        }
    });
});
