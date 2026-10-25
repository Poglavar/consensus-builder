import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const firstUid = '3766eec4-ed59-4732-8401-0834fd55838c';
const secondUid = '74dbac59-2326-4415-b5ec-9bfebf2683a4';
const descriptor = {
    id: 'taspro-test', adapter: 'wfs', endpoint: 'https://example.test/wfs',
    featureType: 'taspro:spatial_units', version: '2.0.0',
    idField: 'uid', idType: 'string', idPrefix: 'taspro-test/uid/',
    idPattern: '^[0-9a-f-]{36}$', geometryField: 'geom', outFields: ['uid'],
    requestProperties: true, sortField: 'id', wfsProfile: 'taspro-grid-cache-v1',
    boundsCacheCellSize: 0.004, minRequestIntervalMs: 100, pageSize: 1, idBatchSize: 1
};
const geometry = (x, y) => ({ type: 'MultiPolygon', coordinates: [[[
    [x, y], [x + 0.0002, y], [x + 0.0002, y + 0.0002], [x, y + 0.0002], [x, y]
], [
    [x + 0.00005, y + 0.00005], [x + 0.00005, y + 0.0001],
    [x + 0.0001, y + 0.0001], [x + 0.0001, y + 0.00005], [x + 0.00005, y + 0.00005]
]]] });
const firstGeometry = geometry(32.8042, -5.0273);
const secondGeometry = geometry(32.806, -5.026);
const bounds = [32.8041, -5.0274, 32.8045, -5.027];
const rows = [
    { uid: firstUid, geometry: firstGeometry },
    { uid: secondUid, geometry: secondGeometry }
];

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime} shares complete paged TASPRO regions while exact UUID reads remain live`, async () => {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async url => {
            const params = new URL(url).searchParams;
            requests.push(params);
            assert.equal(params.get('propertyName'), 'geom,uid');
            assert.equal(params.get('sortBy'), 'id');
            const exact = params.has('cql_filter');
            const offset = Number(params.get('startIndex'));
            const row = exact ? rows[0] : rows[offset];
            return new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: exact ? 1 : 2,
                numberReturned: 1, features: [{ type: 'Feature', id: `spatial_units.fid-${requests.length}`,
                    geometry: row.geometry, properties: { uid: row.uid, area_unit_name: 'sqm', legal_area: 400 } }] }));
        } });
        const [one, two] = await Promise.all([source.queryBounds(bounds), source.queryBounds(bounds)]);
        assert.equal(requests.length, 2, 'both viewport requests share the same two complete provider pages');
        assert.equal(requests[0].get('bbox'), '32.804,-5.028,32.808,-5.024,CRS:84');
        assert.deepEqual(requests.map(params => params.get('startIndex')), ['0', '1']);
        assert.deepEqual(one, two);
        assert.deepEqual(one.features.map(feature => feature.id), [descriptor.idPrefix + firstUid]);
        assert.deepEqual(one.features[0].geometry, firstGeometry, 'rings and holes remain unchanged');
        assert.deepEqual(one.features[0].properties.sourceProperties, { uid: firstUid });
        await source.queryIds([descriptor.idPrefix + firstUid]);
        await source.queryIds([descriptor.idPrefix + firstUid]);
        assert.equal(requests.length, 4, 'independent exact reads bypass the region cache');
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(source.queryBounds(bounds, { signal: aborted.signal }), { name: 'AbortError' });
        assert.equal(requests.length, 4);
    });
}

test('failed or incomplete TASPRO regions are evicted and cannot become complete absence', async () => {
    let calls = 0;
    const source = createWfsParcelSource(descriptor, { fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: calls === 1 ? 1 : 0,
            numberReturned: 0, features: [] }));
    } });
    await assert.rejects(source.queryBounds(bounds), /incomplete pagination/);
    const result = await source.queryBounds(bounds);
    assert.equal(calls, 2);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
});

test('TASPRO profile validates safe fields, bounded cache size and provider serialization', () => {
    for (const change of [{ boundsCacheCellSize: 0.05 }, { outFields: ['uid', 'label'] },
        { sortField: 'uid' }, { minRequestIntervalMs: undefined }]) {
        assert.throws(() => createWfsParcelSource({ ...descriptor, ...change }), /Invalid TASPRO/);
    }
});
