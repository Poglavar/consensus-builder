// Checks Mohadin's retained parcel references through the production ArcGIS adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-mohadin-safe.geojson', import.meta.url)));
const descriptor = {
    id: 'za-csg-csggis-property-viewer-erven', adapter: 'arcgis',
    endpoint: 'https://csggis.dlrrd.gov.za/server/rest/services/Property_Viewer/MapServer/2',
    idPrefix: 'ZA-CSG-CSGGIS-ERVEN-', idField: 'PRCL_KEY', objectIdField: 'OBJECTID',
    idType: 'string', idPattern: '^[A-Z0-9]{26}$', identityKind: 'native-key-geometry-sha256-v1',
    outFields: ['OBJECTID', 'PRCL_KEY'], queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    pageSize: 500, idBatchSize: 80, maxFeatures: 2000, maxBboxKm2: 2
};
const reference = row => descriptor.idPrefix + row.properties.PRCL_KEY + '-' + nativeGeometryHash(row.geometry);
const ids = fixture.features.map(reference);

function provider({ pageSize = 500, truncated = false, wrongCount = false } = {}) {
    const rows = structuredClone(fixture.features), requests = [];
    const source = createParcelSource({ ...descriptor, pageSize }, { fetchImpl: async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        requests.push(params);
        const keys = [...params.get('where').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.PRCL_KEY)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length + Number(wrongCount) };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID', objectIds: selected.map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            for (const key of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) assert.equal(params.has(key), false);
            const objectIds = params.get('objectIds').split(',').map(Number);
            assert.ok(objectIds.length <= pageSize);
            payload = { type: 'FeatureCollection', exceededTransferLimit: truncated,
                features: selected.filter(row => objectIds.includes(row.properties.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } });
    return { source, rows, requests };
}

test('Mohadin exact native-key/geometry references survive changed transport IDs and singleton paging', async () => {
    const first = provider(), second = provider({ pageSize: 1 });
    for (const row of second.rows) row.properties.OBJECTID += 100000;
    for (const instance of [first, second]) {
        const result = await instance.source.queryIds(ids);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(row => row.id).sort(), [...ids].sort());
        for (const feature of result.features) {
            const original = fixture.features.find(row => reference(row) === feature.id);
            assert.deepEqual(feature.geometry, original.geometry);
            assert.equal(feature.properties.sourceId, descriptor.id);
            assert.equal(feature.properties.sourceNativeParcelId, original.properties.PRCL_KEY);
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
        }
    }
    assert.equal(first.requests.length, 3);
    assert.equal(second.requests.length, 5);
});

test('Mohadin incomplete manifests and truncated source geometry fail closed', async () => {
    await assert.rejects(provider({ wrongCount: true }).source.queryIds(ids), /object-ID list/);
    await assert.rejects(provider({ truncated: true }).source.queryIds(ids), /incomplete/);
});

test('Mohadin changed geometry cannot silently replace an immutable parcel reference', async () => {
    const { source, rows } = provider();
    rows[0].geometry.coordinates[0][1][0] += 0.000001;
    const result = await source.queryIds([ids[0]]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [ids[0]]);
});
