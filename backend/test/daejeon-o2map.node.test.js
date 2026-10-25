// Exercise O2Map proxy construction, safe exact IDs, one-based paging and both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/daejeon-o2map-safe.json', import.meta.url)));
const descriptor = {
    id: 'kr-daejeon-city-o2map-cadastral-wfs', adapter: 'wfs', wfsProfile: 'o2map-pnu-v1',
    endpoint: 'https://gis.daejeon.go.kr/proxy/proxy.jsp?url=o2map/services/wfs', version: '1.1.0',
    featureType: 'LSMD_CONT_LDREG_2024', geometryField: 'THE_GEOM', idField: 'PNU', idType: 'string',
    idPrefix: 'KR-DAEJEON-PNU-', outFields: ['PNU'], requestProperties: true, pageSize: 2
};
const ids = sample.features.map(feature => `${descriptor.idPrefix}${feature.properties.PNU}`);
const json = (features, extra = {}) => new Response(JSON.stringify({ type: 'FeatureCollection', features, ...extra }));

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name}: exact native-PNU reads use safe fields and preserve geometry`, async () => {
        const calls = [];
        const source = factory(descriptor, { fetchImpl: async (url, init) => {
            const parsed = new URL(url), params = parsed.searchParams;
            calls.push(url);
            assert.equal(params.get('url'), 'o2map/services/wfs');
            assert.equal(params.get('typeName'), 'LSMD_CONT_LDREG_2024');
            assert.equal(params.get('propertyName'), 'PNU,THE_GEOM');
            assert.equal(params.get('srsName'), 'EPSG:4326');
            assert.equal(params.get('CQL'), `PNU IN (${sample.features.map(feature => `'${feature.properties.PNU}'`).join(',')})`);
            assert.equal(params.has('cql_filter'), false);
            assert.equal(params.get('maxFeatures'), '4');
            assert.equal(init.cache, 'no-store');
            return json(sample.features);
        } });
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.equal(calls.length, 2);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
        assert.deepEqual(first.features.map(feature => feature.properties.sourceParcelId), sample.features.map(feature => feature.properties.PNU));
        assert.deepEqual(first.features[0].properties.sourceProperties, { PNU: sample.features[0].properties.PNU });
    });

    test(`${name}: one interrupted read retries the same safe request with a fresh deadline`, async () => {
        for (const failure of [new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError'), 504]) {
            const calls = [];
            let discarded = false;
            const source = factory(descriptor, { fetchImpl: async (url, options) => {
                calls.push({ url, signal: options.signal });
                if (calls.length === 1) {
                    if (failure === 504) return new Response(new ReadableStream({ cancel() { discarded = true; } }), { status: 504 });
                    throw failure;
                }
                return json(sample.features);
            } });
            const result = await source.queryIds(ids);
            assert.equal(calls.length, 2);
            assert.equal(calls[0].url, calls[1].url);
            assert.notEqual(calls[0].signal, calls[1].signal);
            assert.equal(calls[1].signal.aborted, false);
            if (failure === 504) assert.equal(discarded, true);
            assert.deepEqual(result.features.map(feature => feature.geometry), sample.features.map(feature => feature.geometry));
        }
    });
}

test('persistent timeout fails after two reads and retains the source cooldown error contract', async () => {
    let calls = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async () => { calls++; return new Response('', { status: 504 }); } });
    await assert.rejects(source.queryIds(ids), error => error.status === 504 && error.code === 'parcel-source-unavailable');
    assert.equal(calls, 2);
    assert.throws(() => createParcelSource({ ...descriptor, timeoutMs: 30001 }), /Invalid O2Map/);
});

test('denials, rate limits, server errors and malformed responses never retry', async () => {
    for (const response of [new Response('', { status: 403 }), new Response('', { status: 429 }),
        new Response('', { status: 502 }), new Response('{bad json'), json([], { crs: { properties: { name: 'EPSG:5186' } } }),
        json([sample.features[1]])]) {
        let calls = 0;
        const source = createParcelSource(descriptor, { fetchImpl: async () => { calls++; return response; } });
        await assert.rejects(source.queryIds([ids[0]]));
        assert.equal(calls, 1);
    }
});

test('a transient failure on the second page retries that page without duplicating parcels', async () => {
    const starts = [];
    const source = createParcelSource(descriptor, { fetchImpl: async url => {
        const start = Number(new URL(url).searchParams.get('startIndex'));
        starts.push(start);
        if (starts.length === 2) throw new TypeError('connection reset');
        return json(sample.features.slice(start - 1, start + 1));
    } });
    const read = await source.queryBounds([127.391, 36.3407, 127.4, 36.349]);
    assert.deepEqual(starts, [1, 3, 3]);
    assert.equal(read.features.length, 3);
    assert.equal(new Set(read.features.map(feature => feature.id)).size, 3);
});

test('cancelled viewport reads stop in flight and never retry or query another page', async () => {
    for (const method of ['queryBounds', 'queryGeometry', 'queryIds']) {
        const controller = new AbortController();
        const reason = new DOMException('viewport changed', 'AbortError');
        let calls = 0;
        const source = createParcelSource(descriptor, { fetchImpl: async (_url, { signal }) => {
            calls++;
            controller.abort(reason);
            assert.equal(signal.aborted, true);
            signal.throwIfAborted();
        } });
        const input = method === 'queryIds' ? ids : method === 'queryGeometry' ? sample.features[0].geometry
            : [127.391, 36.3407, 127.4, 36.349];
        await assert.rejects(source[method](input, { signal: controller.signal }), error => error === reason);
        await assert.rejects(source[method](input, { signal: controller.signal }), error => error === reason);
        assert.equal(calls, 1);
    }
});

test('bounded pagination advances from row 1 to row 3 without requiring fabricated counts', async () => {
    const starts = [];
    const source = createParcelSource(descriptor, { fetchImpl: async url => {
        const start = Number(new URL(url).searchParams.get('startIndex'));
        starts.push(start);
        return json(sample.features.slice(start - 1, start + 1));
    } });
    const result = await source.queryBounds([127.391, 36.3407, 127.4, 36.349]);
    assert.deepEqual(starts, [1, 3]);
    assert.equal(result.features.length, 3);
    assert.equal(result.complete, true);
});

test('ignored exact filter and repeated pages fail instead of claiming completeness', async () => {
    const ignored = createParcelSource(descriptor, { fetchImpl: async () => json([sample.features[1]]) });
    await assert.rejects(ignored.queryIds([ids[0]]), /ignored the exact-PNU filter/);
    const repeated = createParcelSource(descriptor, { fetchImpl: async () => json(sample.features.slice(0, 2)) });
    await assert.rejects(repeated.queryBounds([127.391, 36.3407, 127.4, 36.349]), /repeated a parcel/);
});

test('duplicate PNU, foreign CRS and oversized responses fail', async () => {
    for (const payload of [
        { type: 'FeatureCollection', features: [sample.features[0], sample.features[0]] },
        { ...sample, crs: { type: 'name', properties: { name: 'EPSG:5186' } } }
    ]) {
        const source = createParcelSource(descriptor, { fetchImpl: async () => new Response(JSON.stringify(payload)) });
        await assert.rejects(source.queryIds(ids), /invalid/);
    }
    const large = createParcelSource({ ...descriptor, maxResponseBytes: 1024 }, {
        fetchImpl: async () => new Response(' '.repeat(1025))
    });
    await assert.rejects(large.queryIds(ids), /byte limit/);
});

test('valid empty exact response reports absence; malformed IDs never reach provider', async () => {
    let calls = 0;
    const source = createParcelSource(descriptor, { fetchImpl: async () => { calls++; return json([]); } });
    assert.deepEqual((await source.queryIds(ids)).absentIds, ids);
    for (const invalid of ['foreign-id', `${descriptor.idPrefix}123 OR 1=1`]) {
        await assert.rejects(source.queryIds([invalid]), /Invalid O2Map parcel ID/);
    }
    assert.equal(calls, 1);
    assert.throws(() => createParcelSource({ ...descriptor, outFields: ['PNU', 'JIBUN'] }), /Invalid O2Map/);
});

test('conservative provider BBOX is resolved after paging without altering intersecting polygons', async () => {
    const envelopeSample = JSON.parse(readFileSync(new URL('./fixtures/daejeon-o2map-envelope-safe.json', import.meta.url)));
    const source = createParcelSource({ ...descriptor, pageSize: 200 }, { fetchImpl: async () => json(envelopeSample.features) });
    const read = await source.queryBounds([127.390, 36.341, 127.391, 36.342]);
    assert.equal(read.complete, true);
    assert.equal(read.features.length, 1);
    assert.deepEqual(read.features[0].geometry, envelopeSample.features[0].geometry);
    assert.equal(read.features[0].properties.sourceParcelId, envelopeSample.features[0].properties.PNU);
});
