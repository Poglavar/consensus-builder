// Receipt-bound eMalahleni reads use native parcel keys and retain full source rings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/za-csg-emalahleni.json', import.meta.url)));
const descriptor = { ...fixture.descriptor, pageSize: 1 };
const rows = fixture.response.features;
const canonicalId = row => descriptor.idPrefix + row.attributes.PRCL_KEY;
const ids = rows.map(canonicalId);

function provider({ sourceRows = rows, countDelta = 0, crs = 4326 } = {}) {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        const send = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
        const where = params.get('where');
        const selected = sourceRows.filter(row => where === '1=1' || where.includes("'" + row.attributes.PRCL_KEY + "'"));
        if (params.get('returnCountOnly') === 'true') return send({ count: selected.length + countDelta });
        if (params.get('returnIdsOnly') === 'true') return send({ objectIdFieldName: 'OBJECTID', objectIds: selected.map(row => row.attributes.OBJECTID) });
        assert.equal(params.get('outFields'), 'OBJECTID,PRCL_KEY');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('returnTrueCurves'), 'true');
        for (const option of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'resultOffset']) assert.equal(params.has(option), false);
        const wanted = params.get('objectIds').split(',').map(Number);
        assert.equal(wanted.length, 1);
        return send({ ...fixture.response, spatialReference: { wkid: crs }, features: selected.filter(row => wanted.includes(row.attributes.OBJECTID)) });
    };
    return { calls, source: createArcgisParcelSource(descriptor, { fetchImpl }) };
}

test('eMalahleni exact reads preserve the reviewed source namespace and all four unmodified polygons', async () => {
    assert.equal(descriptor.id, 'za-csg-dffe-erven');
    assert.equal(descriptor.endpoint, 'https://dffeportal.environment.gov.za/hosting/rest/services/CSG_Cadaster/CSG_Cadastral_Data/MapServer/2');
    assert.equal(rows.length, 4);
    const { source, calls } = provider();
    const first = await source.queryIds(ids);
    const second = await source.queryIds([...ids].reverse());
    assert.equal(first.complete, true);
    assert.equal(second.complete, true);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features.map(feature => feature.id).sort(), [...ids].sort());
    for (const row of rows) {
        const parcel = first.features.find(feature => feature.id === canonicalId(row));
        assert.equal(parcel.properties.sourceId, descriptor.id);
        assert.equal(parcel.properties.sourceParcelId, row.attributes.PRCL_KEY);
        assert.deepEqual(parcel.geometry, { type: 'Polygon', coordinates: row.geometry.rings });
        assert.deepEqual(second.features.find(feature => feature.id === parcel.id).geometry, parcel.geometry);
        assert.equal(Object.hasOwn(parcel.properties, 'OBJECTID'), false);
        assert.equal(Object.hasOwn(parcel.properties, 'PRCL_KEY'), false);
    }
    assert.equal(calls.filter(params => params.has('objectIds')).length, 8);
});

test('eMalahleni count and ID-manifest disagreement cannot publish incomplete parcels', async () => {
    const { source } = provider({ countDelta: 1 });
    await assert.rejects(source.queryIds(ids), /object-ID list/);
});

test('eMalahleni same native key with different source geometry cannot silently overwrite a parcel', async () => {
    const duplicate = structuredClone(rows[1]);
    duplicate.attributes.PRCL_KEY = rows[0].attributes.PRCL_KEY;
    const { source } = provider({ sourceRows: [rows[0], duplicate] });
    await assert.rejects(source.queryIds([ids[0]]), /conflict|different|duplicate/i);
});

test('eMalahleni reads reject mismatched response CRS and foreign canonical IDs', async () => {
    const { source } = provider({ crs: 4148 });
    await assert.rejects(source.queryIds(ids), /Esri parcel polygon collection/);
    const other = provider();
    await assert.rejects(other.source.queryIds(['ZA-CSG-NATIONAL-ERVEN-' + rows[0].attributes.PRCL_KEY]), /different source/);
    assert.equal(other.calls.length, 0);
});
