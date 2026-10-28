import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFlatgeobufRangeParcelSource } from '../parcels/flatgeobuf-range-source.js';
import { readFlatgeobufHeader, flatgeobufLevels } from '../parcels/flatgeobuf-reader.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

// Synthetic GDAL-generated, multi-level indexed file. Native IDs deliberately collide;
// first two geometries coincide and every polygon has a hole. Final row is another city.
const bytes = readFileSync(new URL('./fixtures/flatgeobuf-range.fgb', import.meta.url));
const headerLength = bytes.readUInt32LE(8), header = bytes.subarray(12, 12 + headerLength);
const d = { id: 'fixture-fgb', adapter: 'flatgeobuf-range', idPrefix: 'fixture-fgb/',
    endpoint: 'https://example.test/parcels.fgb', outFields: ['筆ID', '市区町村コード'],
    sourceSrid: 4326, municipalityCode: '44201', expectedEtag: '"fixed"',
    expectedSnapshotBytes: bytes.length, expectedSnapshotFeatures: 40,
    expectedHeaderSha256: sha256Hex(header), maxFeatures: 100, maxBboxKm2: 25 };
function transport(modify = r => r) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        assert.equal(String(url), d.endpoint);
        const headers = new Headers(init.headers), match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));
        assert.ok(match); assert.equal(headers.get('if-match'), d.expectedEtag);
        const [start, end] = match.slice(1).map(Number); assert.ok(end < bytes.length);
        requests.push([start, end]);
        return modify(new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
            etag: d.expectedEtag, 'content-range': `bytes ${start}-${end}/${bytes.length}` } }));
    };
    return { fetchImpl, requests };
}
const all = [131.62999, 33.21999, 131.635, 33.22009];
test('spatial ranges preserve holes, coincident rows, and safe fields; fresh exact reads match', async () => {
    const mock = transport(), a = createParcelSource(d, mock), result = await a.queryBounds(all);
    assert.equal(result.complete, true); assert.equal(result.features.length, 39);
    assert.equal(new Set(result.features.map(f => f.id)).size, 39);
    const groups = new Map();
    for (const f of result.features) {
        assert.equal(f.geometry.type, 'MultiPolygon'); assert.equal(f.geometry.coordinates[0].length, 2);
        assert.deepEqual(Object.keys(f.properties.sourceProperties).sort(), ['市区町村コード', '筆ID']);
        const key = JSON.stringify(f.geometry); groups.set(key, [...(groups.get(key) || []), f]);
    }
    const coincident = [...groups.values()].find(rows => rows.length === 2);
    assert.ok(coincident); assert.notEqual(coincident[0].id, coincident[1].id);
    assert.ok(mock.requests.every(([start, end]) => end - start < 65536));
    const fresh = transport(), exact = await createFlatgeobufRangeParcelSource(d, fresh).queryIds(coincident.map(f => f.id));
    assert.deepEqual(exact.features, coincident); assert.deepEqual(exact.absentIds, []);
    assert.equal(fresh.requests.length, 6); // independent header + two size/record pairs
    const badHash = coincident[0].id.slice(0, -64) + '0'.repeat(64);
    assert.deepEqual((await a.queryIds([badHash])).absentIds, [badHash]);
});
test('bounded spatial query does not read the whole feature section', async () => {
    const mock = transport(), result = await createFlatgeobufRangeParcelSource(d, mock).queryBounds([131.63, 33.22, 131.63001, 33.22001]);
    assert.equal(result.features.length, 2);
    assert.ok(result.statistics.downloadedBytes < bytes.length / 2);
});
test('range/revision/truncation failures never produce complete parcel results', async () => {
    for (const modify of [
        r => new Response(r.body, { status: 200, headers: r.headers }),
        r => { r.headers.set('etag', '"changed"'); return r; },
        r => { r.headers.set('content-range', 'bytes 0-11/10'); return r; },
        () => new Response(new Uint8Array(2), { status: 206, headers: { etag: '"fixed"', 'content-range': `bytes 0-11/${bytes.length}` } })
    ]) await assert.rejects(createFlatgeobufRangeParcelSource(d, transport(modify)).queryBounds(all));
    await assert.rejects(createFlatgeobufRangeParcelSource({ ...d, expectedHeaderSha256: '0'.repeat(64) }, transport()).queryBounds(all));
    await assert.rejects(createFlatgeobufRangeParcelSource(d, transport()).queryIds(['foreign/id']), { status: 400 });
    await assert.rejects(createFlatgeobufRangeParcelSource({ ...d, maxFeatures: 1 }, transport()).queryBounds(all));
});
test('checked header and tree sizes; malformed inputs fail', () => {
    assert.equal(readFlatgeobufHeader(header).crs, 4326);
    assert.deepEqual(flatgeobufLevels(40, 16), [{ start: 0, end: 1 }, { start: 1, end: 4 }, { start: 4, end: 44 }]);
    assert.throws(() => flatgeobufLevels(0, 16)); assert.throws(() => readFlatgeobufHeader(new Uint8Array(4)));
});
test('browser factory uses the registered safe live range relay', async () => {
    const mock = transport();
    const browser = browserParcelFactories['flatgeobuf-range'](d, { fetchImpl: async (url, init) => {
        const request = validateParcelProviderRelayRequest(d.id, { url: String(url), method: init.method,
            headers: Object.fromEntries(new Headers(init.headers)), body: init.body }, { sources: [d] });
        return fetchParcelProviderRelay(request, { providerFetch: mock.fetchImpl });
    } });
    const result = await browser.queryBounds([131.63, 33.22, 131.63001, 33.22001]);
    assert.equal(result.features.length, 2); assert.equal(result.complete, true);
    const exact = await browser.queryIds(result.features.map(f => f.id));
    assert.deepEqual(exact.features, result.features);
});
