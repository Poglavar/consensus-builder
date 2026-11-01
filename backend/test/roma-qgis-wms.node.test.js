// Exercise QGIS WMS filter semantics, native identities, unchanged holes and fail-closed reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createRomaQgisWmsSource } from '../parcels/roma-qgis-wms-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/roma-qgis-wms-safe.json', import.meta.url)));
const descriptor = { id: 'it-roma-metropolitana-sit-cadastral-parcels', adapter: 'roma-qgis-wms',
    endpoint: 'https://g3w-suite.cittametropolitanaroma.it/ows/19/qdjango/224/',
    layer: 'Catasto_Totale_0f4af963_a62b_449a_9d28_6f37d9826dc8',
    idField: 'id', idPrefix: 'IT-ROMA-SIT-', outFields: ['id'] };
const id = descriptor.idPrefix + fixture.features[0].id;
const response = payload => new Response(JSON.stringify(payload));

test('backend and browser factories reread the exact native gid without spatial/pixel restriction', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return response(fixture); };
    const first = await createParcelSource(descriptor, { fetchImpl }).queryIds([id]);
    const second = await browserParcelFactories['roma-qgis-wms'](descriptor, { fetchImpl }).queryIds([id]);
    assert.equal(calls.length, 2);
    assert.deepEqual(first, second);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.equal(first.features[0].id, id);
    assert.deepEqual(first.features[0].geometry, fixture.features[0].geometry);
    assert.equal(first.features[0].geometry.coordinates.length, 2);
    assert.deepEqual(first.features[0].properties.sourceProperties, { id: fixture.features[0].id });
    for (const { url, init } of calls) {
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.equal(url.searchParams.get('FILTER'), `${descriptor.layer}:"codice_comune" = 'H501' AND "tipo" = 'T' AND "gid" IN ( 13868058 )`);
        assert.equal(url.searchParams.get('SRS'), 'EPSG:4326');
        for (const key of ['BBOX', 'X', 'Y', 'WMS_PRECISION']) assert.equal(url.searchParams.has(key), false);
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
    }
});

test('bounds use WKT spatial intersection and return whole provider geometries', async () => {
    let params;
    const source = createRomaQgisWmsSource(descriptor, { fetchImpl: async url => {
        params = new URL(url).searchParams; return response(fixture);
    } });
    const result = await source.queryBounds([12.4545,41.9075,12.4555,41.9085]);
    assert.equal(params.get('FILTER_GEOM'), 'POLYGON((12.4545 41.9075,12.4555 41.9075,12.4555 41.9085,12.4545 41.9085,12.4545 41.9075))');
    assert.equal(params.has('BBOX'), false);
    assert.deepEqual(result.features[0].geometry, fixture.features[0].geometry);
    await assert.rejects(source.queryBounds([12.514,41.888,12.515,41.889]), { status: 502 });
});

test('exact responses must match the requested layer-qualified gid and land/municipality predicate', async () => {
    for (const change of [row => { row.id = descriptor.layer + '.100'; },
        row => { row.properties.Tipo = 'F'; }, row => { row.properties['Codice Comune'] = 'A001'; },
        row => { row.geometry.coordinates[0].pop(); }]) {
        const payload = structuredClone(fixture); change(payload.features[0]);
        await assert.rejects(createRomaQgisWmsSource(descriptor, { fetchImpl: async () => response(payload) }).queryIds([id]), { status: 502 });
    }
    const empty = createRomaQgisWmsSource(descriptor, { fetchImpl: async () => response({ type: 'FeatureCollection', features: [] }) });
    assert.deepEqual((await empty.queryIds([id])).absentIds, [id]);
    await assert.rejects(createRomaQgisWmsSource(descriptor, { fetchImpl: async () => response({ error: 'unavailable' }) }).queryIds([id]), { status: 502 });
});

test('rejects malformed inputs, duplicate/truncated responses, oversized bodies and upstream denials', async () => {
    let calls = 0;
    const source = createRomaQgisWmsSource(descriptor, { fetchImpl: async () => { calls++; return response(fixture); } });
    for (const ids of [[1], ['IT-ROMA-SIT-1'], [id + "' OR 1=1"], Array(81).fill(id)]) await assert.rejects(source.queryIds(ids), { status: 400 });
    await assert.rejects(source.queryBounds([12,41,13,42]), { status: 400 });
    assert.equal(calls, 0);
    const duplicate = { type: 'FeatureCollection', features: [fixture.features[0], fixture.features[0]] };
    await assert.rejects(createRomaQgisWmsSource(descriptor, { fetchImpl: async () => response(duplicate) }).queryIds([id]), { status: 502 });
    await assert.rejects(createRomaQgisWmsSource(descriptor, { maxResponseBytes: 1024,
        fetchImpl: async () => new Response(' '.repeat(1025)) }).queryIds([id]), { status: 502 });
    await assert.rejects(createRomaQgisWmsSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) }).queryIds([id]),
    { code: 'parcel-source-blocked', upstreamStatus: 403 });
});
