// Exercise Explore pagination, exact identity, unchanged geometry and both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpendatasoftParcelSource } from '../parcels/opendatasoft-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: 'ods-test', adapter: 'opendatasoft',
    endpoint: 'https://provider.example/api/explore/v2.1/catalog/datasets/parcels/records',
    idField: 'site_id', idType: 'string', idPrefix: 'TEST-', geometryField: 'geom',
    outFields: ['site_id'], pageSize: 2, maxFeatures: 10 };
const bounds = [-123.04, 49.24, -123.03, 49.25];
const polygon = { type: 'Polygon', coordinates: [
    [[-123.039, 49.241], [-123.035, 49.241], [-123.035, 49.245], [-123.039, 49.245], [-123.039, 49.241]],
    [[-123.038, 49.242], [-123.038, 49.243], [-123.037, 49.243], [-123.037, 49.242], [-123.038, 49.242]]
] };
const row = (site_id, geometry = polygon) => ({ site_id, geom: { type: 'Feature', geometry, properties: {} } });
const page = (total_count, results = []) => ({ total_count, results });
function fixture(entries) {
    const calls = [];
    return { calls, fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        assert.ok(entries.length, 'unexpected extra request');
        const body = entries.shift();
        return new Response(JSON.stringify(body), { status: body.status ?? 200 });
    } };
}

test('counts every ordered page, preserves complete Polygon/MultiPolygon rings and requests only safe fields', async () => {
    const multi = { type: 'MultiPolygon', coordinates: [polygon.coordinates] };
    const f = fixture([page(3, [row('001'), row('EPS123')]), page(3, [row('003', multi)]), page(3)]);
    const result = await createOpendatasoftParcelSource(descriptor, f).queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), ['TEST-001', 'TEST-EPS123', 'TEST-003']);
    assert.deepEqual(result.features[0].geometry, polygon);
    assert.deepEqual(result.features[2].geometry, multi);
    assert.deepEqual(result.features[0].properties.sourceProperties, { site_id: '001' });
    assert.deepEqual(f.calls.map(c => c.url.searchParams.get('offset')), ['0', '2', '0']);
    assert.deepEqual(f.calls.map(c => c.url.searchParams.get('limit')), ['2', '2', '0']);
    for (const call of f.calls) {
        assert.equal(call.url.searchParams.get('select'), 'site_id,geom');
        assert.equal(call.url.searchParams.get('order_by'), 'site_id');
        assert.equal(call.url.searchParams.get('where'), 'in_bbox(geom,49.24,-123.04,49.25,-123.03)');
        assert.equal(call.options.redirect, 'error');
    }
});

test('independent exact reads preserve leading zeroes and alphanumeric keys, with explicit absence', async () => {
    for (const factory of [createParcelSource, browserParcelFactories.opendatasoft]) {
        const f = fixture([page(2, [row('001'), row('EPS123')]), page(2), page(2, [row('001'), row('EPS123')]), page(2)]);
        const adapter = factory(descriptor, f);
        const ids = ['TEST-001', 'TEST-EPS123', 'TEST-999'];
        const one = await adapter.queryIds(ids), two = await adapter.queryIds(ids);
        assert.deepEqual(one, two);
        assert.deepEqual(one.absentIds, ['TEST-999']);
        assert.equal(one.features[0].properties.sourceParcelId, '001');
        assert.equal(f.calls[0].url.searchParams.get('where'), "site_id in ('001','EPS123','999')");
    }
});

test('requires stable counts even for an empty exact query', async () => {
    const f = fixture([page(0), page(0)]);
    assert.deepEqual((await createOpendatasoftParcelSource(descriptor, f).queryIds(['TEST-999'])).absentIds, ['TEST-999']);
    assert.equal(f.calls.length, 2);
});

for (const [name, entries] of [
    ['early end', [page(2, [row('001')]), page(2)]],
    ['changed page count', [page(3, [row('001'), row('002')]), page(2, [row('003')])]],
    ['changed final count', [page(1, [row('001')]), page(2)]],
    ['duplicate key', [page(2, [row('001'), row('001')])]],
    ['conflicting key', [page(2, [row('001'), row('001', { type: 'MultiPolygon', coordinates: [polygon.coordinates] })])]],
    ['blank key', [page(1, [row('')])]], ['null key', [page(1, [row(null)])]],
    ['numeric key', [page(1, [row(1)])]],
    ['nonpolygon', [page(1, [row('001', { type: 'Point', coordinates: [-123.03, 49.24] })])]],
    ['overflow', [page(11)]], ['string count', [page('1')]], ['missing count', [{ results: [] }]],
    ['invalid response', [{ error: 'unavailable' }]], ['throttled', [{ status: 429 }]]
]) test(`fails explicitly for ${name}`, async () => {
    await assert.rejects(createOpendatasoftParcelSource(descriptor, fixture(entries)).queryBounds(bounds));
});

test('rejects foreign IDs, injection, invalid bounds and unsafe descriptor fields before fetching', async () => {
    const f = fixture([]), adapter = createOpendatasoftParcelSource(descriptor, f);
    for (const id of ['OTHER-001', "TEST-001') or true", 'TEST-', 1]) await assert.rejects(adapter.queryIds([id]));
    assert.throws(() => adapter.queryBounds([49.24, -123.04, 49.25, -123.03]));
    assert.throws(() => createOpendatasoftParcelSource({ ...descriptor, outFields: ['site_id', 'extra'] }, f));
    assert.equal(f.calls.length, 0);
});

test('geometry queries filter intersections without clipping returned parcels', async () => {
    const f = fixture([page(1, [row('001')]), page(1)]);
    const result = await createOpendatasoftParcelSource(descriptor, f).queryGeometry(polygon);
    assert.deepEqual(result.features[0].geometry, polygon);
});

test('caps actual streamed bytes and cancels an oversized body despite a small Content-Length', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; }
    }), { headers: { 'Content-Length': '1' } });
    const adapter = createOpendatasoftParcelSource(descriptor, { fetchImpl: async () => response });
    await assert.rejects(adapter.queryBounds(bounds), /exceeds the byte limit/);
    assert.equal(cancelled, true);
});

test('decodes streamed JSON across UTF-8 and chunk boundaries without changing polygons', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ ...page(1, [row('001')]), note: 'é' }));
    const split = encoded.findIndex(byte => byte === 0xc3) + 1;
    const streamed = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
    } }));
    const responses = [streamed, new Response(JSON.stringify(page(1)))];
    const result = await createOpendatasoftParcelSource(descriptor, { fetchImpl: async () => responses.shift() }).queryBounds(bounds);
    assert.deepEqual(result.features[0].geometry, polygon);
});
