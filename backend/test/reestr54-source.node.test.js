// Exercise bounded cadastral scope, anonymous CSRF transport, native identity and unmodified ring topology.
import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { createReestr54Source, REESTR54_SOURCE, REESTR54_ENDPOINT } from '../parcels/reestr54-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const nativeIds = ['22:63:000000:1471', '22:63:000000:1541', '22:63:050814:79'];
const descriptor = { id: REESTR54_SOURCE, endpoint: REESTR54_ENDPOINT, adapter: 'reestr54-bounded',
    idPrefix: 'RU-REESTR54-BARNAUL-', idField: 'cad_num', outFields: ['cad_num'], nativeCrs: 'EPSG:3857',
    browserTransport: 'relay', capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds } };
const token = 'a'.repeat(32);
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const polygon = [square(9319000, 7046400, 100), square(9319020, 7046420, 10)];
const row = id => ({ type: 'Feature', properties: { category: 36368,
    options: { cad_num: id, discarded: 'unselected synthetic field' } },
    geometry: { type: 'MultiPolygon', coordinates: [polygon] } });
function mock(rows = row) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, ...options });
        assert.equal(url, REESTR54_ENDPOINT);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        if (options.method === 'GET') return new Response('Публичная кадастровая карта', {
            headers: { 'Set-Cookie': `csrftoken=${token}; Path=/; SameSite=Lax` } });
        assert.equal(options.headers.Cookie, `csrftoken=${token}`);
        assert.equal(options.headers['X-CSRFToken'], token);
        assert.equal(options.headers.Referer, REESTR54_ENDPOINT);
        const body = JSON.parse(options.body);
        assert.deepEqual(Object.keys(body), ['new_kadnum', 'zoom']);
        assert.equal(body.zoom, 19);
        return new Response(JSON.stringify(rows(body.new_kadnum)), { headers: { 'Content-Type': 'application/json' } });
    };
    return { calls, fetchImpl };
}
test('backend and browser factories repeat exact live reads with native ID and all rings intact', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['reestr54-bounded']]) {
        const { fetchImpl, calls } = mock();
        const source = factory(descriptor, { fetchImpl });
        const ids = nativeIds.slice(0, 1).map(id => descriptor.idPrefix + id);
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.deepEqual(second, first);
        assert.equal(calls.filter(call => call.method === 'POST').length, 2);
        assert.equal(calls.filter(call => call.method === 'GET').length, 1);
        const f = first.features[0];
        assert.equal(f.id, ids[0]);
        assert.equal(f.properties.sourceParcelId, nativeIds[0]);
        assert.deepEqual(f.properties.sourceProperties, { cad_num: nativeIds[0] });
        assert.deepEqual(f.geometry.coordinates, [polygon.map(ring => ring.map(p => proj4('EPSG:3857', 'EPSG:4326', p)))]);
        assert.equal(JSON.stringify(first).includes('discarded'), false);
    }
});
test('bounds enumerate exactly the explicit ID subset and never claim wider area completeness', async () => {
    const { fetchImpl, calls } = mock();
    const source = createReestr54Source(descriptor, { fetchImpl });
    const result = await source.queryBounds([83.71, 53.34, 83.72, 53.35]);
    assert.equal(result.features.length, 3);
    assert.equal(result.complete, true);
    assert.equal(result.coverageScope, 'explicit-native-id-subset');
    assert.equal(result.areaComplete, false);
    assert.equal(result.authoritativeAbsence, false);
    assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body).new_kadnum), nativeIds);
    const before = calls.length;
    await assert.rejects(source.queryIds([descriptor.idPrefix + '22:63:000000:999']), { code: 'parcel-source-out-of-scope' });
    assert.equal(calls.length, before);
});
test('no-object/outage, foreign identity, non-parcel category and invalid rings fail without absence', async () => {
    const variants = [() => ({ badresponse: true }), () => row(nativeIds[1]), id => ({ ...row(id), properties: { category: 1, options: { cad_num: id } } }),
        id => ({ ...row(id), geometry: { type: 'Polygon', coordinates: [square(9319000, 7046400, 100).slice(0, -1)] } })];
    for (const variant of variants) {
        const source = createReestr54Source(descriptor, mock(variant));
        await assert.rejects(source.queryIds([descriptor.idPrefix + nativeIds[0]]), { code: 'parcel-source-unavailable' });
    }
});
test('actual streamed bytes are capped even without Content-Length', async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1100)); }, cancel() { cancelled = true; }
    }));
    const source = createReestr54Source(descriptor, { fetchImpl, maxResponseBytes: 1024 });
    await assert.rejects(source.queryIds([descriptor.idPrefix + nativeIds[0]]));
    assert.equal(cancelled, true);
});
test('relay permits only the pinned anonymous session and bounded native-ID operations', () => {
    const request = { url: REESTR54_ENDPOINT, method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Referer: REESTR54_ENDPOINT,
            Cookie: `csrftoken=${token}`, 'X-CSRFToken': token },
        body: JSON.stringify({ new_kadnum: nativeIds[0], zoom: 19 }) };
    const validate = input => validateParcelProviderRelayRequest(descriptor.id, input, { sources: [descriptor] });
    assert.equal(validate(request).target.href, REESTR54_ENDPOINT);
    assert.equal(validate({ url: REESTR54_ENDPOINT }).method, 'GET');
    for (const input of [{ ...request, url: REESTR54_ENDPOINT + '?other=1' },
        { ...request, body: JSON.stringify({ new_kadnum: '22:63:000000:999', zoom: 19 }) },
        { ...request, headers: { ...request.headers, Cookie: `other=${token}` } },
        { ...request, headers: { ...request.headers, 'X-CSRFToken': 'b'.repeat(32) } },
        { ...request, headers: { ...request.headers, Referer: 'https://example.org/' } }]) assert.throws(() => validate(input));
});
test('browser relay restores page cookie metadata for per-adapter CSRF sessions', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return new Response('Публичная кадастровая карта', { headers: {
            'x-parcel-upstream-cookies': JSON.stringify([`csrftoken=${token}; Path=/`]) } });
    };
    const fetchProvider = createBrowserProviderFetch(descriptor, { relayBase: '/api', fetchImpl });
    const response = await fetchProvider(REESTR54_ENDPOINT, { headers: { Accept: 'text/html' } });
    assert.deepEqual(response.headers.getSetCookie(), [`csrftoken=${token}; Path=/`]);
    assert.equal(calls[0].url, `/api/parcel-provider-relay/${REESTR54_SOURCE}`);
});
