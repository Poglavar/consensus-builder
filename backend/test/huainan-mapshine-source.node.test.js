// Exercise source privacy, unchanged multipart geometry, independent localized ID reads and caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHuainanMapshineParcelSource, HUAINAN_ENDPOINT } from '../parcels/huainan-mapshine-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const descriptor = { id: 'cn-huainan-mapshine-cadastral-parcels', adapter: 'huainan-mapshine',
    endpoint: HUAINAN_ENDPOINT, idPrefix: 'CN-HUAINAN-ZD-', idField: 'id', geometryField: 'geom',
    outFields: ['id'], sourceCrs: 'EPSG:4326', lookupPoint: [116.983,32.639] };
const bounds = [116.982,32.638,116.984,32.640];
const wkt = 'MULTIPOLYGON (((116.9821 32.6381,116.9839 32.6381,116.9839 32.6399,116.9821 32.6381),(116.983 32.6385,116.9831 32.6385,116.9831 32.6386,116.983 32.6385)))';
const row = { id: 2814, geom: wkt, unrelated: 'discard this' };
const id = 'CN-HUAINAN-ZD-2814';
const fixture = (rows = [row]) => {
    const requests = [];
    const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(rows)); };
    return { requests, fetchImpl, adapter: createHuainanMapshineParcelSource(descriptor, { fetchImpl }) };
};

test('bounded form query preserves every coordinate and hole and excludes incidental fields', async () => {
    const { adapter, requests } = fixture();
    const result = await adapter.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.equal(result.areaComplete, false);
    const feature = result.features[0];
    assert.equal(feature.id, id);
    assert.deepEqual(feature.geometry, { type: 'MultiPolygon', coordinates: [[
        [[116.9821,32.6381],[116.9839,32.6381],[116.9839,32.6399],[116.9821,32.6381]],
        [[116.983,32.6385],[116.9831,32.6385],[116.9831,32.6386],[116.983,32.6385]]
    ]] });
    assert.deepEqual(feature.properties.sourceProperties, { id: '2814' });
    assert.equal(JSON.stringify(result).includes('discard this'), false);
    assert.equal(requests[0].url, HUAINAN_ENDPOINT);
    assert.deepEqual([...new URLSearchParams(requests[0].init.body).keys()], ['geoWkt']);
    assert.ok(new URLSearchParams(requests[0].init.body).get('geoWkt').includes('116.982 32.638'));
    assert.equal(requests[0].init.credentials, 'omit');
});

test('localized exact reads use fresh transport including after a bounds query', async () => {
    const { adapter, requests } = fixture();
    await adapter.queryBounds(bounds);
    const first = await adapter.queryIds([id]);
    const second = await adapter.queryIds([id]);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].init.body, requests[1].init.body);
    assert.deepEqual(first, second);
    assert.deepEqual(first.features.map(feature => feature.id), [id]);
    assert.deepEqual(first.absentIds, []);
});

test('a cold adapter uses the supplied near point and never declares a missing native ID absent', async () => {
    const { adapter, requests } = fixture([]);
    const missing = 'CN-HUAINAN-ZD-999';
    const result = await adapter.queryIds([missing], { near: [116.99,32.63] });
    assert.equal(result.complete, false);
    assert.deepEqual(result.unresolvedIds, [missing]);
    assert.deepEqual(result.absentIds, []);
    assert.ok(new URLSearchParams(requests[0].init.body).get('geoWkt').includes(String(116.99-0.001)));
});

test('bad queries fail before transport, and duplicate or unsafe native IDs fail closed', async () => {
    const { adapter, requests } = fixture();
    await assert.rejects(adapter.queryBounds([116,32,117,33]), /too large/);
    await assert.rejects(adapter.queryIds(['foreign-2814']), /Invalid/);
    assert.equal(requests.length, 0);
    for (const rows of [[row,row], [{ ...row, id: 9007199254740992 }], [{ ...row, geom: wkt.replace('116.9821 32.6381)', '116.9822 32.6381)') }]]) {
        await assert.rejects(fixture(rows).adapter.queryBounds(bounds));
    }
});

test('unknown-length oversized streams are cancelled, and a full local row cap is rejected', async () => {
    let cancelled = false;
    const adapter = createHuainanMapshineParcelSource({ ...descriptor, maxResponseBytes: 1024 }, {
        fetchImpl: async () => new Response(new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array(1025)); },
            cancel() { cancelled = true; }
        }))
    });
    await assert.rejects(adapter.queryBounds(bounds), /truncated/);
    assert.equal(cancelled, true);
    const capped = createHuainanMapshineParcelSource({ ...descriptor, maxFeatures: 1 }, { fetchImpl: fixture().fetchImpl });
    await assert.rejects(capped.queryBounds(bounds), /truncated/);
});

test('backend and browser factories execute the same bounded provider request', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['huainan-mapshine']]) {
        const { fetchImpl, requests } = fixture();
        const result = await factory(descriptor, { fetchImpl }).queryIds([id]);
        assert.deepEqual(result.features.map(feature => feature.id), [id]);
        assert.equal(requests.length, 1);
    }
});

test('existing fixed-source relay permits geometry POST and rejects unrelated detail routes', () => {
    const request = { url: HUAINAN_ENDPOINT, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'geoWkt=POLYGON%20((116.982%2032.638,116.984%2032.638,116.984%2032.640,116.982%2032.638))' };
    assert.equal(validateParcelProviderRelayRequest(descriptor.id, request, { sources: [descriptor] }).method, 'POST');
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { ...request, url: 'https://mapshine.cn/hnbdc/Zongdi/AttributeBox?KeyValue=2814' }, { sources: [descriptor] }));
});
