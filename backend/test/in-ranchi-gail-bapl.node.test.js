// Exercise Ranchi's query-bound Esri JSON source through backend and browser factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';

const { descriptor, response } = JSON.parse(readFileSync(new URL('./fixtures/in-ranchi-gail-bapl.json', import.meta.url)));
const ids = response.features.map(row => descriptor.idPrefix + row.attributes.OBJECTID);

function provider({ ignoreOffset = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async input => {
        const url = new URL(input), params = url.searchParams;
        calls.push(url);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.equal(params.get('f'), 'json');
        let data;
        {
            assert.equal(params.get('outFields'), 'OBJECTID');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnTrueCurves'), 'true');
            assert.equal(params.has('geometryPrecision'), false);
            assert.equal(params.get('orderByFields'), 'OBJECTID');
            const start = ignoreOffset ? 0 : Number(params.get('resultOffset'));
            const limit = Number(params.get('resultRecordCount'));
            data = { ...response, features: response.features.slice(start, start + limit),
                exceededTransferLimit: start + limit < response.features.length };
        }
        return { ok: true, status: 200, json: async () => structuredClone(data) };
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`Ranchi ${name} preserves native polygons and exact IDs with singleton offset pages`, async () => {
        const transport = provider();
        const source = factory({ ...descriptor, pageSize: 1 }, transport);
        const viewport = await source.queryBounds([85.368, 23.356, 85.374, 23.359]);
        const first = await source.queryIds(ids);
        const second = await factory({ ...descriptor, pageSize: 1 }, transport).queryIds(ids);
        assert.equal(viewport.complete, true);
        assert.deepEqual(first.features, viewport.features);
        assert.deepEqual(second, first);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => row.id), ids);
        for (const [index, feature] of first.features.entries()) {
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: response.features[index].geometry.rings });
            assert.deepEqual(feature.properties.sourceProperties, response.features[index].attributes);
        }
        assert.deepEqual(transport.calls.map(url => url.searchParams.get('resultOffset')), ['0', '1', '2', '0', '1', '2', '0', '1', '2']);
    });
}

test('Ranchi rejects a server ignoring offsets instead of publishing partial parcels', async () => {
    await assert.rejects(createParcelSource({ ...descriptor, pageSize: 1 }, provider({ ignoreOffset: true })).queryIds(ids), /object ID|object IDs/);
});

test('Ranchi browser configuration uses the fixed-source relay for live provider reads', async () => {
    const urls = [];
    const upstream = provider();
    const fetchImpl = createBrowserProviderFetch(descriptor, {
        relayBase: 'https://app.example/api',
        fetchImpl: async (url, options) => {
            urls.push(url);
            assert.equal(options.method, 'POST');
            assert.equal(options.credentials, 'omit');
            const request = JSON.parse(options.body);
            const response = await upstream.fetchImpl(request.url);
            return new Response(JSON.stringify(await response.json()), { headers: { 'content-type': 'application/json' } });
        }
    });
    const result = await browserParcelFactories.arcgis(descriptor, { fetchImpl }).queryIds(ids);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.id), ids);
    assert.deepEqual(urls, [`https://app.example/api/parcel-provider-relay/${descriptor.id}`]);
});
