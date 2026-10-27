// Sivas shares Netcad's public nonce protocol across backend and browser relay operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { createParcelSource } from '../parcels/sources.js';
import { SIVAS_SOURCE_ID, SIVAS_ENDPOINT, createMersinBrowserSource } from '../parcels/mersin-eimar-source.js';
import { createBrowserProviderFetch, browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

for (const kind of ['headers', 'pairs']) {
    test(`Sivas verified HTTPS preserves nonce headers from Fetch ${kind}`, async () => {
        const extraCa = readFileSync(new URL('../parcels/certificates/sectigo-public-server-authentication-ca-dv-r36.pem', import.meta.url), 'utf8');
        const response = Readable.from([Buffer.from('[]')]);
        response.statusCode = 200;
        let requestOptions;
        const fetchJson = createHttpsJsonFetch(extraCa, { getImpl(url, options, callback) {
            assert.equal(url, SIVAS_ENDPOINT);
            requestOptions = options;
            const request = new EventEmitter();
            queueMicrotask(() => callback(response));
            return request;
        } });
        try {
            const pairs = [['Cookie', 'svc_nonce=anonymous'], ['X-Service-Nonce', 'anonymous']];
            const result = await fetchJson(SIVAS_ENDPOINT, { headers: kind === 'headers' ? new Headers(pairs) : pairs });
            assert.deepEqual(requestOptions.headers, { cookie: 'svc_nonce=anonymous', 'x-service-nonce': 'anonymous' });
            assert.equal(requestOptions.agent.options.rejectUnauthorized, true);
            assert.deepEqual(requestOptions.agent.options.ca, [...rootCertificates, extraCa]);
            assert.deepEqual(await result.json(), []);
        } finally { requestOptions?.agent.destroy(); }
    });
}

const prefix = SIVAS_SOURCE_ID + ':OBJECTID=';
const descriptor = { id: SIVAS_SOURCE_ID, adapter: 'mersin-eimar', endpoint: SIVAS_ENDPOINT,
    idPrefix: prefix, idField: 'OBJECTID', outFields: ['OBJECTID'], parcelNumberField: 'OBJECTID',
    browserTransport: 'relay', capabilities: { areaEnumeration: true }, maxFeatures: 999,
    spatialScopes: [{ block: '6424', bbox: [37.04, 39.74, 37.05, 39.75] }] };
const polygon = { type: 'Polygon', coordinates: [[[37.046, 39.742], [37.047, 39.742], [37.047, 39.743], [37.046, 39.742]]] };
const row = (id, label) => ({ OBJECTID: id, ADAPARSEL: label, POLY: JSON.stringify(polygon), UNRELATED: 'discard' });
function provider() {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input); calls.push(url);
        if (url.href === 'https://keos.sivas.bel.tr/imardurumu/') {
            return new Response('', { headers: { 'set-cookie': 'svc_nonce=anonymous; Secure; path=/' } });
        }
        assert.equal(url.origin + url.pathname, SIVAS_ENDPOINT);
        const headers = new Headers(init.headers);
        assert.equal(headers.get('cookie'), 'svc_nonce=anonymous');
        assert.equal(headers.get('x-service-nonce'), 'anonymous');
        if (url.searchParams.get('type') === 'parsel') return Response.json([row(Number(url.searchParams.get('parselid')), '6424/3')]);
        assert.equal(url.searchParams.get('adaparsel'), '6424/');
        // The provider's similar-text query must not admit other cadastral blocks.
        return new Response(JSON.stringify([row(99144, '6424/3'), row(7, '16424/3')]), { headers: { 'content-type': 'text/html' } });
    } };
}
test('Sivas backend repeats exact native IDs and filters substring block matches without altering POLY', async () => {
    const p = provider(), source = createParcelSource(descriptor, p);
    const first = await source.queryIds([prefix + '99144']);
    assert.deepEqual(await source.queryIds([prefix + '99144']), first);
    const bounds = await source.queryBounds([37.045, 39.741, 37.048, 39.744]);
    assert.deepEqual(bounds.features.map(f => f.id), [prefix + '99144']);
    assert.deepEqual(bounds.features[0].geometry, polygon);
    assert.deepEqual(bounds.features[0].properties.sourceProperties, { OBJECTID: '99144' });
    assert.equal(JSON.stringify(bounds).includes('UNRELATED'), false);
    assert.equal(bounds.coverage.citywideCompleteness, false);
    assert.equal(p.calls.filter(url => url.pathname === '/imardurumu/').length, 1);
});
test('Sivas browser registration exercises live bounds and exact-ID operations through the pinned relay', async () => {
    assert.equal(browserParcelFactories[descriptor.adapter], createMersinBrowserSource);
    const p = provider();
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api', fetchImpl: async (_url, init) => {
        const request = validateParcelProviderRelayRequest(descriptor.id, JSON.parse(init.body), { sources: [descriptor] });
        return fetchParcelProviderRelay(request, { providerFetch: p.fetchImpl });
    } });
    const source = createMersinBrowserSource(descriptor, { fetchImpl });
    assert.equal((await source.queryBounds([37.045, 39.741, 37.048, 39.744])).features.length, 1);
    assert.deepEqual((await source.queryIds([prefix + '99144'])).features[0].geometry, polygon);
    const request = { url: SIVAS_ENDPOINT, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _mersinOperation: 'queryIds', input: [prefix + '99144'] }) };
    for (const change of [{ url: SIVAS_ENDPOINT + '?type=parsel' }, { headers: { 'content-type': 'application/json', cookie: 'injected' } }]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...request, ...change }, { sources: [descriptor] }));
    }
});
