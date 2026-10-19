// Verifies Windhoek's native parcel keys, complete manifests and unchanged source polygons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/na-windhoek-cadastral1.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.properties.PRCL_KEY);

function provider({ incomplete = false, foreignKey = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([A-Z0-9]+)'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.PRCL_KEY)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'FID', objectIds: selected.slice(incomplete ? 1 : 0).map(row => row.properties.FID)
        };
        else {
            assert.equal(params.get('outFields'), 'FID,PRCL_KEY');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('returnGeometry'), 'true');
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) {
                assert.equal(params.has(field), false);
            }
            const objects = params.get('objectIds').split(',').map(Number);
            const features = structuredClone(rows.filter(row => objects.includes(row.properties.FID)));
            if (foreignKey && features.length) features[0].properties.PRCL_KEY = 'X'.repeat(26);
            payload = { ...fixture.response, features };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, source: createParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl }) };
}

test('native PRCL_KEY exact reads preserve leading zeroes and full geometry across OID reassignment', async () => {
    const { source, rows, calls } = provider();
    const first = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(row => row.id), ids);
    for (let i = 0; i < rows.length; i++) {
        assert.deepEqual(first.features[i].geometry, rows[i].geometry);
        assert.equal(first.features[i].properties.sourceParcelId, rows[i].properties.PRCL_KEY);
        assert.deepEqual(Object.keys(first.features[i].properties.sourceProperties).sort(), ['FID', 'PRCL_KEY']);
        rows[i].properties.FID += 100000;
    }
    const second = await source.queryIds(ids);
    assert.deepEqual(second.features.map(row => [row.id, row.geometry]), first.features.map(row => [row.id, row.geometry]));
    assert.equal(calls[0].get('where'), `PRCL_KEY IN (${rows.map(row => `'${row.properties.PRCL_KEY}'`).join(',')})`);
    assert.equal(calls.filter(call => call.has('objectIds')).length, 6);
});

test('bounded queries use count-matched OID manifests and keep full intersecting parcels', async () => {
    const { source, rows, calls } = provider();
    const bbox = [17.0392106526956, -22.5303108270478, 17.0492106526956, -22.5203108270478];
    const result = await source.queryBounds(bbox);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.geometry), rows.map(row => row.geometry));
    assert.equal(calls.length, 5);
    assert.equal(calls[0].get('geometry'), bbox.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
});

test('incomplete manifests and foreign keys fail without manufacturing parcel absence', async () => {
    await assert.rejects(provider({ incomplete: true }).source.queryIds(ids), /object-ID list/);
    await assert.rejects(provider({ foreignKey: true }).source.queryIds([ids[0]]), /unexpected parcels/);
});

test('conflicting geometry for one native key fails without repair or row selection', async () => {
    const { source, rows } = provider();
    const duplicate = structuredClone(rows[0]);
    duplicate.properties.FID += 200000;
    duplicate.geometry.coordinates[0][1][0] += 0.000001;
    rows.push(duplicate);
    await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
});

test('an empty successful manifest gives explicit absence for a well-formed unobserved key', async () => {
    const { source } = provider();
    const absent = descriptor.idPrefix + 'Z'.repeat(26);
    const result = await source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
});

test('foreign and malformed keys fail before network I/O', async () => {
    const { source, calls } = provider();
    for (const id of ['OTHER-1', descriptor.idPrefix + '123', descriptor.idPrefix + "' OR 1=1"]) {
        await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(calls.length, 0);
});
