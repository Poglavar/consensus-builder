// Tests Menongue's production ArcGIS native-key reads with unchanged public source polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ao-ggpen-cubango-menongue.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.properties.ID_GGPEN);

function provider({ incomplete = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([0-9a-f]{36})'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.ID_GGPEN)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID', objectIds: selected.slice(incomplete ? 1 : 0).map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,ID_GGPEN');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('returnGeometry'), 'true');
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) {
                assert.equal(params.has(field), false);
            }
            const objects = params.get('objectIds').split(',').map(Number);
            payload = { ...fixture.response, features: rows.filter(row => objects.includes(row.properties.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, source: createParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl }) };
}

test('exact native IDs retain full geometry across independent reads and transport OID changes', async () => {
    const { source, rows, calls } = provider();
    const first = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(row => row.id), ids);
    for (let i = 0; i < rows.length; i++) {
        assert.deepEqual(first.features[i].geometry, rows[i].geometry);
        assert.equal(first.features[i].properties.sourceParcelId, rows[i].properties.ID_GGPEN);
        assert.deepEqual(Object.keys(first.features[i].properties.sourceProperties).sort(), ['ID_GGPEN', 'OBJECTID']);
        rows[i].properties.OBJECTID += 100000;
    }
    const second = await source.queryIds(ids);
    assert.deepEqual(second.features.map(row => [row.id, row.geometry]), first.features.map(row => [row.id, row.geometry]));
    assert.equal(calls.filter(call => call.has('objectIds')).length, 6);
});

test('bounded object manifests page every outline without clipping it to the viewport', async () => {
    const { source, rows, calls } = provider();
    const bounds = [17.6761, -14.6574, 17.6762, -14.6573];
    const result = await source.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.geometry), rows.map(row => row.geometry));
    assert.equal(calls.length, 5);
    assert.equal(calls[0].get('geometry'), bounds.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
});

test('incomplete manifests and conflicting same-key geometries fail explicitly', async () => {
    await assert.rejects(provider({ incomplete: true }).source.queryIds(ids), /object-ID list/);
    const { source, rows } = provider();
    const duplicate = structuredClone(rows[0]);
    duplicate.properties.OBJECTID += 200000;
    duplicate.geometry.coordinates[0][1][0] += 0.000001;
    rows.push(duplicate);
    await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
});

test('complete absence and malformed-key rejection do not invent parcel identities', async () => {
    const { source, calls } = provider();
    const absent = descriptor.idPrefix + '0'.repeat(36);
    const result = await source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
    const priorCalls = calls.length;
    for (const id of ['OTHER-1', descriptor.idPrefix + '123', descriptor.idPrefix + "' OR 1=1"]) {
        await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(calls.length, priorCalls);
});
