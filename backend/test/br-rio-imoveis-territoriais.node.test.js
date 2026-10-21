import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

// First-party exact read retained with only the native OID and unchanged polygons.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/br-rio-imoveis-safe.geojson', import.meta.url)));
const descriptor = {
    id: 'br-rio-pgeo3-imoveis-territoriais', adapter: 'arcgis',
    endpoint: 'https://pgeo3.rio.rj.gov.br/arcgis/rest/services/CadParcel/IMOVEIS_TERRITORIAIS/FeatureServer/0',
    idField: 'objectid', objectIdField: 'objectid', outFields: ['objectid'],
    idPrefix: 'BR-RIO-IMOVEIS-TERRITORIAIS-', queryFormat: 'geojson',
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 1
};
const ids = fixture.features.map(f => descriptor.idPrefix + f.properties.objectid);

function createSource({ rows = fixture.features, incompleteManifest = false, truncated = false } = {}) {
    const calls = [];
    const source = createParcelSource(descriptor, { fetchImpl: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        assert.notEqual(init?.method, 'POST');
        const params = url.searchParams;
        calls.push(params);
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: rows.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'objectid', objectIds: rows.length
                ? rows.slice(incompleteManifest ? 1 : 0).map(f => f.properties.objectid) : null
        };
        else {
            assert.equal(params.get('outFields'), 'objectid');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('returnGeometry'), 'true');
            assert.equal(params.has('geometryPrecision'), false);
            assert.equal(params.has('maxAllowableOffset'), false);
            const oids = params.get('objectIds').split(',').map(Number);
            payload = { type: 'FeatureCollection', features: rows.filter(f => oids.includes(f.properties.objectid)),
                exceededTransferLimit: truncated };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    } });
    return { source, calls };
}

test('Rio lowercase native OIDs survive manifest paging and independent exact reads unchanged', async () => {
    const first = createSource(), second = createSource();
    const read = await first.source.queryIds(ids);
    assert.equal(read.complete, true);
    assert.deepEqual(read.absentIds, []);
    assert.deepEqual(read.features.map(f => f.id), ids);
    read.features.forEach((f, i) => {
        assert.deepEqual(f.geometry, fixture.features[i].geometry);
        assert.equal(f.properties.sourceParcelId, String(fixture.features[i].properties.objectid));
        assert.deepEqual(f.properties.sourceProperties, fixture.features[i].properties);
    });
    assert.deepEqual((await second.source.queryIds(ids)).features, read.features);
    assert.equal(first.calls.length, 5);
    assert.equal(first.calls[0].get('where'), 'objectid IN (43,93,230)');
    assert.deepEqual(first.calls.slice(2).map(p => p.get('objectIds')), ['43', '93', '230']);
});

test('Rio refuses incomplete manifests and truncated full-geometry reads', async () => {
    for (const options of [{ incompleteManifest: true }, { truncated: true }]) {
        await assert.rejects(createSource(options).source.queryIds(ids), /incomplete|invalid object-ID/);
    }
});

test('Rio rejects foreign namespaces before I/O and preserves explicit empty-manifest absence', async () => {
    const { source, calls } = createSource({ rows: [] });
    await assert.rejects(source.queryIds(['BR-OTHER-43']), /different source/);
    assert.equal(calls.length, 0);
    const result = await source.queryIds([ids[0]]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [ids[0]]);
});
