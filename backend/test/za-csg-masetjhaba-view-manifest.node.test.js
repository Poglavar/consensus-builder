// Exercise complete CSG object-ID manifests and ensure transport ID changes do not change parcel identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-masetjhaba-view.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 2 };
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.attributes.PRCL_KEY).sort();
const bounds = [28.387, -26.396, 28.399, -26.387];

function provider({ transportOffset = 0, omitRow = false, truncateManifest = false } = {}) {
    const rows = structuredClone(fixture.response.features);
    for (const row of rows) row.attributes.OBJECTID += transportOffset;
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin + parsed.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || parsed.search);
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID',
            objectIds: rows.map(row => row.attributes.OBJECTID).reverse().slice(truncateManifest ? 1 : 0)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.has('resultOffset'), false);
            assert.equal(params.has('geometryPrecision'), false);
            const objects = params.get('objectIds').split(',').map(Number);
            assert.ok(objects.length <= 2);
            let selected = rows.filter(row => objects.includes(row.attributes.OBJECTID));
            if (omitRow) selected = selected.slice(1);
            payload = { ...fixture.response, features: selected };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { fetchImpl, calls };
}

test('CSG bounds and fresh exact reads retain native identities across transport-ID reassignment', async () => {
    const first = provider();
    const bounded = await createParcelSource(descriptor, first).queryBounds(bounds);
    assert.equal(bounded.complete, true);
    assert.deepEqual(bounded.features.map(row => row.id).sort(), ids);
    assert.equal(first.calls.length, 5);
    assert.equal(first.calls[0].get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(first.calls[0].get('inSR'), '4326');
    const independent = provider({ transportOffset: 10000000 });
    const exact = await createParcelSource(descriptor, independent).queryIds(ids);
    assert.equal(exact.complete, true);
    assert.deepEqual(exact.absentIds, []);
    assert.deepEqual(exact.features.map(row => row.id).sort(), ids);
    assert.match(independent.calls[0].get('where'), /^PRCL_KEY IN /);
    for (const item of bounded.features) {
        const fresh = exact.features.find(row => row.id === item.id);
        assert.deepEqual(fresh.geometry, item.geometry);
        assert.equal(fresh.properties.sourceParcelId, item.properties.sourceParcelId);
        assert.equal(fresh.properties.sourceProperties.OBJECTID, item.properties.sourceProperties.OBJECTID + 10000000);
    }
});

test('CSG rejects incomplete manifests and missing full polygons instead of reporting absence', async () => {
    await assert.rejects(createParcelSource(descriptor, provider({ truncateManifest: true })).queryBounds(bounds),
        /incomplete or invalid object-ID list/);
    await assert.rejects(createParcelSource(descriptor, provider({ omitRow: true })).queryIds(ids),
        /incomplete object-ID paging/);
});
