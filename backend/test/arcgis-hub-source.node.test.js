import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisHubParcelSource, isArcgisHubParcelUrl } from '../parcels/arcgis-hub-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = {
    id: 'ca-on-london-city-open-data-parcels', adapter: 'arcgis-hub',
    endpoint: 'https://hub.arcgis.com/api/download/v1/items/1b14d93461b34591b5bd32a881763dbe/geojson?redirect=true&layers=53&where=1%3D1',
    idPrefix: 'CA-ON-LONDON-', idField: 'GIS_ID', outFields: ['GIS_ID'], maxBboxKm2: 1
};
const geometry = { type: 'Polygon', coordinates: [[[-81.2469, 42.9851], [-81.2468, 42.9851],
    [-81.2468, 42.9852], [-81.2469, 42.9852], [-81.2469, 42.9851]]] };
const parcel = (key = 39378) => ({ type: 'Feature', properties: { GIS_ID: key, Perimeter: 50 }, geometry });
const collection = (features = [parcel()]) => ({ type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('backend and browser factories perform independent filtered exact reads and retain native geometry', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['arcgis-hub']]) {
        const calls = [];
        const source = factory(descriptor, { fetchImpl: async url => { calls.push(new URL(url)); return response(collection()); } });
        const first = await source.queryIds(['CA-ON-LONDON-39378']);
        const second = await source.queryIds(['CA-ON-LONDON-39378']);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(first.features[0].properties.sourceProperties, { GIS_ID: 39378 });
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.equal(calls.length, 2);
        assert.ok(calls.every(url => url.searchParams.get('where') === 'GIS_ID IN (39378)'
            && url.searchParams.get('outFields') === 'GIS_ID'));
    }
});

test('pending generation is retried; an empty finished export establishes explicit absence', async () => {
    let calls = 0, sleeps = 0;
    const source = createArcgisHubParcelSource(descriptor, { sleep: async () => { sleeps++; }, fetchImpl: async () =>
        ++calls <= 2 ? new Response(JSON.stringify({ status: calls === 1 ? 'Pending' : 'PagingData' }), { status: 202 }) : response(collection([])) });
    assert.deepEqual((await source.queryIds(['CA-ON-LONDON-999999'])).absentIds, ['CA-ON-LONDON-999999']);
    assert.equal(calls, 3); assert.equal(sleeps, 2);
});

test('cold generation can exceed one HTTP deadline while each request and the whole export stay bounded', async () => {
    const originalTimeout = AbortSignal.timeout, deadlines = [];
    let elapsed = 0, calls = 0;
    AbortSignal.timeout = milliseconds => {
        const controller = new AbortController();
        deadlines.push({ at: elapsed + milliseconds, controller });
        return controller.signal;
    };
    try {
        const source = createArcgisHubParcelSource(descriptor, {
            sleep: async milliseconds => {
                assert.equal(milliseconds, 4000);
                elapsed += milliseconds;
                for (const timer of deadlines) if (timer.at <= elapsed) timer.controller.abort(new Error('deadline'));
            },
            fetchImpl: async (_url, { signal }) => {
                signal.throwIfAborted();
                return ++calls <= 16 ? new Response(JSON.stringify({ status: 'PagingData' }), { status: 202 }) : response(collection());
            }
        });
        assert.equal((await source.queryIds(['CA-ON-LONDON-39378'])).features.length, 1);
        assert.equal(elapsed, 64000);
        assert.equal(calls, 17);
    } finally { AbortSignal.timeout = originalTimeout; }
});

test('retries transient gateways and respects explicit rate-limit delay without accepting an error body', async () => {
    const delays = [];
    let calls = 0;
    const source = createArcgisHubParcelSource(descriptor, {
        sleep: async milliseconds => delays.push(milliseconds),
        fetchImpl: async () => ++calls === 1 ? new Response('gateway failure', { status: 502 })
            : calls === 2 ? new Response('retry later', { status: 429, headers: { 'retry-after': '5' } }) : response(collection())
    });
    assert.equal((await source.queryIds(['CA-ON-LONDON-39378'])).features.length, 1);
    assert.deepEqual(delays, [1000, 5000]);
    assert.equal(calls, 3);
});

test('neighboring viewport requests share one bounded export and return only intersecting parcels', async () => {
    const calls = [];
    const source = createArcgisHubParcelSource(descriptor, { fetchImpl: async url => { calls.push(new URL(url)); return response(collection()); } });
    const [inside, outside] = await Promise.all([
        source.queryBounds([-81.247, 42.985, -81.246, 42.986]),
        source.queryBounds([-81.249, 42.985, -81.248, 42.986])
    ]);
    assert.equal(calls.length, 1); assert.equal(inside.features.length, 1); assert.equal(outside.features.length, 0);
    assert.deepEqual(JSON.parse(calls[0].searchParams.get('geometry')), { type: 'extent',
        xmin: -81.25, ymin: 42.985, xmax: -81.245, ymax: 42.99, spatialReference: { wkid: 4326 } });
});

test('accepts envelope-intersection candidates without claiming they intersect the requested polygon', async () => {
    const outside = { type: 'Polygon', coordinates: [[[-81.251, 42.99], [-81.25, 42.991],
        [-81.251, 42.991], [-81.251, 42.99]]] };
    const source = createArcgisHubParcelSource(descriptor, { fetchImpl: async () =>
        response(collection([{ ...parcel(), geometry: outside }])) });
    const result = await source.queryBounds([-81.247, 42.985, -81.246, 42.986]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
});

test('filters native extent-search edge over-return locally without shifting any polygon', async () => {
    const outside = { type: 'Polygon', coordinates: [[[-81.2502, 42.986], [-81.250002, 42.986],
        [-81.250002, 42.9862], [-81.2502, 42.9862], [-81.2502, 42.986]]] };
    const before = structuredClone(outside);
    const source = createArcgisHubParcelSource(descriptor, { fetchImpl: async () =>
        response(collection([{ ...parcel(), geometry: outside }])) });
    const result = await source.queryBounds([-81.247, 42.985, -81.246, 42.986]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(outside, before);
});

test('rejects unexpected IDs, repeated IDs, transfer truncation and non-WGS84 coordinates', async () => {
    const cases = [collection([parcel(5)]), collection([parcel(), parcel()]),
        { ...collection(), exceededTransferLimit: true }, { ...collection(), crs: { type: 'name', properties: { name: 'EPSG:26917' } } },
        collection([{ ...parcel(), geometry: { type: 'Point', coordinates: [-81, 43] } }])];
    for (const data of cases) {
        const source = createArcgisHubParcelSource(descriptor, { fetchImpl: async () => response(data) });
        await assert.rejects(source.queryIds(['CA-ON-LONDON-39378']));
    }
});

test('actual stream byte limit applies when Content-Length is missing and failed windows are retryable', async () => {
    let calls = 0;
    const source = createArcgisHubParcelSource({ ...descriptor, maxResponseBytes: 1024 }, { fetchImpl: async () =>
        ++calls === 1 ? new Response(' '.repeat(2048)) : response(collection()) });
    await assert.rejects(source.queryBounds([-81.247, 42.985, -81.246, 42.986]), /actual byte limit/);
    assert.equal((await source.queryBounds([-81.247, 42.985, -81.246, 42.986])).features.length, 1);
    assert.equal(calls, 2);
});

test('malformed, foreign and SQL-injection IDs fail before network access', async () => {
    let calls = 0;
    const source = createArcgisHubParcelSource(descriptor, { fetchImpl: async () => { calls++; return response(collection()); } });
    for (const key of ['CA-ON-LONDON-39378 OR 1=1', 'OTHER-39378', 'CA-ON-LONDON-039378']) {
        await assert.rejects(source.queryIds([key]), /native parcel IDs/);
    }
    assert.equal(calls, 0);
});

test('relay permits only bounded filters and the same dataset redirect; rejects unfiltered exports and POST', () => {
    const url = new URL(descriptor.endpoint);
    url.searchParams.set('where', 'GIS_ID IN (39378)'); url.searchParams.set('outFields', 'GIS_ID');
    const cached = 'https://hub.arcgis.com/api/v3/datasets/1b14d93461b34591b5bd32a881763dbe_53/downloads/data?format=geojson&spatialRefId=4326&where=GIS_ID+IN+%2839378%29';
    for (const target of [url.href, cached]) {
        assert.ok(isArcgisHubParcelUrl(descriptor, target));
        assert.equal(validateParcelProviderRelayRequest(descriptor.id, { url: target, redirect: 'follow' }, { sources: [descriptor] }).target.href, target);
    }
    for (const target of [descriptor.endpoint, cached.replace('_53/', '_52/'), cached.replace('spatialRefId=4326', 'spatialRefId=26917'),
        cached + '&outFields=*', cached.replace('GIS_ID+IN+%2839378%29', '1%3D1')]) {
        assert.equal(isArcgisHubParcelUrl(descriptor, target), false);
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url: target }, { sources: [descriptor] }));
    }
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, {
        url: url.href, method: 'POST', body: '', headers: { 'content-type': 'application/json' }
    }, { sources: [descriptor] }));
});
