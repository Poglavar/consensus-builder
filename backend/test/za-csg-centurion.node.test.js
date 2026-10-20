// Exercises Centurion's production adapter with safe unchanged polygons from three CSG districts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-centurion.json', import.meta.url)));

function provider({ pageSize = 500, wrongCount = false } = {}) {
    const rows = structuredClone(fixture.response.features);
    const calls = [];
    const descriptor = { ...fixture.descriptor, pageSize };
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        if (!params.has('objectIds')) assert.equal(keys.length > 0, true);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.PRCL_KEY)) : rows;
        let value;
        if (params.get('returnCountOnly') === 'true') value = { count: selected.length + Number(wrongCount) };
        else if (params.get('returnIdsOnly') === 'true') value = {
            objectIdFieldName: 'OBJECTID', objectIds: selected.map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            for (const field of ['geometryPrecision', 'resultOffset', 'maxAllowableOffset']) assert.equal(params.has(field), false);
            const objectIds = params.get('objectIds').split(',').map(Number);
            assert.equal(objectIds.length <= pageSize, true);
            value = { type: 'FeatureCollection', features: selected.filter(row => objectIds.includes(row.properties.OBJECTID)),
                exceededTransferLimit: false };
        }
        return { ok: true, status: 200, json: async () => structuredClone(value) };
    };
    return { rows, calls, source: createParcelSource(descriptor, { fetchImpl }) };
}

test('Centurion exact reads preserve all three district polygons across one-feature paging and OID reassignment', async () => {
    const first = provider();
    const second = provider({ pageSize: 1 });
    for (const row of second.rows) row.properties.OBJECTID += 100000;
    const a = await first.source.queryIds(fixture.expectedIds);
    const b = await second.source.queryIds(fixture.expectedIds);
    for (const result of [a, b]) {
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(f => f.id).sort(), [...fixture.expectedIds].sort());
        for (const feature of result.features) {
            const original = fixture.response.features.find(row => row.properties.PRCL_KEY === feature.properties.sourceNativeParcelId);
            assert.deepEqual(feature.geometry, original.geometry);
            assert.equal(feature.properties.sourceId, 'za-csg-csggis-property-viewer-erven');
            assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
        }
    }
    assert.equal(first.calls.length, 3);
    assert.equal(second.calls.length, 5);
});

test('Centurion count/manifest disagreement cannot produce a complete exact read', async () => {
    const { source, calls } = provider({ wrongCount: true });
    await assert.rejects(source.queryIds(fixture.expectedIds), /object-ID list/);
    assert.equal(calls.length, 2);
});

test('Centurion changed geometry is explicit absence for its previous immutable reference', async () => {
    const { source, rows } = provider();
    const row = rows.find(item => fixture.expectedIds[0].startsWith(fixture.descriptor.idPrefix + item.properties.PRCL_KEY + '-'));
    row.geometry.coordinates[0][1][0] += 1e-12;
    const result = await source.queryIds([fixture.expectedIds[0]]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [fixture.expectedIds[0]]);
});
