// Exercise Tabuk's GEOSA offset transport in backend and browser factories without live requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { GEOSA_SOURCE_ID, GEOSA_ENDPOINT, GEOSA_REFERER } from '../parcels/geosa-transport.js';

const descriptor = {
    id: GEOSA_SOURCE_ID, endpoint: GEOSA_ENDPOINT, adapter: 'arcgis',
    idPrefix: 'SAU-GEOSA-NDM-LANDPARCEL-', idField: 'SUBDIVPARCEL_UNIFIED_ID',
    idType: 'string', idPattern: '^[0-9]{17}$', objectIdField: 'OBJECTID',
    outFields: ['OBJECTID', 'SUBDIVPARCEL_UNIFIED_ID'],
    boundsQueryMode: 'offset', idsQueryMode: 'offset', queryFormat: 'geojson',
    pageSize: 1, maxFeatures: 3, maxBboxKm2: 1, maxResponseBytes: 16777216
};
const bounds = [36.556, 28.401, 36.559, 28.404];
// Synthetic rings (including a hole) test preservation, and are never qualification evidence.
const geometry = { type: 'Polygon', coordinates: [
    [[36.558, 28.402], [36.5582, 28.402], [36.5582, 28.4022], [36.558, 28.4022], [36.558, 28.402]],
    [[36.55805, 28.40205], [36.55805, 28.4021], [36.5581, 28.4021], [36.5581, 28.40205], [36.55805, 28.40205]]
] };
const nativeIds = ['00701400226000006', '00701400226000007'];
const ids = nativeIds.map(id => descriptor.idPrefix + id);

function provider({ endless = false } = {}) {
    const calls = [];
    return { calls, fetchImpl: async (input, init) => {
        const url = new URL(input), params = url.searchParams;
        assert.equal(url.origin + url.pathname, GEOSA_ENDPOINT + '/query');
        assert.equal(new Headers(init.headers).get('referer'), GEOSA_REFERER);
        assert.equal(params.get('outFields'), 'OBJECTID,SUBDIVPARCEL_UNIFIED_ID');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('returnGeometry'), 'true');
        assert.equal(params.get('f'), 'geojson');
        assert.equal(params.get('orderByFields'), 'OBJECTID');
        assert.equal(params.get('resultRecordCount'), '1');
        calls.push(params);
        const spatial = params.has('geometry'), offset = Number(params.get('resultOffset'));
        const index = spatial ? offset : 0;
        return new Response(JSON.stringify({ type: 'FeatureCollection',
            exceededTransferLimit: endless || (spatial && offset === 0),
            features: [{ type: 'Feature', properties: {
                OBJECTID: index + 1, SUBDIVPARCEL_UNIFIED_ID: nativeIds[index % 2]
            }, geometry }] }));
    } };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Tabuk pages WGS84 envelopes and repeats exact string-ID reads without changing rings`, async () => {
        const mock = provider(), source = factory(descriptor, mock);
        const viewport = await source.queryBounds(bounds);
        assert.equal(viewport.complete, true);
        assert.deepEqual(viewport.features.map(f => f.id), ids);
        assert.deepEqual(mock.calls.map(p => p.get('resultOffset')), ['0', '1']);
        for (const params of mock.calls) {
            assert.equal(params.get('geometry'), bounds.join(','));
            assert.equal(params.get('geometryType'), 'esriGeometryEnvelope');
            assert.equal(params.get('inSR'), '4326');
            assert.equal(params.get('spatialRel'), 'esriSpatialRelIntersects');
        }
        const first = await source.queryIds([ids[0]]), second = await source.queryIds([ids[0]]);
        assert.deepEqual(first, second);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(f => f.id), [ids[0]]);
        assert.equal(first.features[0].properties.sourceParcelId, nativeIds[0]);
        for (const feature of [...viewport.features, ...first.features, ...second.features]) {
            assert.deepEqual(feature.geometry, geometry);
        }
        assert.equal(mock.calls.length, 4);
        for (const params of mock.calls.slice(2)) {
            assert.equal(params.get('where'), "SUBDIVPARCEL_UNIFIED_ID IN ('00701400226000006')");
            assert.equal(params.has('geometry'), false);
        }
        await assert.rejects(source.queryIds([descriptor.idPrefix + '701400226000006']), /Invalid parcel ID/);
        assert.equal(mock.calls.length, 4);
    });

    test(`${name}: Tabuk rejects truncated pages and streamed responses over the byte cap`, async () => {
        await assert.rejects(factory({ ...descriptor, maxFeatures: 1 }, provider({ endless: true }))
            .queryBounds(bounds), { code: 'parcel-source-area-limit', status: 422 });
        await assert.rejects(factory({ ...descriptor, maxResponseBytes: 32 }, provider())
            .queryIds([ids[0]]), /byte limit/);
    });
}
