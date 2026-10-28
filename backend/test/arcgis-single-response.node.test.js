// Verifies count-checked bounded ArcGIS queries without unsupported pagination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    id: 'test-bounded-parcels', endpoint: 'https://example.test/MapServer/0',
    idField: 'GLOBALID', objectIdField: 'GLOBALID', idType: 'string', idPrefix: 'TEST-',
    outFields: ['GLOBALID'], boundsQueryMode: 'single-response', idsQueryMode: 'single-response',
    pageSize: 2, maxFeatures: 2
};
const rows = ['{A}', '{B}'].map((id, i) => ({ type: 'Feature', properties: { GLOBALID: id },
    geometry: { type: 'Polygon', coordinates: [[[49 + i / 1000, 25], [49.0001 + i / 1000, 25],
        [49.0001 + i / 1000, 25.0001], [49 + i / 1000, 25]]] } }));
function provider({ count = 2, features = rows, exceededTransferLimit } = {}) {
    const calls = [];
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async input => {
        const params = new URL(input).searchParams;
        calls.push(params);
        for (const key of ['resultOffset', 'resultRecordCount', 'orderByFields']) assert.equal(params.has(key), false);
        assert.equal(params.get('outFields'), 'GLOBALID');
        const body = params.has('returnCountOnly') ? { count } :
            { type: 'FeatureCollection', features: structuredClone(features), exceededTransferLimit };
        return { ok: true, json: async () => body };
    } });
    return { source, calls };
}
test('single response supports a full page without limit flag and preserves native geometry', async () => {
    const { source, calls } = provider();
    const result = await source.queryIds(['TEST-{A}', 'TEST-{B}']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, []);
    assert.deepEqual(result.features.map(f => f.geometry), rows.map(f => f.geometry));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].get('returnGeometry'), 'false');
    assert.equal(calls[1].get('returnGeometry'), 'true');
});
test('bounded spatial read retains the same filter for count and geometry', async () => {
    const { source, calls } = provider();
    await source.queryBounds([49, 25, 49.002, 25.002]);
    for (const key of ['where', 'geometry', 'geometryType', 'inSR', 'spatialRel']) {
        assert.equal(calls[0].get(key), calls[1].get(key));
    }
});
test('truncation and false count agreement cannot mark parcels complete', async () => {
    for (const options of [{ count: 2, features: rows.slice(0, 1) }, { exceededTransferLimit: true }]) {
        await assert.rejects(provider(options).source.queryIds(['TEST-{A}', 'TEST-{B}']), /incomplete bounded response/);
    }
});
test('over-budget count stops before geometry download', async () => {
    const { source, calls } = provider({ count: 3 });
    await assert.rejects(source.queryBounds([49, 25, 49.002, 25.002]), /bounded response limit/);
    assert.equal(calls.length, 1);
});
test('duplicate native identities fail instead of dropping a source polygon', async () => {
    await assert.rejects(provider({ features: [rows[0], rows[0]] }).source.queryIds(['TEST-{A}']), /repeated or omitted an object ID/);
});
test('a count-verified empty response proves exact absence', async () => {
    const result = await provider({ count: 0, features: [] }).source.queryIds(['TEST-{A}']);
    assert.deepEqual(result.absentIds, ['TEST-{A}']);
    assert.equal(result.complete, true);
});
