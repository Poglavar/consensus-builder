// GeoPixel sessions, safe selection, exact geometry preservation and fixed-source relay boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeopixelSource, GEOPIXEL_SOURCE, GEOPIXEL_ENDPOINT } from '../parcels/geopixel-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest, fetchParcelProviderRelay } from '../parcels/provider-relay.js';

const descriptor = { id: GEOPIXEL_SOURCE, adapter: 'geopixel', endpoint: GEOPIXEL_ENDPOINT,
    idField: 'gid', idPrefix: 'BR-BAURU-GPX-GID-', outFields: ['gid'], browserTransport: 'relay' };
const id = descriptor.idPrefix + '42';
const wkt = 'POLYGON((-49.0746 -22.3183,-49.0744 -22.3183,-49.0744 -22.3181,-49.0746 -22.3181,-49.0746 -22.3183),(-49.07455 -22.31825,-49.07450 -22.31825,-49.07450 -22.31820,-49.07455 -22.31825))';
const expected = { type: 'Polygon', coordinates: [
    [[-49.0746,-22.3183],[-49.0744,-22.3183],[-49.0744,-22.3181],[-49.0746,-22.3181],[-49.0746,-22.3183]],
    [[-49.07455,-22.31825],[-49.0745,-22.31825],[-49.0745,-22.3182],[-49.07455,-22.31825]]
] };
function provider(calls, { selection = [{ gid: 42 }], geometry = wkt, internalCookie = false } = {}) {
    let established = false, profile = false;
    return async (url, options) => {
        const target = new URL(url), route = target.pathname.split('/').at(-1);
        const headers = new Headers(options.headers); calls.push({ target, route, options });
        assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
        if (route === 'checkAccess') {
            established = false; profile = false;
            assert.equal(options.body, 'login=&pass=&isAnonymous=true');
            return new Response('{"chave":"ephemeral-anonymous-value","nome":"anonymous","login":"","appUsuario":{"usrId":2}}', { headers: internalCookie
                ? { 'x-parcel-upstream-cookies': '["JSESSIONID=test-session; Secure"]' } : { 'set-cookie': 'JSESSIONID=test-session; Secure' } });
        }
        assert.equal(headers.get('cookie'), 'JSESSIONID=test-session');
        if (route === 'ActionServlet') {
            const form = new URLSearchParams(options.body);
            if (form.has('key')) {
                assert.equal(form.get('key'), 'ephemeral-anonymous-value'); assert.equal(form.get('usr_id'), '2');
                established = true;
            } else { assert.equal(established, true); assert.equal(form.get('profile_id'), '2'); profile = true; }
            return new Response('');
        }
        if (route === 'profilesByKey') { assert.equal(established, true); return Response.json([{ prfId: 2, perfil: 'Público' }]); }
        if (route === 'setProfile') { assert.equal(options.body, 'profile_id=2'); return Response.json({ result: [true] }); }
        assert.equal(profile, true);
        if (route === 'getGeometry') {
            assert.equal(target.searchParams.get('target'), '42');
            assert.equal(target.searchParams.get('themeid'), '3353');
            return new Response(geometry);
        }
        if (route === 'getDataByGeom') {
            assert.match(options.body, /name="attrEntrada"\r\n\r\ngid\r\n/);
            assert.match(options.body, /POLYGON\(\(-546[0-9.]+ -254[0-9.]+/);
            assert.doesNotMatch(options.body, /\*|owner|address|tax/i);
            return Response.json(selection);
        }
        if (route === 'getPointedGeometry') return Response.json([{ gid: '42', key_name: 'gid', st_astext: wkt }]);
        throw new Error('Unexpected route');
    };
}
test('production factory uses anonymous sessions and re-fetches unchanged full exact polygons', async () => {
    const calls = [], fetchImpl = provider(calls);
    const source = createParcelSource(descriptor, { fetchImpl });
    const first = await source.queryIds([id]);
    const second = await source.queryIds([id]);
    assert.deepEqual(first, second); assert.deepEqual(first.features[0].geometry, expected);
    assert.deepEqual(first.features[0].properties.sourceProperties, { gid: '42' });
    const simultaneous = await Promise.all([source.queryIds([id]), source.queryIds([id])]);
    assert.deepEqual(simultaneous, [first, first]);
    assert.equal(calls.filter(c => c.route === 'getGeometry').length, 4);
    assert.equal(calls.filter(c => c.route === 'checkAccess').length, 1);
    await createGeopixelSource(descriptor, { fetchImpl }).queryIds([id]);
    assert.equal(calls.filter(c => c.route === 'checkAccess').length, 2);
});
test('area selection requests gid only, transforms query coordinates and retrieves full polygons', async () => {
    const calls = [];
    const source = createGeopixelSource(descriptor, { fetchImpl: provider(calls) });
    const read = await source.queryBounds([-49.0746,-22.3183,-49.0744,-22.3181]);
    assert.deepEqual(read.features[0].geometry, expected);
    assert.equal(read.queryType, 'bounds'); assert.equal(read.complete, true);
    assert.equal(calls.filter(c => c.route === 'getGeometry').length, 1);
});
test('viewport exact reads use bounded parallel requests and preserve order and fresh geometry', async () => {
    const calls = [], upstream = provider(calls), reads = [];
    let active = 0, peak = 0;
    const source = createGeopixelSource(descriptor, { fetchImpl: async (url, options) => {
        const target = new URL(url);
        if (!target.pathname.endsWith('/getGeometry')) return upstream(url, options);
        reads.push(target.searchParams.get('target'));
        peak = Math.max(peak, ++active);
        await new Promise(setImmediate);
        active--;
        return new Response(wkt);
    } });
    const requested = Array.from({ length: 9 }, (_, index) => descriptor.idPrefix + (42 + index));
    for (let repeat = 0; repeat < 2; repeat++) {
        const result = await source.queryIds([...requested, requested[0]]);
        assert.deepEqual(result.features.map(feature => feature.id), requested);
        assert.ok(result.features.every(feature => JSON.stringify(feature.geometry) === JSON.stringify(expected)));
    }
    assert.equal(peak, 4);
    assert.equal(reads.length, 18);
    assert.equal(calls.filter(call => call.route === 'checkAccess').length, 1);
});
test('failed exact batches drain their in-flight requests before releasing the source operation', async () => {
    const upstream = provider([]), started = Promise.withResolvers(), release = Promise.withResolvers();
    let count = 0, settled = false;
    const source = createGeopixelSource(descriptor, { fetchImpl: async (url, options) => {
        const target = new URL(url);
        if (!target.pathname.endsWith('/getGeometry')) return upstream(url, options);
        if (++count === 4) started.resolve();
        if (target.searchParams.get('target') === '42') return new Response('invalid geometry');
        await release.promise;
        return new Response(wkt);
    } });
    const read = source.queryIds(Array.from({ length: 5 }, (_, index) => descriptor.idPrefix + (42 + index)));
    read.then(() => { settled = true; }, () => { settled = true; });
    await started.promise;
    await new Promise(setImmediate);
    try { assert.equal(settled, false); }
    finally { release.resolve(); }
    await assert.rejects(read);
    assert.equal(count, 4);
});
test('fail closed on denied access, invalid exact geometry, saturated selections and unexpected fields', async () => {
    await assert.rejects(createGeopixelSource(descriptor, { fetchImpl: async () => new Response('', { status: 401 }) }).queryIds([id]), /HTTP 401/);
    await assert.rejects(createGeopixelSource(descriptor, { fetchImpl: provider([], { geometry: 'not found' }) }).queryIds([id]));
    for (const selection of [Array.from({ length: 80 }, (_, i) => ({ gid: i + 1 })), [{ gid: 42, extra: 'unrequested' }], [{ gid: 42 }, { gid: 42 }]]) {
        await assert.rejects(createGeopixelSource(descriptor, { fetchImpl: provider([], { selection }) }).queryBounds([-49.0746,-22.3183,-49.0744,-22.3181]));
    }
    await assert.rejects(createGeopixelSource(descriptor).queryIds([descriptor.idPrefix + '42 OR 1=1']));
});
test('browser factory runs through pinned relay without exposing anonymous cookie or upstream attributes', async () => {
    const calls = [];
    const source = browserParcelFactories.geopixel(descriptor, { fetchImpl: (url, options) => fetchParcelProviderRelay(
        validateParcelProviderRelayRequest(GEOPIXEL_SOURCE, { url, method: options.method, headers: options.headers, body: options.body },
            { sources: [descriptor] }), { providerFetch: provider(calls, { internalCookie: true }) }) });
    const read = await source.queryIds([id]);
    assert.deepEqual(read.features[0].geometry, expected);
    assert.doesNotMatch(JSON.stringify(read), /JSESSIONID|test-session|ephemeral/);
    assert.throws(() => validateParcelProviderRelayRequest(GEOPIXEL_SOURCE, {
        url: GEOPIXEL_ENDPOINT.replace('getPointedGeometry', 'getData'), method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _geopixelOperation: 'queryIds', input: [id] }) }, { sources: [descriptor] }));
});
test('browser operation envelopes always go to the relay, including when the provider supports CORS', async () => {
    const calls = [];
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api', fetchImpl: async (url, options) => {
        calls.push(url);
        const request = JSON.parse(options.body);
        return fetchParcelProviderRelay(validateParcelProviderRelayRequest(GEOPIXEL_SOURCE, request, { sources: [descriptor] }),
            { providerFetch: provider([], { internalCookie: true }) });
    } });
    const read = await browserParcelFactories.geopixel(descriptor, { fetchImpl }).queryIds([id]);
    assert.equal(read.features[0].id, id);
    assert.deepEqual(calls, [`https://app.example/api/parcel-provider-relay/${GEOPIXEL_SOURCE}`]);
    assert.throws(() => browserParcelFactories.geopixel({ ...descriptor, browserTransport: undefined }), /requires the fixed-source relay/);
});
test('expired public sessions renew once and exact geometry is still freshly read', async () => {
    const calls = [], upstream = provider(calls);
    let denied = false;
    const source = createGeopixelSource(descriptor, { fetchImpl: async (url, options) => {
        if (new URL(url).pathname.endsWith('/getGeometry') && !denied) {
            denied = true; return new Response('', { status: 401 });
        }
        return upstream(url, options);
    } });
    const read = await source.queryIds([id]);
    assert.deepEqual(read.features[0].geometry, expected);
    assert.equal(calls.filter(c => c.route === 'checkAccess').length, 2);
});
test('browser body cancellation is preserved instead of poisoning source cooldown as invalid geometry', async () => {
    const error = new DOMException('Cancelled', 'AbortError');
    const source = browserParcelFactories.geopixel(descriptor, { fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(error); }
    })) });
    await assert.rejects(source.queryIds([id]), e => e === error);
});
