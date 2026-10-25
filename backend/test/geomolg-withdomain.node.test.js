import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

// Synthetic geometry exercises GeoMOLG's published 3-value tuple contract without
// retaining another copy of live parcel samples in the repository.
const descriptor = {
    id: 'ps-molg-geomolg-parcelsregistered-withdomain', adapter: 'arcgis',
    endpoint: 'https://orthophotos.geomolg.ps/adaptor/rest/services/ParcelsRegistered_Withdomain/MapServer/0',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'PS-GEOMOLG-WITHDOMAIN-OBJECTID-', outFields: ['OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', queryFormat: 'geojson', pageSize: 1
};
const ring = [[35.22, 31.81, 0], [35.2201, 31.81, 0], [35.2201, 31.8101, 0], [35.22, 31.81, 0]];
const rows = [
    { type: 'Feature', properties: { OBJECTID: 72153 }, geometry: { type: 'Polygon', coordinates: [ring] } },
    { type: 'Feature', properties: { OBJECTID: 72854 }, geometry: { type: 'MultiPolygon', coordinates: [[ring]] } }
];
const ids = rows.map(row => descriptor.idPrefix + row.properties.OBJECTID);

function provider({ wrongCount = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        assert.equal(params.get('outFields'), 'OBJECTID');
        for (const option of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) {
            assert.equal(params.has(option), false);
        }
        const requested = params.get('objectIds')?.split(',').map(Number);
        const selected = requested ? rows.filter(row => requested.includes(row.properties.OBJECTID)) : rows;
        const body = params.get('returnCountOnly') === 'true' ? { count: selected.length + Number(wrongCount) }
            : params.get('returnIdsOnly') === 'true'
                ? { objectIdFieldName: null, objectIds: selected.map(row => row.properties.OBJECTID) }
                : { type: 'FeatureCollection', features: selected, exceededTransferLimit: false };
        if (params.get('returnGeometry') === 'true') {
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(requested.length, 1);
        }
        return Response.json(body);
    };
    return { calls, fetchImpl };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`GeoMOLG ${name} keeps full 3D geometry and native identity across exact and bounds reads`, async () => {
        const { calls, fetchImpl } = provider();
        const source = factory(descriptor, { fetchImpl });
        for (const result of [await source.queryIds(ids), await source.queryIds(ids),
            await source.queryBounds([35.2199, 31.8099, 35.2202, 31.8102])]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(feature => feature.id), ids);
            for (const [index, feature] of result.features.entries()) {
                assert.deepEqual(feature.geometry, rows[index].geometry);
                assert.equal(feature.properties.sourceId, descriptor.id);
                assert.equal(feature.properties.sourceParcelId, String(rows[index].properties.OBJECTID));
                assert.deepEqual(feature.properties.sourceProperties, rows[index].properties);
            }
        }
        assert.equal(calls.some(params => params.get('returnIdsOnly') === 'true'), true);
    });
}

test('GeoMOLG count/manifest disagreement fails instead of publishing partial polygons', async () => {
    const { calls, fetchImpl } = provider({ wrongCount: true });
    const source = createParcelSource(descriptor, { fetchImpl });
    await assert.rejects(source.queryIds(ids), /object-ID list/);
    assert.equal(calls.some(params => params.get('returnGeometry') === 'true'), false);
});
