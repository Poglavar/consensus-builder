// Verify streamed response budgets for WFS attribute IDs in backend and browser factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'taspro-budget-test', adapter: 'wfs', endpoint: 'https://example.test/wfs',
    featureType: 'taspro:qualified_spatial_units', version: '2.0.0',
    idField: 'uid', idType: 'string', idPrefix: 'taspro-budget-test/uid/',
    sortField: 'id', geometryField: 'geom', outFields: ['uid'], requestProperties: true,
    maxResponseBytes: 4096
};
const uid = 'ab1f6225-e004-4143-9a1c-8519e0d7d4a7';
const geometry = { type: 'MultiPolygon', coordinates: [[[
    [32.654, -2.655], [32.655, -2.655], [32.655, -2.654], [32.654, -2.655]
]]] };

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime} retains UUID and full geometry through independently capped exact reads`, async () => {
        let reads = 0;
        const source = factory(descriptor, { fetchImpl: async url => {
            const params = new URL(url).searchParams;
            assert.equal(params.get('propertyName'), 'geom,uid');
            assert.equal(params.get('sortBy'), 'id');
            assert.equal(params.get('srsName'), 'CRS:84');
            assert.equal(params.get('cql_filter'), `uid IN ('${uid}')`);
            return new Response(JSON.stringify({ type: 'FeatureCollection', numberMatched: 1,
                numberReturned: 1, features: [{ type: 'Feature', id: `qualified_spatial_units.fid-${++reads}`,
                    properties: { uid }, geometry }] }));
        } });
        const first = await source.queryIds([descriptor.idPrefix + uid]);
        const second = await source.queryIds([descriptor.idPrefix + uid]);
        assert.equal(reads, 2);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features, second.features);
        assert.equal(first.features[0].id, descriptor.idPrefix + uid);
        assert.deepEqual(first.features[0].geometry, geometry);
    });

    test(`${runtime} cancels over-budget chunks despite an understated Content-Length`, async () => {
        let cancelled = false;
        const source = factory({ ...descriptor, maxResponseBytes: 64 }, { fetchImpl: async () =>
            new Response(new ReadableStream({
                pull(controller) { controller.enqueue(new Uint8Array(40).fill(32)); },
                cancel() { cancelled = true; }
            }), { headers: { 'Content-Length': '1' } }) });
        await assert.rejects(source.queryIds([descriptor.idPrefix + uid]), /exceeded the response byte limit/);
        assert.equal(cancelled, true);
    });
}

test('attribute-ID WFS rejects invalid explicit byte budgets', () => {
    for (const maxResponseBytes of [0, -1, NaN, 1.5, 21 * 1024 * 1024]) {
        assert.throws(() => createWfsParcelSource({ ...descriptor, maxResponseBytes }), /Invalid WFS parcel source limits/);
    }
});
