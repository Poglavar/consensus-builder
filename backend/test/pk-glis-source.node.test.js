import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
const prefix = 'pk-balochistan-glis-quetta-khasra:';
const uidPrefix = '20-01-31-570-0365-';
const descriptor = { id: 'pk-balochistan-glis-khasra-parcels', adapter: 'pk-glis',
    endpoint: 'https://api.ssbacha.net/api/parcels/filtered', idPrefix: prefix,
    idField: 'khasra_uid', outFields: ['khasra_uid'], maxResponseBytes: 4096,
    scopes: [{ district: 'Quetta', tehsil: 'Quetta City', mauza: 'Ward-9', uidPrefix,
        extent: [66.99, 30.17, 67.00, 30.19] }] };
const native = (number = '105') => ({ type: 'Feature', properties: { khasra_uid: uidPrefix + number,
    Unrequested: 'discarded' }, geometry: { type: 'MultiPolygon', coordinates: [[[
    [66.993, 30.178], [66.994, 30.178], [66.994, 30.179], [66.993, 30.179], [66.993, 30.178]
]]] } });
const response = rows => new Response(JSON.stringify({ success: true,
    data: { type: 'FeatureCollection', features: rows }, count: rows.length }));
function source(rows = [native()], calls = []) {
    return createParcelSource(descriptor, { fetchImpl: async (url, options) => {
        assert.equal(url, descriptor.endpoint);
        const body = JSON.parse(options.body);
        assert.deepEqual(body.outFields, ['khasra_uid']);
        assert.equal(body.district, 'Quetta'); assert.equal(body.mauza, 'Ward-9');
        calls.push(body);
        return response(typeof rows === 'function' ? rows(body) : rows);
    } });
}
test('both factories use fresh exact native-ID reads and preserve polygons without unsolicited properties', async () => {
    assert.equal(typeof browserParcelFactories['pk-glis'], 'function');
    const calls = [], adapter = source([native()], calls), id = prefix + uidPrefix + '105';
    const first = await adapter.queryIds([id]);
    const second = await adapter.queryIds([id]);
    assert.equal(first.complete, true); assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first, second); assert.equal(calls.length, 2);
    assert.equal(calls[0].khasra, '105');
    assert.deepEqual(first.features[0].geometry, native().geometry);
    assert.deepEqual(first.features[0].properties.sourceProperties, { khasra_uid: uidPrefix + '105' });
    assert.equal(JSON.stringify(first).includes('discarded'), false);
});
test('map reads cache bounded mauzas and mark partial city coverage explicitly', async () => {
    const calls = [], adapter = source([native()], calls);
    const bounds = [66.9925, 30.1775, 66.9945, 30.1795];
    const first = await adapter.queryBounds(bounds);
    const second = await adapter.queryGeometry(native().geometry);
    assert.equal(first.features.length, 1); assert.equal(second.features.length, 1);
    assert.equal(first.areaComplete, false); assert.equal(first.authoritativeAbsence, false);
    assert.equal(calls.length, 1);
    first.features[0].geometry.coordinates[0][0][0][0] = 0;
    assert.deepEqual((await adapter.queryBounds(bounds)).features[0].geometry, native().geometry);
    const outside = await adapter.queryBounds([67.01, 30.17, 67.011, 30.171]);
    assert.equal(outside.features.length, 0); assert.equal(outside.areaComplete, false);
});
test('validate all requested IDs before fetching, and never invent absence', async () => {
    const calls = [], adapter = source([], calls);
    for (const ids of [[], ['foreign'], [prefix + '../x'], [prefix + '20-01-31-570-9999-105']]) {
        await assert.rejects(adapter.queryIds(ids), { status: 400 });
    }
    assert.equal(calls.length, 0);
    const missing = await adapter.queryIds([prefix + uidPrefix + '99999']);
    assert.equal(missing.complete, false); assert.deepEqual(missing.absentIds, []);
});
test('reject wrong exact IDs, duplicates, incomplete counts and malformed polygons', async () => {
    const id = prefix + uidPrefix + '105';
    for (const rows of [[native('106')], [native(), native()], [{ ...native(), geometry: null }]]) {
        await assert.rejects(source(rows).queryIds([id]), { status: 502 });
    }
    const adapter = createParcelSource(descriptor, { fetchImpl: async () => new Response(JSON.stringify({
        success: true, count: 2, data: { type: 'FeatureCollection', features: [native()] }
    })) });
    await assert.rejects(adapter.queryIds([id]), { status: 502 });
});
test('cancel a chunked response at actual byte cap, regardless of Content-Length', async () => {
    let cancelled = false;
    const adapter = createParcelSource(descriptor, { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(3000)); },
        cancel() { cancelled = true; }
    }), { headers: { 'Content-Length': '1' } }) });
    await assert.rejects(adapter.queryIds([prefix + uidPrefix + '105']), /actual byte cap/);
    assert.equal(cancelled, true);
});
test('unsafe descriptors cannot broaden endpoint, field selection or response budgets', () => {
    for (const extra of [{ endpoint: 'https://example.org/' }, { outFields: ['khasra_uid', 'Unrequested'] },
        { maxResponseBytes: 16777217 }, { scopes: [] }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...extra }), /descriptor/);
    }
});
