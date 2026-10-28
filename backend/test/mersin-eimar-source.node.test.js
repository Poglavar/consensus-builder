// Verify unchanged Netcad parcel reads, bounded block discovery and the fixed-source browser relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { createMersinBrowserSource, MERSIN_ENDPOINT, MERSIN_SOURCE_ID } from '../parcels/mersin-eimar-source.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const prefix = `${MERSIN_SOURCE_ID}:OBJECTID=`;
const descriptor = { id: MERSIN_SOURCE_ID, adapter: 'mersin-eimar', endpoint: MERSIN_ENDPOINT,
    idPrefix: prefix, idField: 'OBJECTID', parcelNumberField: 'OBJECTID', outFields: ['OBJECTID'],
    capabilities: { areaEnumeration: true }, browserTransport: 'relay', maxFeatures: 999,
    spatialScopes: [{ block: '10690', bbox: [34.55, 36.8, 34.57, 36.82] }] };
const geometry = { type: 'Polygon', coordinates: [[[34.56, 36.81], [34.561, 36.81], [34.561, 36.811], [34.56, 36.81]]] };
const row = (id, key = '10690/4', poly = geometry) => ({ OBJECTID: id, POLY: JSON.stringify(poly), ADAPARSEL: key,
    UNRELATED: 'discard this field' });
function provider({ rows = [row(123), row(124)], exact = [row(123)], expire = false } = {}) {
    const calls = []; let sessions = 0, reads = 0;
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input); calls.push({ url, init });
        if (url.pathname === '/imardurumu/index.aspx') {
            sessions++;
            return new Response('', { headers: { 'set-cookie': `svc_nonce=public${sessions}; Secure; path=/` } });
        }
        assert.equal(url.origin + url.pathname, MERSIN_ENDPOINT);
        const headers = new Headers(init.headers);
        assert.equal(headers.get('cookie'), `svc_nonce=public${sessions}`);
        assert.equal(headers.get('x-service-nonce'), `public${sessions}`);
        reads++;
        if (expire && reads === 1) return new Response('', { status: 403 });
        if (url.searchParams.get('type') === 'parsel') return Response.json(exact);
        assert.equal(url.searchParams.get('type'), 'adaparsel');
        assert.equal(url.searchParams.get('adaparsel'), '10690/');
        assert.equal(url.searchParams.get('tamKelimeAra'), '1');
        return Response.json(rows);
    } };
}
test('factory repeats native exact reads without changing geometry or exposing attributes', async () => {
    const p = provider(), adapter = createParcelSource(descriptor, p);
    const a = await adapter.queryIds([prefix + '123']), b = await adapter.queryIds([prefix + '123']);
    assert.deepEqual(a, b);
    assert.equal(p.calls.length, 3);
    assert.deepEqual(a.features[0].geometry, geometry);
    assert.deepEqual(a.features[0].properties.sourceProperties, { OBJECTID: '123' });
    assert.equal(a.features[0].id, prefix + '123');
    assert.equal(a.coverage.citywideCompleteness, false);
});
test('bounded live block enumeration discovers nonsample IDs and discards substring block matches', async () => {
    const multipart = { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
    const p = provider({ rows: [row(123), row(124, '10690/7', multipart), row(125, '110690/3')] });
    const a = createParcelSource(descriptor, p);
    const result = await a.queryBounds([34.5599, 36.8099, 34.5611, 36.8111]);
    assert.deepEqual(result.features.map(f => f.id), [prefix + '123', prefix + '124']);
    assert.deepEqual(result.features[1].geometry, multipart);
    assert.equal(result.coverage.scope, 'configured-cadastral-blocks');
    const before = p.calls.length;
    assert.deepEqual((await a.queryBounds([34.6, 36.8, 34.601, 36.801])).features, []);
    assert.equal(p.calls.length, before);
});
test('capped searches, conflicting native rows and incorrect exact IDs fail closed', async () => {
    await assert.rejects(createParcelSource(descriptor, provider({ rows: Array.from({ length: 1000 }, () => row(123)) }))
        .queryBounds([34.56, 36.81, 34.561, 36.811]), /transfer cap/);
    const changed = structuredClone(geometry); changed.coordinates[0][1][0] += 0.001;
    await assert.rejects(createParcelSource(descriptor, provider({ rows: [row(123), row(123, '10690/4', changed)] }))
        .queryBounds([34.56, 36.81, 34.561, 36.811]), /conflicting/);
    await assert.rejects(createParcelSource(descriptor, provider({ exact: [row(999)] })).queryIds([prefix + '123']), /native parcel ID/);
    await assert.rejects(createParcelSource(descriptor, provider()).queryIds(['OTHER-123']), /native/);
});
test('empty exact result is explicit absence; a public nonce can be refreshed once', async () => {
    assert.deepEqual((await createParcelSource(descriptor, provider({ exact: [] })).queryIds([prefix + '123'])).absentIds, [prefix + '123']);
    const p = provider({ expire: true });
    assert.equal((await createParcelSource(descriptor, p).queryIds([prefix + '123'])).features.length, 1);
    assert.equal(p.calls.length, 4);
});
test('browser factory fetches live bounds and exact polygons through pinned server operations', async () => {
    assert.equal(browserParcelFactories['mersin-eimar'], createMersinBrowserSource);
    const p = provider();
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api', fetchImpl: async (_url, init) => {
        const checked = validateParcelProviderRelayRequest(descriptor.id, JSON.parse(init.body), { sources: [descriptor] });
        return fetchParcelProviderRelay(checked, { providerFetch: p.fetchImpl });
    } });
    const browser = createMersinBrowserSource(descriptor, { fetchImpl });
    const bounds = await browser.queryBounds([34.56, 36.81, 34.561, 36.811]);
    assert.equal(bounds.features.length, 2);
    const exact = await browser.queryIds([prefix + '123']);
    assert.deepEqual(exact.features[0].geometry, geometry);
    assert.equal(JSON.stringify(exact).includes('public1'), false);
});
test('relay rejects injected upstream URL, cookies and unknown operations', () => {
    const request = { url: MERSIN_ENDPOINT, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _mersinOperation: 'queryIds', input: [prefix + '123'] }) };
    assert.doesNotThrow(() => validateParcelProviderRelayRequest(descriptor.id, request, { sources: [descriptor] }));
    for (const change of [{ url: MERSIN_ENDPOINT + '?type=parsel' }, { url: 'https://keos.yenisehir.bel.tr/netgis7/ncwebgisservice.asmx' },
        { headers: { 'content-type': 'application/json', cookie: 'injected' } },
        { body: JSON.stringify({ _mersinOperation: 'unknown', input: [] }) }]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...request, ...change }, { sources: [descriptor] }));
    }
});
test('oversized streamed response is cancelled rather than retained', async () => {
    let cancelled = false;
    const adapter = createParcelSource(descriptor, { fetchImpl: async url => String(url).endsWith('index.aspx')
        ? new Response('', { headers: { 'set-cookie': 'svc_nonce=public' } })
        : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } })) });
    await assert.rejects(adapter.queryIds([prefix + '123']), /byte limit/);
    assert.equal(cancelled, true);
});
