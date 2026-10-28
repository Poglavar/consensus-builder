import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiyarbakirParcelSource, createDiyarbakirBrowserSource, DIYARBAKIR_SOURCE_ID, DIYARBAKIR_ENDPOINT } from '../parcels/diyarbakir-eimar-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: DIYARBAKIR_SOURCE_ID, adapter: 'diyarbakir-eimar', endpoint: DIYARBAKIR_ENDPOINT,
    idPrefix: 'TR-DBB-', idField: 'OBJECTID', parcelNumberField: 'OBJECTID', outFields: ['OBJECTID'],
    capabilities: { areaEnumeration: false }, browserTransport: 'relay', maxFeatures: 20 };
const geometry = { type: 'Polygon', coordinates: [[[40, 38], [40.001, 38], [40.001, 38.001], [40, 38]]] };
const id = 'TR-DBB-123';
function fakeProvider({ mismatch = false, expire = false, empty = false, areaRows } = {}) {
    const calls = []; let viewers = 0, reads = 0;
    const fetchImpl = async (input, init) => {
        const url = new URL(input); calls.push({ url, init });
        if (url.pathname === '/imardurumu/') {
            viewers++;
            return new Response('viewer', { headers: { 'set-cookie': `svc_nonce=anonymous${viewers}; path=/; Secure` } });
        }
        assert.equal(url.origin + url.pathname, DIYARBAKIR_ENDPOINT);
        if (url.searchParams.get('type') === 'adaparsel') {
            assert.equal(url.searchParams.get('adaparsel'), '/');
            assert.equal(url.searchParams.get('tamKelimeAra'), '1');
            assert.equal(url.searchParams.get('tmahalle'), '456');
            assert.equal(new Headers(init.headers).get('x-service-nonce'), `anonymous${viewers}`);
            return Response.json(areaRows);
        }
        assert.equal(url.searchParams.get('type'), 'parsel');
        assert.equal(url.searchParams.get('parselid'), '123');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('cookie'), `svc_nonce=anonymous${viewers}`);
        assert.equal(headers.get('x-service-nonce'), `anonymous${viewers}`);
        reads++;
        if (expire && reads === 1) return new Response('', { status: 403 });
        return Response.json(empty ? [] : [{ OBJECTID: mismatch ? 124 : 123, POLY: JSON.stringify(geometry),
            UNRELATED: 'not retained' }]);
    };
    return { fetchImpl, calls };
}
test('backend factory re-reads exact native IDs and retains only the allowlist without changing geometry', async () => {
    const provider = fakeProvider(), adapter = createParcelSource(descriptor, provider);
    const a = await adapter.queryIds([id]), b = await adapter.queryIds([id]);
    assert.deepEqual(a, b);
    assert.equal(provider.calls.length, 3); // one viewer, two fresh parcel reads
    assert.deepEqual(a.features[0].geometry, geometry);
    assert.deepEqual(a.features[0].properties.sourceProperties, { OBJECTID: '123' });
    assert.deepEqual(a.absentIds, []);
});
test('expired public nonce refreshes the viewer exactly once', async () => {
    const provider = fakeProvider({ expire: true });
    const result = await createDiyarbakirParcelSource(descriptor, provider).queryIds([id]);
    assert.equal(result.features.length, 1);
    assert.equal(provider.calls.length, 4);
});
test('foreign native ID, duplicate inputs and missing nonce fail closed', async () => {
    await assert.rejects(createDiyarbakirParcelSource(descriptor, fakeProvider({ mismatch: true })).queryIds([id]), /native parcel ID/);
    const p = fakeProvider(), a = createDiyarbakirParcelSource(descriptor, p);
    await assert.rejects(a.queryIds([id, id]), /distinct/);
    await assert.rejects(a.queryIds(['TR-TKGM-123']), /native/);
    assert.equal(p.calls.length, 0);
    await assert.rejects(createDiyarbakirParcelSource(descriptor, { fetchImpl: async () => new Response('viewer') }).queryIds([id]), /nonce/);
});
test('explicit empty exact result and unsupported area query have distinct semantics', async () => {
    const provider = fakeProvider({ empty: true }), a = createDiyarbakirParcelSource(descriptor, provider);
    assert.deepEqual((await a.queryIds([id])).absentIds, [id]);
    const before = provider.calls.length;
    await assert.rejects(a.queryBounds([40, 38, 40.001, 38.001]), { code: 'parcel-source-area-unsupported' });
    assert.equal(provider.calls.length, before);
    const browser = createDiyarbakirBrowserSource(descriptor, { fetchImpl: async () => assert.fail('Unsupported browser area read must not fetch or use saved samples.') });
    await assert.rejects(browser.queryBounds([40, 38, 40.001, 38.001]), { code: 'parcel-source-area-unsupported' });
    await assert.rejects(browser.queryGeometry(geometry), { code: 'parcel-source-area-unsupported' });
});
test('oversized streamed parcel response is rejected and cancelled', async () => {
    let cancelled = false;
    const a = createDiyarbakirParcelSource(descriptor, { fetchImpl: async url => String(url).endsWith('/imardurumu/')
        ? new Response('', { headers: { 'set-cookie': 'svc_nonce=anonymous' } })
        : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } })) });
    await assert.rejects(a.queryIds([id]), /byte limit/);
    assert.equal(cancelled, true);
});
test('browser factory uses fixed-source relay; public nonce stays on the server', async () => {
    assert.equal(browserParcelFactories['diyarbakir-eimar'], createDiyarbakirBrowserSource);
    const provider = fakeProvider();
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api', fetchImpl: async (url, init) => {
        assert.equal(url, `https://app.example/api/parcel-provider-relay/${descriptor.id}`);
        const checked = validateParcelProviderRelayRequest(descriptor.id, JSON.parse(init.body), { sources: [descriptor] });
        return fetchParcelProviderRelay(checked, { providerFetch: provider.fetchImpl });
    } });
    const a = createDiyarbakirBrowserSource(descriptor, { fetchImpl });
    const result = await a.queryIds([id]);
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(result.features[0].id, id);
    assert.ok(!JSON.stringify(result).includes('anonymous'));
});
test('relay rejects URLs, headers and operations outside the registered exact source', () => {
    const request = { url: DIYARBAKIR_ENDPOINT, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _dbbOperation: 'queryIds', input: [id] }) };
    assert.doesNotThrow(() => validateParcelProviderRelayRequest(descriptor.id, request, { sources: [descriptor] }));
    for (const changed of [{ url: 'https://cbs.diyarbakir.bel.tr/Netgis7/ncwebgisservice.asmx' },
        { headers: { 'content-type': 'application/json', cookie: 'injected' } },
        { body: JSON.stringify({ _dbbOperation: 'arbitrary', input: [] }) },
        { url: DIYARBAKIR_ENDPOINT + '?type=ozelnot' }]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...request, ...changed }, { sources: [descriptor] }));
    }
});

const spatialDescriptor = { ...descriptor, maxFeatures: 2000, capabilities: { areaEnumeration: true },
    spatialScopes: [{ tapuMahalleId: '456', name: 'CADASTRAL TEST', bbox: [39.99, 37.99, 40.01, 38.01] }] };
const areaRow = (id, boundary = geometry) => ({ OBJECTID: id, POLY: JSON.stringify(boundary), TAPU_MAH_ADI: 'CADASTRAL TEST' });
test('live neighborhood search discovers non-sample native IDs, filters bounds and preserves holes and multipart', async () => {
    const hole = [[40.0001, 38.0001], [40.0003, 38.0001], [40.0002, 38.0002], [40.0001, 38.0001]];
    const withHole = { type: 'Polygon', coordinates: [...geometry.coordinates, hole] };
    const multipart = { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
    const outside = { type: 'Polygon', coordinates: [[[41, 38], [41.001, 38], [41, 38.001], [41, 38]]] };
    const provider = fakeProvider({ areaRows: [areaRow(321, withHole), areaRow(322, multipart), areaRow(323, outside)] });
    const source = createParcelSource(spatialDescriptor, provider);
    const result = await source.queryBounds([40, 38, 40.001, 38.001]);
    assert.deepEqual(result.features.map(f => f.id), ['TR-DBB-321', 'TR-DBB-322']);
    assert.deepEqual(result.features.map(f => f.geometry), [withHole, multipart]);
    assert.deepEqual(result.features[0].properties.sourceProperties, { OBJECTID: '321' });
    assert.equal(result.coverage.citywideCompleteness, false);
    assert.deepEqual(result.coverage.neighborhoodIds, ['456']);
    const before = provider.calls.length;
    const noScope = await source.queryBounds([40.1, 38.1, 40.101, 38.101]);
    assert.deepEqual(noScope.features, []);
    assert.equal(provider.calls.length, before);
    assert.deepEqual((await source.queryGeometry(geometry)).features.map(f => f.id), ['TR-DBB-321', 'TR-DBB-322']);
});
test('neighborhood filter mismatch and conflicting duplicate native IDs fail closed', async () => {
    await assert.rejects(createParcelSource(spatialDescriptor, fakeProvider({ areaRows: [
        { ...areaRow(321), TAPU_MAH_ADI: 'OTHER' }
    ] })).queryBounds([40, 38, 40.001, 38.001]), /neighborhood filter/);
    const different = structuredClone(geometry); different.coordinates[0][1][0] += 0.001;
    await assert.rejects(createParcelSource(spatialDescriptor, fakeProvider({ areaRows: [
        areaRow(321), areaRow(321, different)
    ] })).queryBounds([40, 38, 40.001, 38.001]), /conflicting native/);
    // A viewport filter must not hide a conflicting ID elsewhere in the same response.
    await assert.rejects(createParcelSource(spatialDescriptor, fakeProvider({ areaRows: [
        areaRow(321), areaRow(321, different)
    ] })).queryBounds([39.995, 37.995, 39.996, 37.996]), /conflicting native/);
    assert.throws(() => createParcelSource({ ...spatialDescriptor, spatialScopes: [] }), /scopes/);
});
test('browser viewport search traverses the registered fixed-source relay and fetches live neighborhood polygons', async () => {
    const provider = fakeProvider({ areaRows: [areaRow(321)] });
    const fetchImpl = createBrowserProviderFetch(spatialDescriptor, { relayBase: 'https://app.example/api', fetchImpl: async (_url, init) => {
        const checked = validateParcelProviderRelayRequest(descriptor.id, JSON.parse(init.body), { sources: [spatialDescriptor] });
        return fetchParcelProviderRelay(checked, { providerFetch: provider.fetchImpl });
    } });
    const result = await createDiyarbakirBrowserSource(spatialDescriptor, { fetchImpl }).queryBounds([40, 38, 40.001, 38.001]);
    assert.equal(result.features[0].id, 'TR-DBB-321');
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(provider.calls.length, 2);
});
