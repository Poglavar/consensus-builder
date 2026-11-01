// Verify Guayaquil's qualified cadastral codes and unchanged polygons in both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const { descriptor, response, duplicateCodes, shortCode } = JSON.parse(fs.readFileSync(new URL('./fixtures/ec-guayaquil-safe.json', import.meta.url)));
const rows = response.features;
const reference = row => descriptor.idPrefix + row.properties[descriptor.idField] + '-' + nativeGeometryHash(row.geometry);
const ids = rows.map(reference);

function provider({ truncated = false, missingObject = false, sourceRows = rows } = {}) {
    const calls = [];
    const fetchImpl = async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init?.body || url.search);
        calls.push(params);
        assert.equal(params.has('geometryPrecision'), false);
        assert.equal(params.has('maxAllowableOffset'), false);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: sourceRows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: descriptor.objectIdField,
            objectIds: sourceRows.slice(missingObject ? 1 : 0).map(row => row.properties[descriptor.objectIdField])
        };
        else {
            assert.equal(params.get('outFields'), descriptor.outFields.join(','));
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.get('outSR'), '4326');
            const objects = params.get('objectIds').split(',').map(Number);
            const features = structuredClone(sourceRows.filter(row => objects.includes(row.properties[descriptor.objectIdField])));
            payload = { type: 'FeatureCollection', features, exceededTransferLimit: truncated };
        }
        return { ok: true, status: 200, json: async () => payload };
    };
    return { fetchImpl, calls };
}

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Guayaquil preserves the real five-component cadastral code without padding`, async () => {
        const source = factory(descriptor, provider({ sourceRows: [shortCode] }));
        const result = await source.queryIds([reference(shortCode)]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, []);
        assert.equal(result.features[0].properties.sourceNativeParcelId, '76-255-10-0-0');
        assert.deepEqual(result.features[0].geometry, shortCode.geometry);
    });

    test(`${name}: Guayaquil qualified column names preserve exact native codes and full polygons across manifest pages`, async () => {
        const fetch = provider();
        const source = factory({ ...descriptor, pageSize: 1 }, fetch);
        const first = await source.queryIds(ids);
        const second = await factory({ ...descriptor, pageSize: 1 }, provider()).queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(row => row.id), ids);
        assert.deepEqual(first.features, second.features);
        first.features.forEach((row, index) => {
            assert.equal(row.properties.sourceNativeParcelId, rows[index].properties[descriptor.idField]);
            assert.equal(row.properties.sourceParcelId, rows[index].properties[descriptor.idField] + '-' + nativeGeometryHash(rows[index].geometry));
            assert.deepEqual(row.geometry, rows[index].geometry);
        });
        assert.equal(fetch.calls[0].get('where'), `${descriptor.idField} IN ('76-257-4-0-0-0','76-257-42-0-0-0','76-257-5-0-0-0')`);
        assert.deepEqual(fetch.calls.slice(2).map(params => params.get('objectIds')), ['444581', '124306', '124331']);
        const bounds = await source.queryBounds([-79.9157, -2.15765, -79.91545, -2.15735]);
        assert.equal(bounds.complete, true);
        assert.deepEqual(bounds.features.map(row => row.geometry), rows.map(row => row.geometry));
    });
}

test('Guayaquil rejects truncated geometry and incomplete manifests', async () => {
    for (const options of [{ truncated: true }, { missingObject: true }]) {
        await assert.rejects(createParcelSource(descriptor, provider(options)).queryIds(ids));
    }
});

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${name}: Guayaquil retains both real polygons sharing a native code and resolves each exact geometry reference`, async () => {
        const sourceRows = duplicateCodes.features;
        const source = factory({ ...descriptor, pageSize: 1 }, provider({ sourceRows }));
        const expected = sourceRows.map(reference);
        const bounds = await source.queryBounds([-79.916, -2.158, -79.915, -2.157]);
        assert.equal(bounds.complete, true);
        assert.deepEqual(bounds.features.map(row => row.id), expected);
        assert.equal(new Set(bounds.features.map(row => row.properties.sourceNativeParcelId)).size, 1);
        assert.equal(new Set(expected).size, 2);
        for (let index = 0; index < expected.length; index++) {
            const first = await source.queryIds([expected[index]]);
            const second = await factory(descriptor, provider({ sourceRows })).queryIds([expected[index]]);
            assert.equal(first.complete, true);
            assert.deepEqual(first.absentIds, []);
            assert.deepEqual(first.features.map(row => row.id), [expected[index]]);
            assert.deepEqual(first.features, second.features);
            assert.deepEqual(first.features[0].geometry, sourceRows[index].geometry);
        }
        const changed = reference(sourceRows[0]).slice(0, -64) + '0'.repeat(64);
        const missing = await source.queryIds([changed]);
        assert.equal(missing.complete, true);
        assert.deepEqual(missing.features, []);
        assert.deepEqual(missing.absentIds, [changed]);
    });
}

test('Guayaquil rejects foreign and malformed IDs before making any provider request', async () => {
    const fetch = provider();
    const source = createParcelSource(descriptor, fetch);
    for (const id of ['EC-OTHER-1', "EC-GYE-URBAN-76-257-4-0-0-0'", 'EC-GYE-URBAN- 76-257-4-0-0-0']) {
        await assert.rejects(source.queryIds([id]));
    }
    assert.equal(fetch.calls.length, 0);
});
