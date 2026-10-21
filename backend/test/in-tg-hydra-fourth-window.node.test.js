// Exercises Hydra's legacy Esri JSON manifests, safe native IDs and unchanged full polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/in-tg-hydra-fourth-window-safe-polygons.json', import.meta.url)));
const descriptor = {
    id: 'in-tg-tgrac-hydra-fourth-window-cadastral-parcels', adapter: 'arcgis',
    endpoint: 'https://tgrac.telangana.gov.in/arcgis/rest/services/Hydra_Folder/Fourth_Window/MapServer/0',
    idField: 'OBJECTID_12', objectIdField: 'OBJECTID_12', idType: 'integer',
    idPrefix: 'tgrac-hydra-fourth-window:OBJECTID_12=', parcelNumberField: 'Parcel_num',
    outFields: ['OBJECTID_12', 'Parcel_num'], attributeNotNull: ['Parcel_num'],
    attributeExclusions: { Parcel_num: ['', ' '] }, queryFormat: 'esri-json',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    pageSize: 500, idBatchSize: 80, maxFeatures: 5000, maxBboxKm2: 9
};
const ids = fixture.features.map(row => descriptor.idPrefix + row.attributes.OBJECTID_12);

function source({ pageSize = 500, missing = false, blank = false, wrongManifestField = false } = {}) {
    const calls = [];
    const adapter = createArcgisParcelSource({ ...descriptor, pageSize }, { fetchImpl: async (url, init) => {
        const parsed = new URL(url), params = init?.method === 'POST' ? new URLSearchParams(init.body) : parsed.searchParams;
        calls.push(params);
        assert.equal(parsed.pathname, new URL(descriptor.endpoint).pathname + '/query');
        assert.equal(params.get('f'), 'json');
        assert.match(params.get('where'), /Parcel_num IS NOT NULL/);
        assert.match(params.get('where'), /Parcel_num NOT IN \('',' '\)/);
        for (const key of ['resultOffset', 'orderByFields', 'geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) {
            assert.equal(params.has(key), false);
        }
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: fixture.features.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: wrongManifestField ? 'OBJECTID' : 'OBJECTID_12',
            objectIds: fixture.features.map(row => row.attributes.OBJECTID_12).reverse()
        };
        else {
            assert.equal(params.get('geometry'), null); // Manifest bounds must never clip exact polygons.
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('outFields'), 'OBJECTID_12,Parcel_num');
            const requested = params.get('objectIds').split(',').map(Number);
            assert.ok(requested.length <= pageSize);
            payload = structuredClone({ ...fixture, features: fixture.features.filter(row => requested.includes(row.attributes.OBJECTID_12)) });
            if (missing) payload.features.pop();
            if (blank) payload.features[0].attributes.Parcel_num = ' ';
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } });
    return { adapter, calls };
}

test('Hydra repeats three native OID reads with unchanged full rings and forced singleton batches', async () => {
    const normal = source(), forced = source({ pageSize: 1 });
    const first = await normal.adapter.queryIds(ids), second = await forced.adapter.queryIds(ids);
    for (const result of [first, second]) {
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(row => row.id).sort(), [...ids].sort());
        for (const row of result.features) {
            const native = fixture.features.find(item => String(item.attributes.OBJECTID_12) === row.properties.sourceParcelId);
            assert.equal(row.properties.sourceId, descriptor.id);
            assert.deepEqual(row.geometry, { type: 'Polygon', coordinates: native.geometry.rings });
            assert.deepEqual(Object.keys(row.properties.sourceProperties).sort(), ['OBJECTID_12', 'Parcel_num']);
        }
    }
    const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(first.features), byId(second.features));
    assert.equal(normal.calls.length, 3);
    assert.equal(forced.calls.length, 5);
});

test('Hydra bounded manifest reads return full unclipped native polygons', async () => {
    const { adapter, calls } = source();
    const bbox = [78.46, 17.4, 78.465, 17.405];
    const result = await adapter.queryBounds(bbox);
    assert.equal(result.complete, true);
    assert.equal(result.features.length, 3);
    assert.equal(calls[0].get('geometry'), bbox.join(','));
    assert.equal(calls[1].get('geometry'), bbox.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.ok(result.features.some(row => row.geometry.coordinates[0].some(point => point[1] > bbox[3])));
});

test('Hydra fails closed on missing exact geometry, changed OID schema and blank-number records', async () => {
    for (const options of [{ missing: true }, { wrongManifestField: true }, { blank: true }]) {
        await assert.rejects(source(options).adapter.queryIds(ids), error => {
            assert.equal(error.code, 'parcel-source-unavailable');
            assert.equal(error.cause, undefined); // Failures must be adapter checks, not mock assertions.
            return true;
        });
    }
    const { adapter, calls } = source();
    await assert.rejects(adapter.queryIds([descriptor.idPrefix + '9285 OR 1=1']));
    assert.equal(calls.length, 0);
});
