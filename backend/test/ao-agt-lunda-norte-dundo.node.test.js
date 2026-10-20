// Exercises Dundo's safe native-key ArcGIS contract against unchanged live parcel fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ao-agt-lunda-norte-dundo.json', import.meta.url)));
const descriptor = fixture.descriptor;
const ids = fixture.response.features.map(row => descriptor.idPrefix + row.properties.ID_GGPEN);

function provider({ incomplete = false, foreign = false } = {}) {
    const rows = structuredClone(fixture.response.features), calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input), params = new URLSearchParams(init.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        calls.push(params);
        const keys = [...params.get('where').matchAll(/'([0-9a-f]{36})'/g)].map(match => match[1]);
        const selected = keys.length ? rows.filter(row => keys.includes(row.properties.ID_GGPEN)) : rows;
        let payload;
        if (params.get('returnCountOnly') === 'true') payload = { count: selected.length };
        else if (params.get('returnIdsOnly') === 'true') payload = {
            objectIdFieldName: 'OBJECTID',
            objectIds: selected.slice(incomplete ? 1 : 0).map(row => row.properties.OBJECTID)
        };
        else {
            assert.equal(params.get('outFields'), 'OBJECTID,ID_GGPEN');
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'geojson');
            assert.equal(params.get('returnGeometry'), 'true');
            for (const field of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) {
                assert.equal(params.has(field), false);
            }
            const objects = params.get('objectIds').split(',').map(Number);
            const features = structuredClone(rows.filter(row => objects.includes(row.properties.OBJECTID)));
            if (foreign && features.length) features[0].properties.ID_GGPEN = 'f'.repeat(36);
            payload = { ...fixture.response, features };
        }
        return { ok: true, status: 200, json: async () => structuredClone(payload) };
    };
    return { rows, calls, source: createArcgisParcelSource({ ...descriptor, pageSize: 1 }, { fetchImpl }) };
}

test('ID_GGPEN exact reads retain polygons and identities across transport OID reassignment', async () => {
    const { source, rows, calls } = provider();
    const first = await source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(row => row.id), ids);
    for (let i = 0; i < rows.length; i++) {
        assert.deepEqual(first.features[i].geometry, rows[i].geometry);
        assert.equal(first.features[i].properties.sourceParcelId, rows[i].properties.ID_GGPEN);
        assert.deepEqual(Object.keys(first.features[i].properties.sourceProperties).sort(), ['ID_GGPEN', 'OBJECTID']);
        rows[i].properties.OBJECTID += 100000;
    }
    const second = await source.queryIds(ids);
    assert.deepEqual(second.features.map(row => [row.id, row.geometry]), first.features.map(row => [row.id, row.geometry]));
    assert.equal(calls[0].get('where'), `ID_GGPEN IN (${rows.map(row => `'${row.properties.ID_GGPEN}'`).join(',')})`);
    assert.equal(calls.filter(call => call.has('objectIds')).length, 6);
});

test('bounded reads page complete OID manifests without clipping intersecting polygons', async () => {
    const { source, rows, calls } = provider();
    const bounds = [20.81, -7.42, 20.87, -7.388];
    const result = await source.queryBounds(bounds);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(row => row.geometry), rows.map(row => row.geometry));
    assert.equal(calls.length, 5);
    assert.equal(calls[0].get('geometry'), bounds.join(','));
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('spatialRel'), 'esriSpatialRelIntersects');
});

test('incomplete manifests and foreign native IDs fail instead of returning partial results', async () => {
    await assert.rejects(provider({ incomplete: true }).source.queryIds(ids), /object-ID list/);
    await assert.rejects(provider({ foreign: true }).source.queryIds([ids[0]]), /unexpected parcels/);
});

test('conflicting outlines for one native key fail without silently choosing a row', async () => {
    const { source, rows } = provider();
    const duplicate = structuredClone(rows[0]);
    duplicate.properties.OBJECTID += 200000;
    duplicate.geometry.coordinates[0][1][0] += 0.000001;
    rows.push(duplicate);
    await assert.rejects(source.queryIds([ids[0]]), /conflicting geometry/);
});

test('an empty complete manifest establishes explicit absence for an unobserved valid key', async () => {
    const { source } = provider();
    const absent = descriptor.idPrefix + '0'.repeat(36);
    const result = await source.queryIds([absent]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [absent]);
});

test('foreign and malformed canonical IDs fail before network access', async () => {
    const { source, calls } = provider();
    for (const id of ['OTHER-1', descriptor.idPrefix + '123', descriptor.idPrefix + "' OR 1=1"]) {
        await assert.rejects(source.queryIds([id]), /different source|Invalid parcel ID/);
    }
    assert.equal(calls.length, 0);
});
