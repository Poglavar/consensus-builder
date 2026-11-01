// Gaziantep's pinned Netcad profile must work through both production factories and the browser relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { SEHITKAMIL_SOURCE_ID as id, SEHITKAMIL_ENDPOINT as endpoint } from '../parcels/mersin-eimar-source.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const prefix = id + ':OBJECTID=';
const descriptor = { id, endpoint, adapter: 'mersin-eimar', idPrefix: prefix, idField: 'OBJECTID',
    parcelNumberField: 'OBJECTID', outFields: ['OBJECTID'], browserTransport: 'relay',
    capabilities: { areaEnumeration: true }, maxFeatures: 999,
    spatialScopes: [{ block: '4707', bbox: [37.420953, 37.056678, 37.422922, 37.058448] }] };
const geometry = { type: 'Polygon', coordinates: [[[37.421, 37.057], [37.422, 37.057], [37.422, 37.058], [37.421, 37.057]]] };
const row = (native, block = '4707') => ({ OBJECTID: native, ADAPARSEL: block + '/11', POLY: JSON.stringify(geometry), UNRELATED: 'discard' });
function provider() {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input); calls.push(url);
        if (url.href === 'https://keos.sehitkamil.bel.tr/imardurumu/index.aspx') {
            return new Response('', { headers: { 'set-cookie': 'svc_nonce=anonymous; Secure; path=/' } });
        }
        assert.equal(url.origin + url.pathname, endpoint);
        assert.equal(new Headers(init.headers).get('x-service-nonce'), 'anonymous');
        assert.equal(new Headers(init.headers).get('cookie'), 'svc_nonce=anonymous');
        if (url.searchParams.get('type') === 'parsel') return Response.json([row(Number(url.searchParams.get('parselid')))]);
        assert.equal(url.searchParams.get('adaparsel'), '4707/');
        assert.equal(url.searchParams.get('tamKelimeAra'), '1');
        return Response.json([row(1566189), row(1553860), row(9, '14707')]);
    } };
}
test('Gaziantep backend preserves exact geometry and finds live nonsample IDs within its configured block', async () => {
    const p = provider(), source = createParcelSource(descriptor, p);
    const first = await source.queryIds([prefix + '1566189']);
    assert.deepEqual(await source.queryIds([prefix + '1566189']), first);
    const result = await source.queryBounds([37.421, 37.057, 37.422, 37.058]);
    assert.deepEqual(result.features.map(f => f.id), [prefix + '1566189', prefix + '1553860']);
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.deepEqual(result.features[0].properties.sourceProperties, { OBJECTID: '1566189' });
    assert.equal(JSON.stringify(result).includes('UNRELATED'), false);
    assert.equal(result.coverage.citywideCompleteness, false);
    const before = p.calls.length;
    assert.deepEqual((await source.queryBounds([37.37, 37.05, 37.38, 37.06])).features, []);
    assert.equal(p.calls.length, before);
});
test('Gaziantep browser factory and server relay perform bounds and repeated exact operations', async () => {
    const p = provider();
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api', fetchImpl: async (_url, init) => {
        const request = validateParcelProviderRelayRequest(id, JSON.parse(init.body), { sources: [descriptor] });
        return fetchParcelProviderRelay(request, { providerFetch: p.fetchImpl });
    } });
    const source = browserParcelFactories[descriptor.adapter](descriptor, { fetchImpl });
    assert.equal((await source.queryBounds([37.421, 37.057, 37.422, 37.058])).features.length, 2);
    const first = await source.queryIds([prefix + '1566189']);
    assert.deepEqual(await source.queryIds([prefix + '1566189']), first);
    assert.deepEqual(first.features[0].geometry, geometry);
});
test('Gaziantep profile rejects an altered endpoint, source identity and injected browser cookie', () => {
    assert.throws(() => createParcelSource({ ...descriptor, endpoint: endpoint + '?extra=1' }), /descriptor/);
    assert.throws(() => createParcelSource({ ...descriptor, id: 'other' }), /descriptor/);
    assert.throws(() => validateParcelProviderRelayRequest(id, { url: endpoint, method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'injected' },
        body: JSON.stringify({ _mersinOperation: 'queryIds', input: [prefix + '1566189'] }) }, { sources: [descriptor] }));
});
