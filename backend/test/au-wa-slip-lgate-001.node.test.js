// Checks Landgate's discovery-bound query endpoint and complete native-OID transport in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'au-wa-slip-lgate-001-cadastre', adapter: 'arcgis',
    endpoint: 'https://token.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Property_and_Planning/MapServer/2/query',
    idField: 'objectid', objectIdField: 'objectid',
    idPrefix: 'au-wa-slip-lgate-001-cadastre:objectid:', outFields: ['objectid'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson',
    pageSize: 1, maxFeatures: 100, maxBboxKm2: 25, maxResponseBytes: 16777216
};
// Synthetic geometry; no additional provider polygons are retained by this test.
const geometry = { type: 'Polygon', coordinates: [
    [[115.856, -31.931], [115.857, -31.931], [115.857, -31.930], [115.856, -31.930], [115.856, -31.931]]
] };
const parcelId = descriptor.idPrefix + '1356563';

function provider(factory, { incomplete = false, truncated = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        assert.equal(params.get('outFields'), 'objectid');
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: 1 };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'objectid', objectIds: incomplete ? [] : [1356563]
        };
        else {
            assert.equal(params.get('objectIds'), '1356563');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnGeometry'), 'true');
            for (const field of ['resultRecordCount', 'resultOffset', 'orderByFields', 'geometryPrecision', 'maxAllowableOffset']) {
                assert.equal(params.has(field), false);
            }
            payload = { type: 'FeatureCollection', features: [
                { type: 'Feature', properties: { objectid: 1356563 }, geometry }
            ], exceededTransferLimit: truncated };
        }
        return new Response(JSON.stringify(payload), { status: 200 });
    };
    return { calls, source: factory(descriptor, { fetchImpl }) };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: exact OID reads retain complete unchanged polygons at the receipt endpoint`, async () => {
        const { source, calls } = provider(factory);
        const first = await source.queryIds([parcelId]);
        const second = await source.queryIds([parcelId]);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => row.id), [parcelId]);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(second.features, first.features);
        assert.equal(first.features[0].properties.sourceParcelId, '1356563');
        assert.deepEqual(first.features[0].properties.sourceProperties, { objectid: 1356563 });
        assert.equal(calls.length, 6);
        assert.equal(calls[0].get('where'), 'objectid IN (1356563)');
    });

    test(`${runtime}: viewport counts and manifests guard against false completeness`, async () => {
        const { source, calls } = provider(factory);
        const bounds = [115.8561, -31.931, 115.85613, -31.93095];
        const result = await source.queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.equal(calls[0].get('geometry'), bounds.join(','));
        assert.equal(calls[0].get('inSR'), '4326');
        assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
        await assert.rejects(provider(factory, { incomplete: true }).source.queryBounds(bounds), /object-ID list/);
        await assert.rejects(provider(factory, { truncated: true }).source.queryIds([parcelId]), /truncated|incomplete|transfer/i);
    });

    test(`${runtime}: foreign and malformed OIDs fail before provider access`, async () => {
        const { source, calls } = provider(factory);
        for (const id of ['OTHER-1356563', descriptor.idPrefix + "1 OR 1=1", descriptor.idPrefix + '-1']) {
            await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
        }
        assert.equal(calls.length, 0);
    });
}
