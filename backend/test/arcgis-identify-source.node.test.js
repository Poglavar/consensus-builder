// Exercise identify filtering, source geometry preservation, safety limits and both factories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const native = '{98911A16-0947-4469-9C30-5286E2721879}';
const other = '{00000000-0000-0000-0000-000000000000}';
const descriptor = {
    id: 'test-identify', adapter: 'arcgis', endpoint: 'https://example.org/rest/services/Parcels/MapServer/0',
    queryMode: 'identify', idField: 'globalid', idPrefix: 'test:globalid=', outFields: ['globalid'],
    parcelNumberField: 'globalid', identifyExtent: [36, 37, 38, 39], identifyRecordLimit: 2000, maxBboxKm2: 0.1
};
const bounds = [36.91, 37.58, 36.911, 37.581];
const rings = [
    [[36.91,37.58],[36.91,37.581],[36.911,37.581],[36.911,37.58],[36.91,37.58]],
    [[36.9102,37.5802],[36.9108,37.5802],[36.9108,37.5808],[36.9102,37.5808],[36.9102,37.5802]]
];
const row = { layerId: 0, geometryType: 'esriGeometryPolygon', attributes: { globalid: native, owner: 'discard' },
    geometry: { spatialReference: { wkid: 4326 }, rings } };
const response = payload => new Response(JSON.stringify(payload));

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name} selects identify mode, filters exact GUIDs on every read and preserves the hole`, async () => {
        const calls = [];
        const source = factory(descriptor, { fetchImpl: async url => {
            const parsed = new URL(url); calls.push(parsed);
            assert.ok(parsed.pathname.endsWith('/MapServer/identify'));
            assert.equal(parsed.searchParams.get('geometryPrecision'), null);
            assert.equal(parsed.searchParams.get('outFields'), 'globalid');
            assert.equal(parsed.searchParams.get('tolerance'), '0');
            return response({ results: [row] });
        } });
        const id = descriptor.idPrefix + native;
        const first = await source.queryIds([id]);
        const second = await source.queryIds([id]);
        assert.equal(calls.length, 2);
        assert.deepEqual(JSON.parse(calls[0].searchParams.get('layerDefs')), { 0: `globalid = '${native}'` });
        assert.equal(calls[0].searchParams.get('geometry'), descriptor.identifyExtent.join(','));
        assert.deepEqual(first, second);
        assert.deepEqual(first.features[0].geometry, { type: 'Polygon', coordinates: rings });
        assert.deepEqual(first.features[0].properties.sourceProperties, { globalid: native });
        assert.equal(first.features[0].id, id);
        const viewport = await source.queryBounds(bounds);
        assert.equal(calls.at(-1).searchParams.get('geometry'), bounds.join(','));
        assert.equal(calls.at(-1).searchParams.get('layerDefs'), null);
        assert.equal(viewport.complete, true);
        assert.equal(viewport.features.length, 1);
    });
}

test('rejects ignored ID filters, duplicate IDs, foreign layers, bad CRS and truncation', async () => {
    for (const payload of [
        { results: [{ ...row, attributes: { globalid: other } }] },
        { results: [row, row] },
        { results: [{ ...row, layerId: 1 }] },
        { results: [{ ...row, geometry: { ...row.geometry, spatialReference: { wkid: 3857 } } }] },
        { results: [row], exceededTransferLimit: true },
        { error: { code: 400 } }, {}
    ]) {
        const source = createParcelSource(descriptor, { fetchImpl: async () => response(payload) });
        await assert.rejects(source.queryIds([descriptor.idPrefix + native]));
    }
    const capped = createParcelSource({ ...descriptor, identifyRecordLimit: 2 }, {
        fetchImpl: async () => response({ results: [row, { ...row, attributes: { globalid: other } }] })
    });
    await assert.rejects(capped.queryBounds(bounds), { code: 'parcel-source-incomplete' });
});

test('absence requires a successful filtered read; malformed IDs never reach the provider', async () => {
    let calls = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async () => { calls++; return response({ results: [] }); } });
    const id = descriptor.idPrefix + other;
    assert.deepEqual((await source.queryIds([id])).absentIds, [id]);
    await assert.rejects(source.queryIds([descriptor.idPrefix + "' OR 1=1"]), { status: 400 });
    assert.equal(calls, 1);
    await assert.rejects(source.queryBounds([36,37,38,39]), { status: 400 });
});

test('enforces actual streamed response byte limits without relying on Content-Length', async () => {
    const source = createParcelSource(descriptor, { fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) });
    await assert.rejects(source.queryBounds(bounds), /byte limit/);
});

test('relay permits only the identify operation derived from the configured layer', () => {
    const options = { sources: [descriptor] };
    assert.ok(validateParcelProviderRelayRequest(descriptor.id,
        { url: 'https://example.org/rest/services/Parcels/MapServer/identify?f=json' }, options));
    for (const url of ['https://example.org/rest/services/Other/MapServer/identify',
        'https://example.org/rest/services/Parcels/MapServer/export']) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url }, options));
    }
});
