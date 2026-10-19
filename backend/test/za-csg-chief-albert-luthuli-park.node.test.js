// Verifies the production reader against safe, unchanged live Erven polygons for WUP city 4544.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-chief-albert-luthuli-park.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const rows = fixture.response.features;
const response = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });

function provider({ truncate = false, manifestDelta = 0 } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        if (params.get('returnCountOnly') === 'true' || params.get('returnIdsOnly') === 'true') {
            assert.equal(params.get('where'), `PRCL_KEY IN (${fixture.sampleIds.map(id => `'${id.slice(descriptor.idPrefix.length)}'`).join(',')})`);
            if (params.get('returnCountOnly') === 'true') return response({ count: rows.length + manifestDelta });
            return response({ objectIdFieldName: 'OBJECTID', objectIds: rows.map(row => row.attributes.OBJECTID) });
        }
        assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('returnTrueCurves'), 'true');
        assert.equal(params.has('geometryPrecision'), false);
        assert.equal(params.has('resultOffset'), false);
        const objectIds = params.get('objectIds').split(',').map(Number);
        assert.equal(objectIds.length, 1);
        return response({ ...fixture.response,
            features: truncate ? [] : rows.filter(row => objectIds.includes(row.attributes.OBJECTID)) });
    };
    return { calls, source: createParcelSource(descriptor, { fetchImpl }) };
}

test('city 4544 uses the receipt source and preserves all five native-key polygons on repeated reads', async () => {
    assert.equal(descriptor.id, 'za-csg-dffe-national-erven');
    const first = provider(), second = provider();
    const result = await first.source.queryIds(fixture.sampleIds);
    const repeated = await second.source.queryIds(fixture.sampleIds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, []);
    assert.equal(result.features.length, 5);
    assert.deepEqual(repeated, result);
    assert.equal(first.calls.length, 7);
    for (const row of rows) {
        const id = descriptor.idPrefix + row.attributes.PRCL_KEY;
        const feature = result.features.find(value => value.id === id);
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.equal(feature.properties.sourceParcelId, row.attributes.PRCL_KEY);
        assert.equal(feature.geometry.type, 'Polygon');
        assert.deepEqual(feature.geometry.coordinates, row.geometry.rings);
        assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'PRCL_KEY']);
    }
});

test('city 4544 refuses an incomplete count/manifest rather than publishing a partial extract', async () => {
    const { source } = provider({ manifestDelta: 1 });
    await assert.rejects(source.queryIds(fixture.sampleIds), /object-ID list/);
});

test('city 4544 refuses missing geometry in a manifest-selected page', async () => {
    const { source } = provider({ truncate: true });
    await assert.rejects(source.queryIds(fixture.sampleIds), /incomplete|omitted|missing/i);
});
