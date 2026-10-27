// Exercise fresh native-gid reads, unchanged KML rings, privacy and bounded GFI manifests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrientesWmsSource, CORRIENTES_SOURCE, CORRIENTES_ENDPOINT } from '../parcels/corrientes-wms-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest, fetchParcelProviderRelay } from '../parcels/provider-relay.js';

const descriptor = { id: CORRIENTES_SOURCE, endpoint: CORRIENTES_ENDPOINT, adapter: 'corrientes-wms',
    layer: 'informacion_catastral:vw_parcelas', idPrefix: 'AR-CORRIENTES-MUNI-GID-', idField: 'gid',
    idFields: ['gid'], outFields: ['gid'], caCertificate: './certificates/sectigo-public-server-authentication-ca-dv-r36.pem' };
const id = value => descriptor.idPrefix + value;
const shell = [[-58.8118,-27.4833,0],[-58.8115,-27.4833,0],[-58.8115,-27.4831,0],[-58.8118,-27.4833,0]];
const hole = [[-58.8116,-27.48325,0],[-58.81155,-27.48325,0],[-58.81155,-27.4832,0],[-58.8116,-27.48325,0]];
const ring = (coordinates, side) => `<${side}BoundaryIs><LinearRing><coordinates>${coordinates.map(p => p.join(',')).join(' ')}</coordinates></LinearRing></${side}BoundaryIs>`;
const mark = (extra = '') => `<Placemark id="changing-ephemeral-fid"><MultiGeometry><Point><coordinates>-58.8116,-27.4832</coordinates></Point><Polygon>${ring(shell,'outer')}${ring(hole,'inner')}</Polygon></MultiGeometry>${extra}</Placemark>`;
const kml = marks => `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${marks}</Document></kml>`;
const response = text => new Response(text, { status: 200 });

for (const [name, factory] of [['backend', createParcelSource]]) {
    test(`${name} factory reads each native gid afresh and preserves every ring coordinate`, async () => {
        const calls = [];
        const adapter = factory(descriptor, { fetchImpl: async (url, options) => {
            const p = new URL(url).searchParams; calls.push(p);
            assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
            assert.equal(p.get('request'), 'GetMap'); assert.equal(p.get('maxFeatures'), '2');
            assert.equal(p.get('format_options'), 'KMSCORE:100;KMPLACEMARK:false;KMATTR:false');
            assert.equal(p.get('propertyName'), 'gid,the_geom');
            return response(kml(p.get('CQL_FILTER') === 'gid = 42' ? '' : mark()));
        } });
        const first = await adapter.queryIds([id(5532)]);
        const second = await adapter.queryIds([id(5532)]);
        assert.equal(calls.length, 2); assert.equal(calls[0].get('CQL_FILTER'), 'gid = 5532');
        assert.deepEqual(first.features[0].geometry, { type: 'Polygon', coordinates: [shell, hole] });
        assert.deepEqual(first, second); assert.equal(first.features[0].id, id(5532));
        assert.deepEqual(first.features[0].properties.sourceProperties, { gid: '5532' });
        assert.equal(first.complete, true); assert.deepEqual(first.absentIds, []);
        const absent = await adapter.queryIds([id(42)]);
        assert.deepEqual(absent.features, []); assert.deepEqual(absent.absentIds, [id(42)]);
        await assert.rejects(adapter.queryIds([id('5532 OR 1=1')]));
        assert.equal(calls.length, 3);
    });
}

test('browser uses a bounded source operation; the relay performs fresh, pinned live protocol reads', async () => {
    const upstream = [], browserCalls = [];
    const browser = browserParcelFactories['corrientes-wms'](descriptor, { fetchImpl: async (url, options) => {
        browserCalls.push({ url, options });
        const validated = validateParcelProviderRelayRequest(CORRIENTES_SOURCE,
            { url, method: options.method, headers: options.headers, body: options.body }, { sources: [descriptor] });
        assert.equal(validated.timeoutMs, 60000);
        return fetchParcelProviderRelay(validated, { caFetchFactory: () => async (url, init) => {
            const p = new URL(url).searchParams; upstream.push(p);
            assert.equal(init.credentials, 'omit');
            if (p.get('request') === 'GetFeatureInfo') return response(JSON.stringify({ type: 'FeatureCollection',
                features: [{ properties: { gid: 5532 }, geometry: null }] }));
            return response(kml(mark()));
        } });
    } });
    const bounds = await browser.queryBounds([-58.8119,-27.4834,-58.8111,-27.48305]);
    assert.equal(browserCalls.length, 1); assert.equal(upstream.length, 2);
    assert.deepEqual(bounds.features[0].geometry.coordinates, [shell, hole]);
    const one = await browser.queryIds([id(5532)]), two = await browser.queryIds([id(5532)]);
    assert.deepEqual(one, two); assert.equal(upstream.length, 4); assert.equal(browserCalls.length, 3);
    assert.equal(browserCalls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(browserCalls[1].options.body), { _corrientesOperation: 'queryIds', input: [id(5532)] });
    for (const body of [{ _corrientesOperation: 'queryIds', input: [id('1 OR 1=1')] },
        { _corrientesOperation: 'unknown', input: [] }, { _corrientesOperation: 'queryIds', input: [], extra: true }]) {
        assert.throws(() => validateParcelProviderRelayRequest(CORRIENTES_SOURCE,
            { url: CORRIENTES_ENDPOINT, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            { sources: [descriptor] }));
    }
    assert.equal(upstream.length, 4);
});

test('bounds discover only safe gids in fixed small frames, then use exact full geometry reads', async () => {
    const calls = [];
    const adapter = createCorrientesWmsSource(descriptor, { fetchImpl: async url => {
        const p = new URL(url).searchParams; calls.push(p);
        if (p.get('request') === 'GetMap') return response(kml(mark()));
        assert.equal(p.get('propertyName'), 'gid'); assert.equal(p.get('width'), '16');
        assert.equal(p.get('height'), '16'); assert.equal(p.get('buffer'), '16');
        assert.equal(p.get('feature_count'), '501'); assert.match(p.get('CQL_FILTER'), /^BBOX\(the_geom,/);
        return response(JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { gid: 5532 }, geometry: null }] }));
    } });
    const bounds = [-58.8119,-27.4834,-58.8111,-27.48305];
    const read = await adapter.queryBounds(bounds);
    assert.equal(calls.length, 2); assert.equal(read.features[0].id, id(5532));
    assert.deepEqual(read.features[0].geometry.coordinates, [shell, hole]); assert.equal(read.complete, true);
    assert.equal(calls[1].get('CQL_FILTER'), 'gid = 5532');
    await assert.rejects(adapter.queryBounds([-58.9,-27.6,-58.7,-27.4]));
});

test('reject duplicate gid responses, popup attributes, indirect KML and unbounded bodies', async () => {
    for (const body of [kml(mark() + mark()), kml(mark('<description>unexpected popup</description>')),
        kml(mark('<ExtendedData/>')), kml('<NetworkLink/>'), '<not-kml/>']) {
        const adapter = createCorrientesWmsSource(descriptor, { fetchImpl: async () => response(body) });
        await assert.rejects(adapter.queryIds([id(5532)]));
    }
    let cancelled = false;
    const adapter = createCorrientesWmsSource(descriptor, { maxResponseBytes: 1024, fetchImpl: async () =>
        new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(2048)); },
            cancel() { cancelled = true; } })) });
    await assert.rejects(adapter.queryIds([id(5532)])); assert.equal(cancelled, true);
});

test('a saturated manifest or unexpected property fails instead of claiming completeness', async () => {
    for (const features of [Array.from({ length: 501 }, (_, gid) => ({ properties: { gid: gid + 1 } })),
        [{ properties: { gid: 5532, unexpected: 'discarded' } }], [{ properties: { gid: 5532 } }, { properties: { gid: 5532 } }]]) {
        let calls = 0;
        const adapter = createCorrientesWmsSource(descriptor, { fetchImpl: async () => {
            calls++; return response(JSON.stringify({ type: 'FeatureCollection', features }));
        } });
        await assert.rejects(adapter.queryBounds([-58.8119,-27.4834,-58.8111,-27.48305]));
        assert.equal(calls, 1);
    }
});
