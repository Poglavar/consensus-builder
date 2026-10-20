// Checks Sumbe's production ArcGIS reader using unchanged public GlobalID_2 polygon fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ao-ggpen-agt-sumbe.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.properties.GlobalID_2);

function provider({ incomplete = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([0-9a-f-]{36})'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.GlobalID_2)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID',
            objectIds: selected.slice(incomplete ? 1 : 0).map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,GlobalID_2');
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

test('GlobalID_2 remains canonical across transport OBJECTID reassignment, preserving full geometry', async () => {
    const { source, rows, calls } = provider();
    const first = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(row => row.id), ids);
    for (let i = 0; i < rows.length; i++) {
        assert.deepEqual(first.features[i].geometry, rows[i].geometry);
        assert.equal(first.features[i].properties.sourceParcelId, rows[i].properties.GlobalID_2);
        assert.deepEqual(Object.keys(first.features[i].properties.sourceProperties).sort(), ['GlobalID_2', 'OBJECTID']);
        rows[i].properties.OBJECTID += 100000;
    }
    const second = await source.queryIds(ids);
    assert.deepEqual(second.features.map(row => [row.id, row.geometry]), first.features.map(row => [row.id, row.geometry]));
    assert.equal(calls[0].get('where'), `GlobalID_2 IN (${rows.map(row => `'${row.properties.GlobalID_2}'`).join(',')})`);
    assert.equal(calls.filter(call => call.has('objectIds')).length, 6);
});

test('bounded OID manifest paging preserves complete intersecting polygons without clipping', async () => {
    const { source, rows, calls } = provider();
    const bounds = [13.84, -11.24, 13.87, -11.195];
    const result = await source.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.geometry), rows.map(row => row.geometry));
    assert.equal(calls.length, 5);
    assert.equal(calls[0].get('geometry'), bounds.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
});

test('incomplete manifests and conflicting native-key outlines fail without selecting or repairing a row', async () => {
    await assert.rejects(provider({ incomplete: true }).source.queryIds(ids), /object-ID list/);
    const { source, rows } = provider();
    const duplicate = structuredClone(rows[0]);
    duplicate.properties.OBJECTID += 200000;
    duplicate.geometry.coordinates[0][1][0] += 0.000001;
    rows.push(duplicate);
    await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
});

test('complete empty native-key manifests report absence', async () => {
    const { source } = provider();
    const absent = descriptor.idPrefix + '00000000-0000-0000-0000-000000000000';
    const result = await source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
});

test('foreign or malformed canonical keys fail before requesting the provider', async () => {
    const { source, calls } = provider();
    for (const id of ['OTHER-1', descriptor.idPrefix + '123', descriptor.idPrefix + "' OR 1=1"]) {
        await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(calls.length, 0);
});
