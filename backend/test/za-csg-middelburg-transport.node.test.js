// Exercises the reviewed DFFE Middelburg source with full safe first-party polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-middelburg-safe-polygons.json', import.meta.url)));
const descriptor = {
    id: 'za-csg-dffe-erven', adapter: 'arcgis',
    endpoint: 'https://dffeportal.environment.gov.za/hosting/rest/services/CSG_Cadaster/CSG_Cadastral_Data/MapServer/2',
    idPrefix: 'ZA-CSG-DFFE-ERVEN-', idField: 'PRCL_KEY', objectIdField: 'OBJECTID',
    idType: 'string', idPattern: '^[A-Z0-9]{26}$', outFields: ['OBJECTID', 'PRCL_KEY'],
    queryFormat: 'esri-json', boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    pageSize: 1000, maxFeatures: 2000, maxBboxKm2: 2, idBatchSize: 80
};
const ids = fixture.features.map(row => descriptor.idPrefix + row.attributes.PRCL_KEY);

function source({ pageSize = 1000, oidShift = 0 } = {}) {
    const calls = [];
    const rows = structuredClone(fixture.features);
    for (const row of rows) row.attributes.OBJECTID += oidShift;
    const adapter = createParcelSource({ ...descriptor, pageSize }, { fetchImpl: async (url, init) => {
        const params = init?.method === 'POST' ? new URLSearchParams(init.body) : new URL(url).searchParams;
        assert.equal(new URL(url).pathname, new URL(descriptor.endpoint).pathname + '/query');
        assert.equal(params.has('geometry'), false); // Exact IDs must return whole polygons.
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true' || params.get('returnIdsOnly') === 'true') {
            assert.match(params.get('where'), /^PRCL_KEY IN \(/);
            for (const row of rows) assert.ok(params.get('where').includes("'" + row.attributes.PRCL_KEY + "'"));
            payload = params.get('returnCountOnly') === 'true' ? { count: rows.length }
                : { objectIdFieldName: 'OBJECTID', objectIds: rows.map(row => row.attributes.OBJECTID).reverse() };
        } else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('returnTrueCurves'), 'true');
            assert.equal(params.get('outSR'), '4326');
            for (const key of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) assert.equal(params.has(key), false);
            const requested = params.get('objectIds').split(',').map(Number);
            assert.ok(requested.length <= pageSize);
            payload = { ...fixture, features: rows.filter(row => requested.includes(row.attributes.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } });
    return { adapter, calls };
}

test('Middelburg exact reads preserve four district polygons across OID changes and forced single-object pages', async () => {
    const normal = source(), forced = source({ pageSize: 1, oidShift: 5000000 });
    const first = await normal.adapter.queryIds(ids);
    const second = await forced.adapter.queryIds(ids);
    for (const result of [first, second]) {
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id).sort(), [...ids].sort());
        for (const feature of result.features) {
            const native = fixture.features.find(row => row.attributes.PRCL_KEY === feature.properties.sourceParcelId);
            assert.equal(feature.properties.sourceId, descriptor.id);
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: native.geometry.rings });
        }
    }
    assert.equal(normal.calls.length, 3);
    assert.equal(forced.calls.length, 6);
});
