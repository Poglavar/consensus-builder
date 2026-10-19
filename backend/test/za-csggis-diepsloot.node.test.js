// Qualifies the existing production ArcGIS transport for the reviewed CSGGIS Diepsloot layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csggis-diepsloot.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const rows = fixture.response.features;
const canonical = row => descriptor.idPrefix + row.attributes.PRCL_KEY;

function provider({ records = rows, count = records.length, manifestFlag = false, geometryFlag = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        let data;
        if (params.get('returnCountOnly') === 'true') data = { count };
        else if (params.get('returnIdsOnly') === 'true') data = {
            objectIdFieldName: 'OBJECTID', objectIds: records.map(row => row.attributes.OBJECTID),
            exceededTransferLimit: manifestFlag
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'json');
            assert.equal(params.get('returnTrueCurves'), 'true');
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'resultOffset']) {
                assert.equal(params.has(field), false);
            }
            const wanted = new Set(params.get('objectIds').split(',').map(Number));
            data = { ...fixture.response, features: records.filter(row => wanted.has(row.attributes.OBJECTID)),
                exceededTransferLimit: geometryFlag };
        }
        return { ok: true, status: 200, json: async () => structuredClone(data) };
    };
    return { calls, source: createParcelSource(descriptor, { fetchImpl }) };
}

test('Diepsloot production exact reader preserves five full native-key polygons through singleton batches', async () => {
    assert.equal(descriptor.id, 'za-csggis-erven');
    const { calls, source } = provider();
    const ids = rows.map(canonical);
    const result = await source.queryIds(ids);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, []);
    assert.equal(result.features.length, 5);
    assert.equal(calls.length, 7);
    assert.equal(calls[0].get('where'), `PRCL_KEY IN (${rows.map(row => `'${row.attributes.PRCL_KEY}'`).join(',')})`);
    for (const row of rows) {
        const feature = result.features.find(value => value.id === canonical(row));
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.equal(feature.properties.sourceParcelId, row.attributes.PRCL_KEY);
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
        assert.equal(Object.hasOwn(feature.properties, 'OBJECTID'), false);
        assert.equal(Object.hasOwn(feature.properties, 'PRCL_KEY'), false);
    }
});

test('Diepsloot bounds transport does not clip the source polygon to the request envelope', async () => {
    const { source, calls } = provider({ records: [rows[0]] });
    const result = await source.queryBounds([28.017, -25.934, 28.022, -25.929]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features[0].geometry.coordinates, rows[0].geometry.rings);
    assert.equal(calls[0].get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(calls[0].get('inSR'), '4326');
});

test('Diepsloot reader rejects count mismatch and provider transfer-limit flags', async () => {
    for (const config of [{ count: rows.length + 1 }, { manifestFlag: true }, { geometryFlag: true }]) {
        const { source } = provider(config);
        await assert.rejects(source.queryIds(rows.map(canonical)), /incomplete|invalid|truncated|transfer/i);
    }
});

test('Diepsloot duplicate native keys with conflicting polygons fail without key repair', async () => {
    const duplicate = structuredClone(rows[1]);
    duplicate.attributes.PRCL_KEY = rows[0].attributes.PRCL_KEY;
    const { source } = provider({ records: [rows[0], duplicate] });
    await assert.rejects(source.queryIds([canonical(rows[0])]), /conflict|different|duplicate/i);
});

test('Diepsloot explicit absence requires a complete zero-count manifest', async () => {
    const { source } = provider({ records: [] });
    const id = descriptor.idPrefix + 'GJHBT0JR999999999999999999';
    const result = await source.queryIds([id]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [id]);
});
