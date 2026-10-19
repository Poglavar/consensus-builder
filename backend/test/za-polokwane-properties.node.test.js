import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-polokwane-properties.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const canonical = row => descriptor.idPrefix + row.attributes.SG32;
const reply = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
function provider(rows = fixture.response.features, options = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        if (params.get('returnCountOnly') === 'true') return reply({ count: options.count ?? rows.length });
        if (params.get('returnIdsOnly') === 'true') return reply({ objectIdFieldName: 'OBJECTID',
            objectIds: rows.length ? rows.map(row => row.attributes.OBJECTID) : null });
        assert.equal(params.get('outFields'), 'OBJECTID,SG32');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('returnTrueCurves'), 'true');
        for (const field of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) assert.equal(params.has(field), false);
        const ids = new Set(params.get('objectIds').split(',').map(Number));
        return reply({ ...fixture.response, features: rows.filter(row => ids.has(row.attributes.OBJECTID)) });
    };
    return { source: createArcgisParcelSource(descriptor, { fetchImpl }), calls };
}

test('Polokwane exact SG32 reads use complete singleton manifests and preserve every returned vertex', async () => {
    const { source, calls } = provider();
    const ids = fixture.response.features.map(canonical);
    const first = await source.queryIds(ids);
    const second = await provider().source.queryIds(ids);
    assert.equal(first.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.equal(first.features.length, 5);
    assert.deepEqual(first, second);
    assert.equal(calls.length, 7);
    assert.equal(calls[0].get('where'), `SG32 IN (${fixture.response.features.map(row => `'${row.attributes.SG32}'`).join(',')})`);
    for (const row of fixture.response.features) {
        const feature = first.features.find(item => item.id === canonical(row));
        assert.equal(feature.properties.sourceParcelId, row.attributes.SG32);
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
        assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['OBJECTID', 'SG32']);
    }
});

test('Polokwane bounds reads retain the full source polygon outside the query cell', async () => {
    const row = fixture.response.features.find(row => row.attributes.OBJECTID === 787511);
    const { source, calls } = provider([row]);
    const result = await source.queryBounds([29.4132, -23.8682, 29.4133, -23.8681]);
    assert.equal(result.complete, true);
    assert.equal(result.features[0].id, canonical(row));
    assert.deepEqual(result.features[0].geometry.coordinates, row.geometry.rings);
    assert.equal(calls[0].get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(calls[0].get('inSR'), '4326');
});

test('Polokwane count/manifest mismatch cannot publish partial polygons', async () => {
    const { source } = provider(undefined, { count: 6 });
    await assert.rejects(source.queryIds(fixture.response.features.map(canonical)), /object-ID list/);
});

test('Polokwane duplicate SG32 with conflicting geometry fails instead of dropping a record', async () => {
    const rows = structuredClone(fixture.response.features.slice(0, 2));
    rows[1].attributes.SG32 = rows[0].attributes.SG32;
    await assert.rejects(provider(rows).source.queryIds([canonical(rows[0])]), /conflicting geometry/);
});

test('Polokwane exact IDs reject foreign returned keys and malformed request keys', async () => {
    const rows = fixture.response.features;
    await assert.rejects(provider([rows[0]]).source.queryIds([canonical(rows[1])]), /unexpected parcels/);
    const { source, calls } = provider();
    await assert.rejects(source.queryIds([descriptor.idPrefix + "SG32' OR 1=1"]));
    assert.equal(calls.length, 0);
});

test('Polokwane explicit absence is supported only by a complete empty manifest', async () => {
    const id = descriptor.idPrefix + 'T0LS9999999999999999999999999999';
    const result = await provider([]).source.queryIds([id]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [id]);
});
