// Check GISAR exact identity, full geometry, bounded WMS scales and the pinned HTTP relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import proj4 from 'proj4';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { GISAR_ENDPOINT, GISAR_SOURCE_ID, createGisarWmsParcelSource, isGisarParcelUrl } from '../parcels/kg-gisar-wms-source.js';
import { createProviderRelayFetch, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const code = '1-01-13-0013-0671', id = `KG-GISAR-ENI-CODE-${code}`;
const descriptor = { id: GISAR_SOURCE_ID, adapter: 'kg-gisar-wms', endpoint: GISAR_ENDPOINT,
    layer: 'Участки ЕНИ', idField: 'propcode', outFields: ['propcode'], idPrefix: 'KG-GISAR-ENI-CODE-' };
const geometry = { type: 'MultiPolygon', coordinates: [[
    [[8302690,5292190],[8302740,5292190],[8302740,5292240],[8302690,5292240],[8302690,5292190]],
    [[8302700,5292200],[8302700,5292210],[8302710,5292210],[8302710,5292200],[8302700,5292200]]
]] };
const fixture = () => ({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:3857' } },
    features: [{ type: 'Feature', geometry: structuredClone(geometry), properties: { 'Код ЕНИ': code, incidental: 'discard' } }] });
const response = payload => new Response(JSON.stringify(payload));

test('both factories independently fetch native codes and retain full rings through standard projection', async () => {
    const calls = [], fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return response(fixture()); };
    const first = await createParcelSource(descriptor, { fetchImpl }).queryIds([id]);
    const second = await browserParcelFactories['kg-gisar-wms'](descriptor, { fetchImpl }).queryIds([id]);
    assert.equal(calls.length, 2);
    assert.deepEqual(first, second);
    assert.deepEqual(first.absentIds, []);
    assert.equal(first.complete, true);
    assert.equal(first.features[0].id, id);
    assert.deepEqual(first.features[0].properties.sourceProperties, { propcode: code });
    const expected = geometry.coordinates.map(polygon => polygon.map(ring => ring.map(xy => proj4('EPSG:3857', 'EPSG:4326', xy))));
    assert.deepEqual(first.features[0].geometry, { type: 'MultiPolygon', coordinates: expected });
    for (const { url, init } of calls) {
        assert.equal(url.searchParams.get('FILTER'), `Участки ЕНИ:"propcode" IN ( '${code}' )`);
        for (const key of ['BBOX','I','J','X','Y','WMS_PRECISION','PROPERTYNAME']) assert.equal(url.searchParams.has(key), false);
        assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
        assert.equal(isGisarParcelUrl(url), true);
    }
});

test('bounds enumerate a scale-safe envelope without pixels, retaining complete intersecting polygons', async () => {
    const calls = [], source = createGisarWmsParcelSource(descriptor, { fetchImpl: async url => { calls.push(new URL(url)); return response(fixture()); } });
    const a = proj4('EPSG:3857','EPSG:4326',[8302691,5292191]), b = proj4('EPSG:3857','EPSG:4326',[8302692,5292192]);
    const result = await source.queryBounds([...a,...b]);
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].geometry.coordinates[0][0].length, 5);
    assert.equal(result.features[0].geometry.coordinates[0].length, 2);
    const params = calls[0].searchParams, envelope = params.get('BBOX').split(',').map(Number);
    assert.equal(envelope[2] - envelope[0], 16); assert.equal(envelope[3] - envelope[1], 16);
    assert.equal(params.get('WIDTH'), '128'); assert.equal(params.has('I'), false);
    assert.match(params.get('FILTER'), /LIKE '_-__-__-____-____'/);
    assert.equal(isGisarParcelUrl(calls[0]), true);
    await assert.rejects(source.queryBounds([74.5,42.8,74.6,42.9]), { status: 400 });
    // QGIS legitimately returns candidates outside the requested envelope (aed8a6269): they are
    // filtered by the exact full-polygon scope, not treated as a provider failure.
    assert.deepEqual((await source.queryBounds([75,43,75.001,43.001])).features, []);
});

test('fail closed on mismatched, duplicate, partial, truncated or malformed native parcels', async () => {
    for (const mutate of [p => { p.features[0].properties['Код ЕНИ'] = '1-01'; },
        p => { p.features[0].properties['Код ЕНИ'] = '1-01-13-0013-0001'; },
        p => { p.features.push(p.features[0]); }, p => { p.crs.properties.name = 'EPSG:4326'; },
        p => { p.features[0].geometry.coordinates[0][0].pop(); }, p => { p.features[0].geometry.coordinates[0][0][0][0] = Infinity; }]) {
        const payload = fixture(); mutate(payload);
        await assert.rejects(createGisarWmsParcelSource(descriptor, { fetchImpl: async () => response(payload) }).queryIds([id]), { status: 502 });
    }
    let calls = 0;
    const source = createGisarWmsParcelSource(descriptor, { fetchImpl: async () => { calls++; return response(fixture()); } });
    for (const ids of [[id + "' OR 1=1"], ['KG-GISAR-ENI-CODE-1-01'], [1], Array(81).fill(id)]) await assert.rejects(source.queryIds(ids), { status: 400 });
    assert.equal(calls, 0);
    const empty = await createGisarWmsParcelSource(descriptor, { fetchImpl: async () => response({ type: 'FeatureCollection', features: [] }) }).queryIds([id]);
    assert.deepEqual(empty.absentIds, [id]);
    await assert.rejects(createGisarWmsParcelSource(descriptor, { maxResponseBytes: 1024, fetchImpl: async () => new Response(' '.repeat(1025)) }).queryIds([id]), { status: 502 });
    await assert.rejects(createGisarWmsParcelSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) }).queryIds([id]), { upstreamStatus: 403 });
});

test('HTTP relay accepts only the fixed GISAR read contract and rejects changed projects or private DNS', async () => {
    let url;
    await createGisarWmsParcelSource(descriptor, { fetchImpl: async value => { url = new URL(value); return response(fixture()); } }).queryIds([id]);
    const validate = value => validateParcelProviderRelayRequest(descriptor.id, { url: value.href }, { sources: [descriptor] });
    assert.equal(validate(url).target.href, url.href);
    for (const change of [u => u.searchParams.set('MAP','other.qgz'), u => u.searchParams.set('REQUEST','GetMap'),
        u => u.searchParams.set('QUERY_LAYERS','Здания ЕНИ'), u => u.searchParams.set('FEATURE_COUNT','100000'),
        u => u.searchParams.set('FILTER','1=1'), u => u.searchParams.append('MAP','duplicate'),
        u => { u.hostname = 'example.com'; }, u => { u.hash = '#x'; }]) {
        const changed = new URL(url); change(changed);
        assert.equal(isGisarParcelUrl(changed), false); assert.throws(() => validate(changed), { status: 403 });
    }
    assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url: url.href, method: 'POST', body: '{}' }, { sources: [descriptor] }), { status: 400 });
    await assert.rejects(createProviderRelayFetch({ lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] })(url), { status: 403 });
    const calls = [];
    const httpRequestImpl = (options, callback) => {
        calls.push(options);
        const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = {};
        return Object.assign(new EventEmitter(), { destroy() { incoming.destroy(); }, end() { callback(incoming); incoming.end('{}'); } });
    };
    const fetch = createProviderRelayFetch({ lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], httpRequestImpl,
        requestImpl() { throw new Error('Wrong HTTPS transport'); } });
    assert.equal(await (await fetch(url)).text(), '{}');
    assert.equal(calls[0].protocol, 'http:'); assert.equal(calls[0].port, 80);
    await assert.rejects(fetch(new URL('http://example.com/')), { status: 400 });
});
