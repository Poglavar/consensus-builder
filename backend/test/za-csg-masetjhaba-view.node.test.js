// Verify the reviewed CSG namespace and unchanged polygons across five Masetjhaba View townships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-masetjhaba-view.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const rows = fixture.response.features;
const ids = rows.map(row => descriptor.idPrefix + row.attributes.PRCL_KEY);
function provider() {
    const calls = [];
    return { calls, fetchImpl: async (url, init = {}) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin + parsed.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || parsed.search);
        calls.push(params);
        if (!params.has('objectIds')) assert.equal(params.get('where'), `PRCL_KEY IN (${rows.map(row => `'${row.attributes.PRCL_KEY}'`).join(',')})`);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID', objectIds: rows.map(row => row.attributes.OBJECTID).reverse()
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnTrueCurves'), 'true');
            assert.equal(params.has('geometryPrecision'), false);
            assert.equal(params.has('resultOffset'), false);
            const selected = params.get('objectIds').split(',').map(Number);
            payload = { ...fixture.response, features: rows.filter(row => selected.includes(row.attributes.OBJECTID)) };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } };
}

test('production factory reads five township keys with the exact receipt namespace and unchanged vertices', async () => {
    const first = provider(), second = provider();
    const read = p => createParcelSource(descriptor, { fetchImpl: p.fetchImpl }).queryIds(ids);
    const one = await read(first), two = await read(second);
    assert.equal(one.complete, true);
    assert.deepEqual(one.absentIds, []);
    assert.deepEqual(one, two);
    assert.equal(one.features.length, 5);
    assert.equal(first.calls.length, 7);
    for (const row of rows) {
        const id = descriptor.idPrefix + row.attributes.PRCL_KEY;
        const feature = one.features.find(feature => feature.id === id);
        assert.equal(feature.properties.sourceId, 'za-csg-dffe-erven');
        assert.equal(feature.properties.sourceParcelId, row.attributes.PRCL_KEY);
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
        assert.deepEqual(feature.properties.sourceProperties, row.attributes);
    }
});

test('receipt adapter rejects transport-only and foreign-namespace IDs before requesting the source', async () => {
    const mock = provider();
    const source = createParcelSource(descriptor, { fetchImpl: mock.fetchImpl });
    await assert.rejects(source.queryIds(['ZA-CSG-NATIONAL-ERVEN-' + rows[0].attributes.PRCL_KEY]), /different source/);
    await assert.rejects(source.queryIds([String(rows[0].attributes.OBJECTID)]), /different source/);
    assert.equal(mock.calls.length, 0);
});
