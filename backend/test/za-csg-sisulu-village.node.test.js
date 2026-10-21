// Verifies Sisulu Village's immutable native-key/geometry references and complete OID reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-sisulu-village.json', import.meta.url)));
const reference = row => fixture.descriptor.idPrefix + row.properties.PRCL_KEY + '-' + nativeGeometryHash(row.geometry);

function provider({ pageSize = 500, wrongCount = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const source = createParcelSource({ ...fixture.descriptor, pageSize }, { fetchImpl: async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, fixture.descriptor.endpoint + '/query');
        calls.push(params);
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
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) assert.equal(params.has(field), false);
            const objectIds = params.get('objectIds').split(',').map(Number);
            assert.ok(objectIds.length <= pageSize);
            payload = { type: 'FeatureCollection', features: selected.filter(row => objectIds.includes(row.properties.OBJECTID)), exceededTransferLimit: false };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } });
    return { rows, calls, source };
}

test('four Sisulu Village references repeat with unchanged geometry after OID reassignment and serial singleton pages', async () => {
    const first = provider(), second = provider({ pageSize: 1 });
    for (const row of second.rows) row.properties.OBJECTID += 100000;
    for (const instance of [first, second]) {
        const result = await instance.source.queryIds(fixture.expectedIds);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(row => row.id).sort(), [...fixture.expectedIds].sort());
        for (const feature of result.features) {
            const original = fixture.response.features.find(row => reference(row) === feature.id);
            assert.deepEqual(feature.geometry, original.geometry);
            assert.equal(feature.properties.sourceId, fixture.descriptor.id);
            assert.equal(feature.properties.sourceNativeParcelId, original.properties.PRCL_KEY);
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
        }
    }
    assert.equal(first.calls.length, 3);
    assert.equal(second.calls.length, 6);
});

test('a simulated repeated native key retains both full source outlines as distinct references', async () => {
    const { source, rows } = provider({ pageSize: 1 });
    // Reuse two unchanged fixture polygons under one simulated provider key; no geometry is repaired.
    rows[1].properties.PRCL_KEY = rows[0].properties.PRCL_KEY;
    const expected = rows.slice(0, 2).map(reference);
    const result = await source.queryIds(expected);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.id).sort(), [...expected].sort());
    assert.equal(new Set(result.features.map(row => row.properties.sourceNativeParcelId)).size, 1);
    for (const row of rows.slice(0, 2)) assert.deepEqual(result.features.find(feature => feature.id === reference(row)).geometry, row.geometry);
});

test('Sisulu Village count/manifest mismatch fails and a missing immutable reference is explicit absence', async () => {
    await assert.rejects(provider({ wrongCount: true }).source.queryIds(fixture.expectedIds), /object-ID list/);
    const absent = fixture.expectedIds[0].slice(0, -64) + '0'.repeat(64);
    const result = await provider().source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
});
