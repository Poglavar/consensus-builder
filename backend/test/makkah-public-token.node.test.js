// Verify anonymous Makkah access, bounded relay scope, and unchanged straight parcel geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { createMakkahPublicFetch, MAKKAH_CONFIG, MAKKAH_LAYER, MAKKAH_VIEWER } from '../parcels/makkah-public-fetch.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: 'sa-makkah-municipality-mmsdi-regulatory-parcels', adapter: 'arcgis',
    endpoint: MAKKAH_LAYER, publicTokenUrl: MAKKAH_CONFIG, idPrefix: 'SA-MAKKAH-PARCEL-',
    idField: 'PARCEL_KEY', objectIdField: 'OBJECTID', outFields: ['PARCEL_KEY', 'OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'esri-json',
    returnTrueCurves: true, maxResponseBytes: 16777216, pageSize: 100 };
const json = value => new Response(JSON.stringify(value));
const config = () => {
    let encoded = encodeURIComponent(JSON.stringify({ tokens: [{ needed: true,
        server: `${MAKKAH_VIEWER}arcgis/rest/services`, token: 'anonymous-viewer-test' }] }));
    for (let i = 0; i < 3; i++) encoded = btoa(encoded);
    return new Response(encoded);
};
const rings = [[[39.823,21.414],[39.823,21.415],[39.824,21.415],[39.824,21.414],[39.823,21.414]]];

test('backend and browser ArcGIS factories read unchanged polygons with one public config per adapter', async () => {
    for (const factory of [createArcgisParcelSource, browserParcelFactories.arcgis]) {
        let configs = 0, geometries = 0;
        const source = factory(descriptor, { fetchImpl: async (input, init) => {
            assert.equal(init.credentials, 'omit');
            assert.equal(new Headers(init.headers).get('referer'), MAKKAH_VIEWER);
            if (input === MAKKAH_CONFIG) {
                configs++;
                assert.equal(init.method, 'POST');
                assert.equal(init.body, '');
                return config();
            }
            const params = new URL(input).searchParams;
            assert.equal(params.get('token'), 'anonymous-viewer-test');
            if (params.get('returnCountOnly') === 'true') return json({ count: 1 });
            if (params.get('returnIdsOnly') === 'true') return json({ objectIdFieldName: 'OBJECTID', objectIds: [7] });
            assert.equal(params.get('outFields'), 'PARCEL_KEY,OBJECTID');
            geometries++;
            assert.equal(params.get('returnTrueCurves'), 'true');
            return json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
                features: [{ attributes: { PARCEL_KEY: 808595295, OBJECTID: 7 }, geometry: { rings } }] });
        } });
        const first = await source.queryIds(['SA-MAKKAH-PARCEL-808595295']);
        const second = await source.queryIds(['SA-MAKKAH-PARCEL-808595295']);
        assert.equal(configs, 1);
        assert.equal(geometries, 2);
        assert.equal(first.complete, true);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features[0].geometry, { type: 'Polygon', coordinates: rings });
    }
});

test('public token renews once on explicit expiry and never leaves the pinned layer', async () => {
    let configs = 0, reads = 0;
    const fetch = createMakkahPublicFetch(async input => {
        if (input === MAKKAH_CONFIG) { configs++; return config(); }
        reads++;
        return json({ error: { code: 498 } });
    }, descriptor);
    await assert.rejects(fetch('https://example.test/query'));
    assert.equal(configs, 0);
    assert.equal((await (await fetch(`${MAKKAH_LAYER}/query`)).json()).error.code, 498);
    assert.equal(configs, 2);
    assert.equal(reads, 2);
    assert.throws(() => createMakkahPublicFetch(() => {}, { ...descriptor, endpoint: 'https://example.test/' }));
});

test('relay accepts only empty anonymous config POST and the official referer', () => {
    const input = { url: MAKKAH_CONFIG, method: 'POST', body: '',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: MAKKAH_VIEWER } };
    const validate = value => validateParcelProviderRelayRequest(descriptor.id, value, { sources: [descriptor] });
    assert.doesNotThrow(() => validate(input));
    assert.throws(() => validate({ ...input, method: 'GET', body: undefined }));
    assert.throws(() => validate({ ...input, body: 'credentials=anything' }));
    assert.throws(() => validate({ ...input, url: `${MAKKAH_CONFIG}&extra=1` }));
    assert.throws(() => validate({ ...input, url: `${MAKKAH_VIEWER}Data/HashKey2` }));
    assert.throws(() => validate({ ...input, headers: { ...input.headers, Referer: 'https://example.test/' } }));
});

test('oversized streamed parcel responses reject promptly and malformed config is not used', async () => {
    const fetch = createMakkahPublicFetch(async input => input === MAKKAH_CONFIG ? config()
        : new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(' '.repeat(100)));
            controller.close();
        } })), { ...descriptor, maxResponseBytes: 32 });
    await assert.rejects(fetch(`${MAKKAH_LAYER}/query`), /invalid parcel response/);
    let queries = 0;
    const invalid = createMakkahPublicFetch(async input => {
        if (input === MAKKAH_CONFIG) return new Response('invalid-config');
        queries++;
        return json({});
    }, descriptor);
    await assert.rejects(invalid(`${MAKKAH_LAYER}/query`), /invalid public configuration/);
    assert.equal(queries, 0);
});

test('true curves fail explicitly, without flattening or silently dropping records', async () => {
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async input => {
        if (input === MAKKAH_CONFIG) return config();
        if (new URL(input).searchParams.get('returnCountOnly') === 'true') return json({ count: 1 });
        if (new URL(input).searchParams.get('returnIdsOnly') === 'true') return json({ objectIdFieldName: 'OBJECTID', objectIds: [7] });
        return json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
            features: [{ attributes: { PARCEL_KEY: 808595295, OBJECTID: 7 },
                geometry: { curveRings: [[[39.823,21.414], { c: [[39.824,21.415],[39.823,21.415]] }, [39.823,21.414]]] } }] });
    } });
    await assert.rejects(source.queryIds(['SA-MAKKAH-PARCEL-808595295']), { code: 'parcel-source-geometry-unsupported' });
});
