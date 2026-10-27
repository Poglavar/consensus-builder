// Sandakan's geometry-only WFS 1.1 route must work in both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { fetchMylandWfs, isMylandWfsSource } from '../parcels/myland-wfs-fetch.js';
import { createMylandWfsSource } from '../parcels/myland-wfs-source.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = {
    id: 'my-sabah-myland-lot-ml12', adapter: 'wfs',
    endpoint: 'https://myland.gov.my/geoserver/ml12/wfs',
    version: '1.1.0', featureType: 'ml12:lot', geometryField: 'geom',
    nativeIdMode: 'feature-id', featureIdParameter: 'featureID',
    idField: null, idType: 'string', idPattern: '^lot\\.[0-9]+$',
    idPrefix: 'my-sabah-myland-lot-ml12-', outFields: [], requestProperties: true,
    responseSrid: 4326, pageSize: 100, idBatchSize: 80,
    maxFeatures: 3000, maxBboxKm2: 25, maxResponseBytes: 8388608,
    timeoutMs: 45000, browserTransport: 'relay'
};
// Synthetic coordinates exercise transport; no provider sample is duplicated here.
const geometry = { type: 'Polygon', coordinates: [
    [[118.073, 5.866], [118.074, 5.866], [118.074, 5.867], [118.073, 5.866]]
] };
const raw = (id, shape = geometry) => ({ type: 'Feature', id, properties: {}, geometry: shape });
const canonicalId = id => descriptor.idPrefix + id;
const page = (features, totalFeatures = features.length) => new Response(JSON.stringify({
    type: 'FeatureCollection', totalFeatures, features,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } }
}));

function fixture(factory, responses, overrides = {}) {
    const requests = [];
    const source = factory({ ...descriptor, ...overrides }, { fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        assert.ok(responses.length, 'Unexpected provider request');
        return responses.shift();
    } });
    return { source, requests };
}

function assertSafe({ url, options }) {
    assert.equal(url.origin + url.pathname, descriptor.endpoint);
    const params = url.searchParams;
    assert.equal(params.get('version'), '1.1.0');
    assert.equal(params.get('request'), 'GetFeature');
    assert.equal(params.get('typeName'), 'ml12:lot');
    assert.equal(params.get('propertyName'), 'geom');
    assert.equal(params.get('srsName'), 'EPSG:4326');
    for (const key of ['cql_filter', 'sortBy', 'resourceId']) assert.equal(params.has(key), false);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
}

test('MyLand browser exact reads use the relay without waiting on a direct connection', async () => {
    const requests = [];
    const fetchImpl = createBrowserProviderFetch(descriptor, {
        relayBase: 'https://app.test/api',
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            assert.equal(url, `https://app.test/api/parcel-provider-relay/${descriptor.id}`);
            assert.equal(options.method, 'POST');
            assert.equal(options.credentials, 'omit');
            const envelope = JSON.parse(options.body);
            assertSafe({ url: new URL(envelope.url), options: { cache: 'no-store', redirect: envelope.redirect } });
            assert.equal(new URL(envelope.url).searchParams.get('featureID'), 'lot.49');
            return page([raw('lot.49')]);
        }
    });
    const source = browserParcelFactories.wfs(descriptor, { fetchImpl });
    const first = await source.queryIds([canonicalId('lot.49')]);
    const second = await source.queryIds([canonicalId('lot.49')]);
    assert.equal(requests.length, 2);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features[0].geometry, geometry);
    assert.deepEqual(first.features, second.features);
});

test('MyLand backend uses a scoped connection pool within the WFS deadline and preserves the observing fetch', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let observed = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async (url, options) => {
        observed++;
        assertSafe({ url: new URL(url), options });
        assert.ok(options.dispatcher, 'Backend transport must use the scoped MyLand dispatcher');
        assert.equal(options.credentials, 'omit');
        return page([raw('lot.49')]);
    } });
    assert.deepEqual((await source.queryIds([canonicalId('lot.49')])).features[0].geometry, geometry);
    assert.equal(observed, 1);
    await fetchMylandWfs(`${descriptor.endpoint}?propertyName=geom`, { signal }, { fetchImpl: async (_url, options) => {
        assert.equal(options.signal.aborted, false);
        controller.abort();
        assert.equal(options.signal.aborted, true);
        return page([]);
    } });
    assert.equal(isMylandWfsSource(descriptor), true);
    assert.equal(isMylandWfsSource({ ...descriptor, id: 'other' }), false);
    assert.equal(isMylandWfsSource({ ...descriptor, endpoint: 'https://example.test/wfs' }), false);
    for (const url of ['https://example.test/wfs?propertyName=geom', `${descriptor.endpoint}?propertyName=all`,
        `${descriptor.endpoint}?propertyName=geom&propertyName=all`]) {
        await assert.rejects(fetchMylandWfs(url), { status: 400 });
    }
});

test('MyLand retries transient pre-response failures, but never HTTP denials or caller cancellation', async () => {
    const url = `${descriptor.endpoint}?propertyName=geom`;
    let calls = 0;
    const response = await fetchMylandWfs(url, {}, { fetchImpl: async () => {
        if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        return page([raw('lot.49')]);
    } });
    assert.equal(calls, 2);
    assert.equal((await response.json()).features[0].id, 'lot.49');
    calls = 0;
    const denied = await fetchMylandWfs(url, {}, { fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
    assert.equal(denied.status, 403);
    assert.equal(calls, 1);
    const controller = new AbortController();
    calls = 0;
    await assert.rejects(fetchMylandWfs(url, { signal: controller.signal }, { fetchImpl: async () => {
        calls++; controller.abort(); throw controller.signal.reason;
    } }), { name: 'AbortError' });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(fetchMylandWfs(url, {}, { fetchImpl: async () => {
        calls++; throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    } }), /fetch failed/);
    assert.equal(calls, 3);
});

test('MyLand header silence retries within the caller deadline, then releases the header timer', async () => {
    let calls = 0, responseSignal;
    const result = await fetchMylandWfs(`${descriptor.endpoint}?propertyName=geom`, {}, {
        headersTimeoutMs: 5,
        fetchImpl: async (_url, { signal }) => {
            if (++calls === 1) return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            responseSignal = signal;
            return page([raw('lot.49')]);
        }
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(calls, 2);
    assert.equal(responseSignal.aborted, false, 'The headers timer must not cancel a successful body stream');
    assert.equal((await result.json()).features[0].id, 'lot.49');
});

test('exhausted MyLand header deadlines are timeouts, not local HTTP 499 access denials', async () => {
    let attempts = 0;
    await assert.rejects(fetchMylandWfs(`${descriptor.endpoint}?propertyName=geom`, {}, {
        headersTimeoutMs: 2,
        fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
            attempts++;
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'),
                { status: 499, code: 'parcel-provider-relay-error' })), { once: true });
        })
    }), { status: 504, code: 'parcel-source-unavailable' });
    assert.equal(attempts, 3);
});

test('MyLand relay applies bounded retries while retaining the validated provider transport', async () => {
    const url = new URL(descriptor.endpoint);
    url.search = new URLSearchParams({ service: 'WFS', version: '1.1.0', request: 'GetFeature',
        typeName: 'ml12:lot', outputFormat: 'application/json', srsName: 'EPSG:4326',
        propertyName: 'geom', featureID: 'lot.49', maxFeatures: '100' });
    const request = validateParcelProviderRelayRequest(descriptor.id, { url: url.href, method: 'GET',
        headers: { Accept: 'application/json' }, redirect: 'error' }, { sources: [descriptor] });
    let calls = 0;
    const result = await fetchParcelProviderRelay(request, { providerFetch: async (target, options) => {
        assert.equal(target.href, url.href);
        assert.equal(options.redirect, 'error');
        if (++calls === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        return page([raw('lot.49')]);
    } });
    assert.equal(calls, 2);
    assert.equal((await result.json()).features[0].id, 'lot.49');
});

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name}: MyLand adjacent cells share live bounds evidence while exact reads remain independent`, async () => {
        const { source, requests } = fixture(factory, [page([raw('lot.49')]), page([raw('lot.49')]),
            page([raw('lot.49')]), page([raw('lot.49')])], { wfsProfile: 'myland-bounds-cache-v1' });
        const [first, second] = await Promise.all([
            source.queryBounds([118.072, 5.866, 118.074, 5.868]),
            source.queryBounds([118.073, 5.866, 118.074, 5.867])
        ]);
        assert.equal(requests.length, 2, 'One live bounds request and its exact-ID witness serve both cells');
        assert.equal(requests[0].url.searchParams.get('bbox'), '118.07,5.865,118.075,5.87,CRS:84');
        assert.equal(first.complete, true);
        assert.equal(second.complete, true);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(second.features[0].geometry, geometry);
        const empty = await source.queryBounds([118.071, 5.866, 118.072, 5.867]);
        assert.equal(empty.features.length, 0, 'A shared block must filter whole polygons to each requested envelope');
        await source.queryIds([canonicalId('lot.49')]);
        await source.queryIds([canonicalId('lot.49')]);
        assert.equal(requests.length, 4, 'Both repeated exact reads reach the provider');
        requests.forEach(assertSafe);
    });

    test(`${name}: MyLand exact reads use native featureID and preserve geometry without attributes`, async () => {
        const ids = [canonicalId('lot.49'), canonicalId('lot.534')];
        const { source, requests } = fixture(factory, [page([raw('lot.534'), raw('lot.49')]),
            page([raw('lot.49'), raw('lot.534')])]);
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(f => f.id).sort(), ids.slice().sort());
        for (const feature of first.features) {
            assert.deepEqual(feature.geometry, geometry);
            assert.deepEqual(feature.properties.sourceProperties, {});
            assert.equal(feature.properties.sourceParcelId, feature.id.slice(descriptor.idPrefix.length));
            assert.deepEqual(second.features.find(f => f.id === feature.id).geometry, feature.geometry);
        }
        for (const request of requests) {
            assertSafe(request);
            assert.equal(request.url.searchParams.get('featureID'), 'lot.49,lot.534');
            assert.equal(request.url.searchParams.get('maxFeatures'), '100');
        }
    });

    test(`${name}: bounds page safely and verify every native ID through exact reads`, async () => {
        const { source, requests } = fixture(factory, [page([raw('lot.49')], 2), page([raw('lot.534')], 2),
            page([raw('lot.49')], 2), page([raw('lot.534')], 2)], { pageSize: 1 });
        const result = await source.queryBounds([118.072, 5.865, 118.075, 5.868]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), [canonicalId('lot.49'), canonicalId('lot.534')]);
        assert.equal(requests[0].url.searchParams.get('bbox'), '118.072,5.865,118.075,5.868,CRS:84');
        assert.equal(requests[0].url.searchParams.has('startIndex'), false);
        assert.equal(requests[1].url.searchParams.get('startIndex'), '1');
        assert.equal(requests[2].url.searchParams.get('featureID'), 'lot.49,lot.534');
        assert.equal(requests[3].url.searchParams.get('startIndex'), '1');
        requests.forEach(assertSafe);
        result.features.forEach(feature => assert.deepEqual(feature.geometry, geometry));
    });

    test(`${name}: absent IDs are explicit; malformed IDs never reach MyLand`, async () => {
        const { source, requests } = fixture(factory, [page([])]);
        assert.deepEqual((await source.queryIds([canonicalId('lot.49')])).absentIds, [canonicalId('lot.49')]);
        for (const id of ['foreign-lot.49', canonicalId('lot.49,lot.534'), canonicalId('lot.49&propertyName=all')]) {
            await assert.rejects(source.queryIds([id]), { status: 400 });
        }
        assert.equal(requests.length, 1);
    });

    test(`${name}: bounds with changed exact geometry fail before publication`, async () => {
        const changed = structuredClone(geometry);
        changed.coordinates[0][1][0] = 118.0741;
        const { source } = fixture(factory, [page([raw('lot.49')]), page([raw('lot.49', changed)])]);
        await assert.rejects(source.queryBounds([118.072, 5.865, 118.075, 5.868]),
            { code: 'parcel-source-unstable-identity' });
    });

    test(`${name}: incomplete pages and actual streamed byte overflow fail closed`, async () => {
        const incomplete = fixture(factory, [page([raw('lot.49')], 2), page([], 2)], { pageSize: 1 });
        await assert.rejects(incomplete.source.queryBounds([118.072, 5.865, 118.075, 5.868]), { status: 502 });
        const oversized = fixture(factory, [page([raw('lot.49')])], { maxResponseBytes: 64 });
        await assert.rejects(oversized.source.queryIds([canonicalId('lot.49')]), /byte limit/);
    });
}

test('MyLand block cache expires, evicts failures and preserves large bounds limits', async () => {
    let clock = 0, calls = 0, fail = false;
    const base = {
        queryBounds: async () => { calls++; if (fail) throw new Error('provider unavailable');
            return { type: 'FeatureCollection', complete: true, features: [{ ...raw(canonicalId('lot.49')) }] }; },
        queryIds: async () => {}, queryGeometry: async () => {}
    };
    const source = createMylandWfsSource(descriptor, {}, () => base, { now: () => clock });
    const bounds = [118.072, 5.866, 118.074, 5.868];
    await source.queryBounds(bounds); await source.queryBounds(bounds);
    assert.equal(calls, 1);
    clock = 60001;
    fail = true;
    await assert.rejects(source.queryBounds(bounds), /provider unavailable/);
    fail = false;
    await source.queryBounds(bounds);
    assert.equal(calls, 3, 'A failed complete read cannot become cached absence');
    await assert.rejects(source.queryBounds([118, 5, 119, 6]), { status: 400 });
    assert.equal(calls, 3);
});
