// Lock GeoMOLG's safe OBJECTID queries and unchanged XYZ polygons in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'ps-geomolg-parcelsregistered-11', adapter: 'arcgis',
    endpoint: 'https://orthophotos.geomolg.ps/adaptor/rest/services/ParcelsRegistered_11/MapServer/0',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'PS-GEOMOLG-PARCELSREGISTERED11-OBJECTID-', outFields: ['OBJECTID'],
    queryFormat: 'geojson', boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    maxResponseBytes: 16777216, pageSize: 2000
};
// Synthetic XYZ geometry, including a hole: no additional provider polygons are retained here.
const geometry = { type: 'Polygon', coordinates: [
    [[34.469,31.521,0],[34.470,31.521,0],[34.470,31.522,0],[34.469,31.522,0],[34.469,31.521,0]],
    [[34.4692,31.5212,0],[34.4692,31.5214,0],[34.4694,31.5214,0],[34.4694,31.5212,0],[34.4692,31.5212,0]]
] };
const parcelId = descriptor.idPrefix + '492653';

function provider({ incomplete = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        assert.equal(params.get('outFields'), 'OBJECTID');
        calls.push(params);
        let result;
        if (params.get('returnCountOnly') === 'true') result = { count: 1 };
        else if (params.get('returnIdsOnly') === 'true') result = {
            objectIdFieldName: 'OBJECTID', objectIds: incomplete ? [] : [492653]
        };
        else {
            assert.equal(params.get('objectIds'), '492653');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('returnGeometry'), 'true');
            for (const key of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) {
                assert.equal(params.has(key), false);
            }
            result = { type: 'FeatureCollection', features: [
                { type: 'Feature', properties: { OBJECTID: 492653 }, geometry }
            ] };
        }
        return new Response(JSON.stringify(result), { status: 200 });
    };
    return { calls, fetchImpl };
}

test('backend and browser repeat exact native IDs with identical complete XYZ geometry', async () => {
    const { calls, fetchImpl } = provider();
    const backend = createParcelSource(descriptor, { fetchImpl });
    const browser = browserParcelFactories.arcgis(descriptor, { fetchImpl });
    const first = await backend.queryIds([parcelId]);
    const second = await browser.queryIds([parcelId]);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(second, first);
    assert.equal(first.features[0].id, parcelId);
    assert.equal(first.features[0].properties.sourceParcelId, '492653');
    assert.deepEqual(first.features[0].properties.sourceProperties, { OBJECTID: 492653 });
    assert.deepEqual(first.features[0].geometry, geometry);
    assert.equal(calls.length, 6);
    assert.equal(calls[0].get('where'), 'OBJECTID IN (492653)');
});

test('browser bounds request uses WGS84 envelopes and retains full intersecting geometry', async () => {
    const { calls, fetchImpl } = provider();
    const bounds = [34.4693,31.5213,34.4695,31.5215];
    const result = await browserParcelFactories.arcgis(descriptor, { fetchImpl }).queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(calls[0].get('geometry'), bounds.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
});

test('a missing manifest cannot turn an observed parcel into complete absence', async () => {
    const { fetchImpl } = provider({ incomplete: true });
    await assert.rejects(createParcelSource(descriptor, { fetchImpl }).queryIds([parcelId]), /object-ID list/);
});

test('foreign IDs and SQL fragments fail before any provider request', async () => {
    const { calls, fetchImpl } = provider();
    const source = createParcelSource(descriptor, { fetchImpl });
    await assert.rejects(source.queryIds(['OTHER-492653']), /different source/);
    await assert.rejects(source.queryIds([descriptor.idPrefix + '492653 OR 1=1']), /Invalid parcel ID/);
    assert.equal(calls.length, 0);
});
