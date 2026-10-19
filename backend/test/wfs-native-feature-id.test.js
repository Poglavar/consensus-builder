// Verifies official WFS feature-ID routes, bounded reads, and rejection of transport identities.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { createParcelSource } from '../parcels/sources.js';

const descriptor = {
    adapter: 'wfs', id: 'native-feature-test', endpoint: 'https://provider.example/wfs',
    featureType: 'cad:Parcel', geometryField: 'geom', version: '2.0.0',
    nativeIdMode: 'feature-id', idField: null, idType: 'string', idPrefix: 'TEST-',
    idPattern: '^Parcel\\.[A-Za-z0-9_.:-]+$', outFields: [], requestProperties: true,
    pageSize: 2, idBatchSize: 2, maxFeatures: 10, maxBboxKm2: 1
};
const bounds = [2, 48, 2.001, 48.001];
const geometry = { type: 'Polygon', coordinates: [[[2,48],[2.001,48],[2.001,48.001],[2,48.001],[2,48]]] };
const raw = (id, shape = geometry) => ({ type: 'Feature', id, properties: {}, geometry: shape });
const page = (features, matched = features.length, extra = {}) => new Response(JSON.stringify({
    type: 'FeatureCollection', features, numberMatched: matched, numberReturned: features.length, ...extra
}), { headers: { 'Content-Type': 'application/json' } });
function fixture(responses, override = {}, factory = createWfsParcelSource) {
    const requests = [];
    const adapter = factory({ ...descriptor, ...override }, { fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        assert.ok(responses.length, 'Unexpected extra request');
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response() : response;
    } });
    return { adapter, requests };
}
function assertSafe(request, version = '2.0.0') {
    const p = request.url.searchParams;
    assert.equal(p.get('service'), 'WFS');
    assert.equal(p.get('request'), 'GetFeature');
    assert.equal(p.get('version'), version);
    assert.equal(p.get(version === '2.0.0' ? 'typeNames' : 'typeName'), 'cad:Parcel');
    assert.equal(p.get('propertyName'), 'geom');
    assert.equal(p.get('srsName'), 'CRS:84');
    assert.equal(p.has('sortBy'), false);
    assert.equal(p.has('cql_filter'), false);
    assert.equal(request.options.redirect, 'error');
}

test('production factory supports WFS 2 resourceId with unchanged native encoding and safe properties', async () => {
    const feature = raw('Parcel.abc-1');
    feature.properties = { owner: 'discard', account: 'discard', geom: 'discard' };
    const { adapter, requests } = fixture([page([feature])], {}, createParcelSource);
    const result = await adapter.queryIds(['TEST-Parcel.abc-1', 'TEST-Parcel.absent', 'TEST-Parcel.abc-1']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, ['TEST-Parcel.absent']);
    assert.equal(result.features[0].id, 'TEST-Parcel.abc-1');
    assert.equal(result.features[0].properties.sourceParcelId, 'Parcel.abc-1');
    assert.deepEqual(result.features[0].properties.sourceProperties, {});
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(requests[0].url.searchParams.get('resourceId'), 'Parcel.abc-1,Parcel.absent');
    assert.equal(requests[0].url.searchParams.has('startIndex'), false);
    assertSafe(requests[0]);
});

test('WFS 1.1 uses featureID and totalFeatures; WFS 2 may explicitly select the supported featureID route', async () => {
    for (const override of [{ version: '1.1.0' }, { featureIdParameter: 'featureID' }]) {
        const payload = override.version ? { totalFeatures: 1, numberMatched: undefined, numberReturned: undefined } : {};
        const { adapter, requests } = fixture([page([raw('Parcel.a')], 1, payload)], override);
        const result = await adapter.queryIds(['TEST-Parcel.a']);
        assert.equal(result.features.length, 1);
        assert.equal(requests[0].url.searchParams.get('featureID'), 'Parcel.a');
        assert.equal(requests[0].url.searchParams.has('resourceId'), false);
        assert.equal(requests[0].url.searchParams.get(override.version ? 'maxFeatures' : 'count'), '2');
        assertSafe(requests[0], override.version ?? '2.0.0');
    }
});

test('complete bounds use official ID round trips before publishing every unchanged geometry', async () => {
    const { adapter, requests } = fixture([
        page([raw('Parcel.a'), raw('Parcel.b')], 3), page([raw('Parcel.c')], 3),
        page([raw('Parcel.b'), raw('Parcel.a')]), page([raw('Parcel.c')])
    ]);
    const result = await adapter.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), ['TEST-Parcel.a', 'TEST-Parcel.b', 'TEST-Parcel.c']);
    assert.equal(requests[0].url.searchParams.get('bbox'), '2,48,2.001,48.001,CRS:84');
    assert.equal(requests[1].url.searchParams.get('startIndex'), '2');
    assert.equal(requests[2].url.searchParams.get('resourceId'), 'Parcel.a,Parcel.b');
    assert.equal(requests[3].url.searchParams.get('resourceId'), 'Parcel.c');
    requests.forEach(r => assertSafe(r));
});

test('exact reads page every batch and only publish absence after all batches complete', async () => {
    const { adapter, requests } = fixture([
        page([raw('Parcel.a')], 2), page([raw('Parcel.b')], 2), page([])
    ], { pageSize: 1 });
    const result = await adapter.queryIds(['TEST-Parcel.a', 'TEST-Parcel.b', 'TEST-Parcel.c']);
    assert.deepEqual(result.absentIds, ['TEST-Parcel.c']);
    assert.equal(requests[1].url.searchParams.get('startIndex'), '1');
    assert.equal(requests[2].url.searchParams.get('resourceId'), 'Parcel.c');
    const failing = fixture([page([raw('Parcel.a')]), new Response('', { status: 403 })], { idBatchSize: 1 });
    await assert.rejects(failing.adapter.queryIds(['TEST-Parcel.a', 'TEST-Parcel.b']), { code: 'parcel-source-blocked', upstreamStatus: 403 });
});

test('geometry query verifies bounds before intersecting; source polygons and holes stay unchanged', async () => {
    const shape = { type: 'MultiPolygon', coordinates: [[geometry.coordinates[0], [[2.0001,48.0001],[2.0002,48.0001],[2.0002,48.0002],[2.0001,48.0002],[2.0001,48.0001]]]] };
    const { adapter } = fixture([page([raw('Parcel.a', shape)]), page([raw('Parcel.a', shape)])]);
    const result = await adapter.queryGeometry(geometry);
    assert.deepEqual(result.features[0].geometry, shape);
});

test('identity is independently checked rather than inferred from page position or geometry', async () => {
    for (const witness of [page([]), page([raw('Parcel.a', { ...geometry, coordinates: [[[2,48],[2.0009,48],[2.0009,48.001],[2,48.001],[2,48]]] })])]) {
        const { adapter } = fixture([page([raw('Parcel.a')]), witness]);
        await assert.rejects(adapter.queryBounds(bounds), { code: 'parcel-source-unstable-identity' });
    }
    const changed = fixture([page([raw('Parcel.a')]), page([raw('Parcel.b')])]);
    await assert.rejects(changed.adapter.queryBounds(bounds), /unexpected parcels/);
});

test('GeoTools generated JVM IDs cannot become native parcel identities, even if they repeat', async () => {
    for (const id of ['Parcel.fid--1f3b175f_1a1217fc54e_-647', 'Parcel.fid-1698381a_1a128677d64_7684']) {
        const { adapter } = fixture([page([raw(id)])]);
        await assert.rejects(adapter.queryIds([`TEST-${id}`]), { code: 'parcel-source-unstable-identity' });
        const bounded = fixture([page([raw(id)])], { idPattern: '^Parcel\\.fid--[0-9a-f]+_[0-9a-f]+_-[0-9a-f]+$' });
        await assert.rejects(bounded.adapter.queryBounds(bounds), { code: 'parcel-source-unstable-identity' });
    }
});

test('generated transport IDs cannot be reported absent when the official route would return empty', async () => {
    for (const nativeId of ['Persil.fid--1f3b175f_1a1217fc54e_-647', 'fid-1698381a_1a128677d64_7684']) {
        const { adapter, requests } = fixture([page([])], { idPattern: null });
        await assert.rejects(adapter.queryIds([`TEST-${nativeId}`]), { code: 'parcel-source-unstable-identity' });
        assert.equal(requests.length, 0, 'Generated keys fail before absence can be inferred');
    }
});

test('feature-ID identity witnesses bypass HTTP caches while attribute requests retain their behavior', async () => {
    const feature = raw('Parcel.a');
    const { adapter, requests } = fixture([page([feature]), page([feature])]);
    await adapter.queryBounds(bounds);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.options.cache === 'no-store'));
    const attribute = fixture([page([{ ...feature, properties: { key: 'Parcel.a' } }])], {
        nativeIdMode: undefined, idField: 'key', outFields: ['key']
    });
    await attribute.adapter.queryBounds(bounds);
    assert.equal(attribute.requests[0].options.cache, undefined);
});

test('unsafe, malformed and foreign IDs fail before any request', async () => {
    for (const ids of [[], Array(81).fill('TEST-Parcel.a'), [null], ['FOREIGN-Parcel.a'], ['TEST-Parcel.a,Parcel.b'],
        ['TEST-Parcel.a\n'], ['TEST-Parcel.a\''], ['TEST-Parcel.a&count=1000'], ['TEST-Parcel.a%2Cb']]) {
        const { adapter, requests } = fixture([]);
        await assert.rejects(adapter.queryIds(ids), { status: 400 });
        assert.equal(requests.length, 0);
    }
});

test('mode is explicit, geometry-only, and cannot invent a native attribute or unsafe route', () => {
    for (const override of [{ nativeIdMode: undefined }, { nativeIdMode: 'generated' }, { idField: 'made_up' },
        { idType: 'integer' }, { requestProperties: false }, { outFields: ['owner'] }, { outFields: ['safe'] },
        { geometryField: 'geom,owner' }, { featureIdParameter: 'cql_filter' }, { version: '1.1.0', featureIdParameter: 'resourceId' },
        { pageSize: 0 }, { pageSize: 10001 }, { maxFeatures: 0 }, { maxBboxKm2: NaN }, { maxResponseBytes: 0 }]) {
        assert.throws(() => fixture([], override), /Invalid WFS/);
    }
});

test('missing IDs, malformed geometry, excess and changing counts, repeated pages and truncation fail closed', async () => {
    const cases = [
        [page([raw(undefined)])], [page([raw('Parcel.a', null)])], [page([raw('Parcel.a,Parcel.b')])],
        [page([raw('Parcel.a')], 1, { numberReturned: 0 })], [page([raw('Parcel.a')], 'unknown')],
        [page([raw('Parcel.a')], 11)], [page([raw('Parcel.a'),raw('Parcel.b'),raw('Parcel.c')])],
        [page([raw('Parcel.a')], 2), page([], 2)],
        [page([raw('Parcel.a')], 2), page([raw('Parcel.b')], 3)],
        [page([raw('Parcel.a')], 2), page([raw('Parcel.a')], 2)],
        [new Response(JSON.stringify({ type: 'NotACollection', features: [] }))],
        [new Response('<ExceptionReport>error</ExceptionReport>')]
    ];
    for (const responses of cases) {
        const { adapter } = fixture(responses);
        await assert.rejects(adapter.queryBounds(bounds), { status: 502 });
    }
});

test('upstream denial, throttling, malformed JSON, timeout and byte limits retain gateway error semantics', async () => {
    for (const [response, expected] of [
        [new Response('', { status: 401 }), { code: 'parcel-source-blocked', upstreamStatus: 401 }],
        [new Response('', { status: 429, headers: { 'Retry-After': '12' } }), { code: 'parcel-source-rate-limited', retryAfterSeconds: 12 }],
        [new Response('', { status: 500 }), { code: 'parcel-source-unavailable', upstreamStatus: 500 }],
        [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), { status: 504 }]
    ]) {
        const { adapter } = fixture([response]);
        await assert.rejects(adapter.queryIds(['TEST-Parcel.a']), expected);
    }
    const limited = fixture([page([raw('Parcel.a')])], { maxResponseBytes: 64 });
    await assert.rejects(limited.adapter.queryIds(['TEST-Parcel.a']), /byte limit/);
});

test('complete empty bounds do not invent features; invalid bounds and geometry issue no request', async () => {
    const { adapter, requests } = fixture([page([])]);
    const result = await adapter.queryBounds(bounds);
    assert.deepEqual(result.features, []);
    assert.equal(result.complete, true);
    assert.equal(requests.length, 1);
    assert.throws(() => adapter.queryBounds([2,48,3,49]), { status: 400 });
    await assert.rejects(adapter.queryGeometry({ type: 'Point', coordinates: [2,48] }), { status: 400 });
    assert.equal(requests.length, 1);
});

test('existing attribute-ID mode retains CQL, sorting, paging and safe canonical properties', async () => {
    const attribute = { ...descriptor, nativeIdMode: undefined, idField: 'key', outFields: ['key'] };
    const feature = { ...raw('transport.fid--1_a_-b'), properties: { key: 'Parcel.a' } };
    const { adapter, requests } = fixture([page([feature]), page([feature])], attribute);
    assert.equal((await adapter.queryBounds(bounds)).features[0].properties.sourceParcelId, 'Parcel.a');
    assert.deepEqual((await adapter.queryIds(['TEST-Parcel.a'])).absentIds, []);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.searchParams.get('sortBy'), 'key');
    assert.equal(requests[0].url.searchParams.get('startIndex'), '0');
    assert.equal(requests[0].url.searchParams.get('propertyName'), 'geom,key');
    assert.equal(requests[1].url.searchParams.get('cql_filter'), "key IN ('Parcel.a')");
});
