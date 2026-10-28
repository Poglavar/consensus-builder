// Verify SBB identity binding, unchanged polygon parts, finite scope, byte limits and relay isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { createSakaryaSbbSource, SAKARYA_SOURCE, SAKARYA_ENDPOINT, SAKARYA_ORIGIN, SAKARYA_VIEWER } from '../parcels/sakarya-sbb-source.js';

const descriptor = { id: SAKARYA_SOURCE, endpoint: SAKARYA_ENDPOINT, adapter: 'sakarya-sbb-bounded',
    idPrefix: 'TR-SBB-', idField: 'id', outFields: ['id'], capabilities: { areaEnumeration: false },
    coverage: { scope: 'explicit-native-id-subset', citywide: false, nativeIds: ['753339386'] } };
const id = 'TR-SBB-753339386';
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[30.4, 40.7], [30.401, 40.7], [30.401, 40.701], [30.4, 40.701], [30.4, 40.7]],
        [[30.4002, 40.7002], [30.4002, 40.7004], [30.4004, 40.7004], [30.4004, 40.7002], [30.4002, 40.7002]]],
    [[[30.402, 40.702], [30.403, 40.702], [30.403, 40.703], [30.402, 40.703], [30.402, 40.702]]]
] };
function mock(patch = {}, status = 200) {
    const calls = [];
    return { calls, fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        return new Response(JSON.stringify({ id: 753339386, statusParameter: 'AKTİF', geometry,
            incidental: 'discard-this', ...patch }), { status, headers: { 'Content-Type': 'application/json' } });
    } };
}

test('backend and browser factories perform independent exact native-ID reads and preserve every coordinate', async () => {
    for (const factory of [createParcelSource, browserParcelFactories[descriptor.adapter]]) {
        const upstream = mock(), adapter = factory(descriptor, upstream);
        const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
        assert.equal(upstream.calls.length, 2);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(first.features[0].properties.sourceProperties, { id: '753339386' });
        assert.equal(first.features[0].id, id);
        assert.equal(JSON.stringify(first).includes('discard-this'), false);
        assert.equal(first.areaComplete, false);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(JSON.parse(upstream.calls[0].body), { id: 753339386 });
        assert.equal(upstream.calls[0].headers.Origin, SAKARYA_ORIGIN);
    }
});

test('scope failures, changed identity, inactive records and malformed geometry never become absence', async () => {
    for (const patch of [{ id: 99 }, { statusParameter: 'PASİF' }, { geometry: { type: 'Point', coordinates: [30.4, 40.7] } }]) {
        await assert.rejects(createSakaryaSbbSource(descriptor, mock(patch)).queryIds([id]), /unusable/);
    }
    const upstream = mock();
    await assert.rejects(createSakaryaSbbSource(descriptor, upstream).queryIds(['TR-SBB-99']), e => e.code === 'parcel-source-out-of-scope');
    assert.equal(upstream.calls.length, 0);
    await assert.rejects(createSakaryaSbbSource(descriptor, mock({}, 403)).queryIds([id]), e => e.code === 'parcel-source-blocked');
});

test('viewport, geometry and point filter the finite live subset and exact calls bypass the spatial cache', async () => {
    const upstream = mock(), adapter = createSakaryaSbbSource(descriptor, upstream);
    assert.equal((await adapter.queryBounds([30.3999, 40.6999, 30.4011, 40.7011])).features.length, 1);
    assert.equal((await adapter.queryPoint([30.4001, 40.7001])).features.length, 1);
    assert.equal((await adapter.queryPoint([30.4003, 40.7003])).features.length, 0);
    assert.equal((await adapter.queryPoint([30.4078913508982, 40.7632117164762])).features.length, 0);
    assert.equal((await adapter.queryGeometry(geometry)).features.length, 1);
    assert.equal(upstream.calls.length, 1);
    await adapter.queryIds([id]);
    assert.equal(upstream.calls.length, 2);
});

test('actual streamed bytes are capped and a failed spatial read remains retryable', async () => {
    let cancelled = false, calls = 0;
    const upstream = mock();
    const fetchImpl = async (...args) => ++calls === 1 ? new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; }
    }), { headers: { 'Content-Type': 'application/json' } }) : upstream.fetchImpl(...args);
    const adapter = createSakaryaSbbSource(descriptor, { fetchImpl, maxResponseBytes: 1024 });
    await assert.rejects(adapter.queryPoint([30.4, 40.7]), /unusable/);
    assert.equal(cancelled, true);
    assert.equal((await adapter.queryPoint([30.4, 40.7])).features.length, 1);
});

test('relay permits only pinned public-viewer headers and one configured native ID', () => {
    const input = { url: SAKARYA_ENDPOINT, method: 'POST', body: JSON.stringify({ id: 753339386 }),
        headers: { 'Content-Type': 'application/json', Origin: SAKARYA_ORIGIN, Referer: SAKARYA_VIEWER } };
    const validate = value => validateParcelProviderRelayRequest(descriptor.id, value, { sources: [descriptor] });
    assert.equal(validate(input).method, 'POST');
    for (const patch of [{ body: '{"id":99}' }, { body: '{"id":753339386,"extra":true}' },
        { url: SAKARYA_ENDPOINT + '?extra=true' }, { method: 'GET', body: undefined },
        { headers: { ...input.headers, Origin: 'https://example.test' } },
        { headers: { ...input.headers, Referer: 'https://example.test' } },
        { headers: { ...input.headers, Cookie: 'private=value' } }]) {
        assert.throws(() => validate({ ...input, ...patch }));
    }
});
