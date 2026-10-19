import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-middelburg.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const rows = fixture.response.features;
const canonicalId = row => descriptor.idPrefix + row.attributes.PRCL_KEY;
const ids = rows.map(canonicalId);

function provider({ countDelta = 0, omitGeometry = false } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        const send = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
        const where = params.get('where');
        const selected = rows.filter(row => where === '1=1' || where.includes("'" + row.attributes.PRCL_KEY + "'"));
        if (params.get('returnCountOnly') === 'true') return send({ count: selected.length + countDelta });
        if (params.get('returnIdsOnly') === 'true') return send({ objectIdFieldName: 'OBJECTID', objectIds: selected.map(row => row.attributes.OBJECTID) });
        assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('returnTrueCurves'), 'true');
        for (const name of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) assert.equal(params.has(name), false);
        const wanted = params.get('objectIds').split(',').map(Number);
        assert.equal(wanted.length, 1);
        return send({ ...fixture.response, features: omitGeometry ? [] : selected.filter(row => wanted.includes(row.attributes.OBJECTID)) });
    };
    return { calls, source: createParcelSource(descriptor, { fetchImpl }) };
}

test('Middelburg production source repeats exact native keys and preserves all four complete polygon rings', async () => {
    assert.equal(descriptor.id, 'za-csg-dffe-erven');
    assert.equal(descriptor.endpoint, 'https://dffeportal.environment.gov.za/hosting/rest/services/CSG_Cadaster/CSG_Cadastral_Data/MapServer/2');
    assert.equal(rows.length, 4);
    const { source, calls } = provider();
    const first = await source.queryIds(ids);
    const second = await source.queryIds([...ids].reverse());
    for (const result of [first, second]) {
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.deepEqual(result.features.map(feature => feature.id).sort(), [...ids].sort());
        for (const row of rows) {
            const feature = result.features.find(feature => feature.id === canonicalId(row));
            assert.equal(feature.properties.sourceId, descriptor.id);
            assert.equal(feature.properties.sourceParcelId, row.attributes.PRCL_KEY);
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
            assert.equal(Object.hasOwn(feature.properties, 'OBJECTID'), false);
            assert.equal(Object.hasOwn(feature.properties, 'PRCL_KEY'), false);
        }
    }
    assert.equal(calls.filter(params => params.has('objectIds')).length, 8);
});

test('Middelburg production source refuses incomplete manifests and missing polygon rows', async () => {
    await assert.rejects(provider({ countDelta: 1 }).source.queryIds(ids), /object-ID list/);
    await assert.rejects(provider({ omitGeometry: true }).source.queryIds(ids), /missing|omitted|incomplete|object-ID/i);
});
