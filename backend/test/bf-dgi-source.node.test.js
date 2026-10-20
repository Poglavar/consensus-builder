// Tests native-key DGI reads, unchanged geometry, safe attributes and honest incomplete coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';

const west = [-4.34, 11.175, -4.334, 11.181];
const east = [-4.248, 11.18, -4.242, 11.186];
const descriptor = { id: 'bf-dgi-ecadastre-public-geojson', adapter: 'bf-dgi-geojson',
    endpoint: 'https://ecadastre.dgi.bf/api/locations/geojson', idField: 'FID',
    idPrefix: 'BF-ECADASTRE:', outFields: ['FID'], lookupBounds: [west, east], maxBboxKm2: 2 };
const parcel = (id = 'NativeA', x = -4.339, y = 11.176) => ({ type: 'Feature', id,
    properties: { FID: id, NAME: 'unselected label', DONE: true, OK: false },
    geometry: { type: 'MultiPolygon', coordinates: [[[[x, y], [x + 0.0001, y],
        [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]]] } });
const collection = features => ({ type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features });
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
function source(data, calls = [], config = descriptor) {
    return createParcelSource(config, { fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push(url);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.equal(url.searchParams.get('type'), 'PLOT');
        assert.deepEqual([...url.searchParams.keys()], ['minX', 'minY', 'maxX', 'maxY', 'type']);
        assert.equal(init.redirect, 'error');
        return response(typeof data === 'function' ? data(url, calls.length) : data);
    } });
}

test('factory reads exact native IDs across declared windows with no prior bounds read', async () => {
    const a = parcel(), b = parcel('NativeB', -4.247, 11.181), calls = [];
    const data = url => collection(url.searchParams.get('minX') === String(west[0]) ? [a] : [b]);
    const adapter = source(data, calls);
    const result = await adapter.queryIds(['BF-ECADASTRE:NativeB', 'BF-ECADASTRE:NativeA']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, []);
    assert.deepEqual(result.features.map(f => f.properties.sourceParcelId), ['NativeA', 'NativeB']);
    assert.deepEqual(result.features[0].geometry, a.geometry);
    assert.deepEqual(result.features[0].properties.sourceProperties, { FID: 'NativeA' });
    assert.equal(JSON.stringify(result).includes('unselected label'), false);
    await adapter.queryIds(['BF-ECADASTRE:NativeA']);
    await source(data, calls).queryIds(['BF-ECADASTRE:NativeA']);
    assert.equal(calls.length, 6, 'same and fresh instances must fetch every lookup window again');
});

test('bounds and geometry queries preserve full polygons while declining area completeness', async () => {
    const row = parcel(), adapter = source(collection([row]));
    const bounds = await adapter.queryBounds([-4.33895, 11.17602, -4.3389, 11.17607]);
    assert.equal(bounds.complete, false);
    assert.deepEqual(bounds.features[0].geometry, row.geometry);
    const geometry = await adapter.queryGeometry(row.geometry);
    assert.equal(geometry.complete, false);
    assert.equal(geometry.features.length, 1);
});

test('missing native IDs remain unresolved instead of claiming authoritative absence', async () => {
    const result = await source(collection([])).queryIds(['BF-ECADASTRE:Missing']);
    assert.equal(result.complete, false);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, []);
});

test('rejects invalid requests and unsupported scope before network traffic', async () => {
    const calls = [], adapter = source(collection([]), calls);
    for (const ids of [[], ['FOREIGN:NativeA'], ['BF-ECADASTRE:../x'], ['BF-ECADASTRE:']]) {
        await assert.rejects(() => adapter.queryIds(ids), { status: 400 });
    }
    await assert.rejects(() => adapter.queryBounds([-4.4, 11.1, -4.399, 11.101]), { status: 400 });
    assert.equal(calls.length, 0);
    assert.throws(() => source(collection([]), [], { ...descriptor, outFields: ['FID', 'NAME'] }), /descriptor/);
    assert.throws(() => source(collection([]), [], { ...descriptor, endpoint: 'https://example.org/' }), /descriptor/);
});

test('rejects native ID disagreement, duplicate IDs, invalid geometry and unexpected CRS', async () => {
    const mismatch = parcel(); mismatch.properties.FID = 'Other';
    const invalid = parcel(); invalid.geometry.coordinates[0][0].pop();
    const wrongPlace = parcel('Outside', 0, 0);
    const wrongCrs = collection([parcel()]); wrongCrs.crs.properties.name = 'EPSG:32630';
    for (const data of [collection([mismatch]), collection([parcel(), parcel()]),
        collection([invalid]), collection([wrongPlace]), wrongCrs, { features: [] }]) {
        await assert.rejects(() => source(data).queryBounds(west), { status: 502 });
    }
});

test('a response at the apparent ceiling never becomes a complete area result', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => parcel(`Native${index}`));
    const result = await source(collection(rows)).queryBounds(west);
    assert.equal(result.features.length, 1000);
    assert.equal(result.apparentCeilingReached, true);
    assert.equal(result.complete, false);
});

test('propagates provider HTTP access errors without treating them as empty geometry', async () => {
    const adapter = createParcelSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(() => adapter.queryIds(['BF-ECADASTRE:NativeA']),
        { code: 'parcel-source-blocked', upstreamStatus: 403 });
});

test('enforces response byte limits', async () => {
    const adapter = source(collection([parcel()]), [], { ...descriptor, maxResponseBytes: 1024 });
    const big = parcel(); big.properties.NAME = 'x'.repeat(2000);
    await assert.rejects(() => source(collection([big]), [], { ...descriptor, maxResponseBytes: 1024 }).queryBounds(west),
        { status: 502 });
    assert.equal((await adapter.queryBounds(west)).features.length, 1);
});
