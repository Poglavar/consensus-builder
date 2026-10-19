// Checks Rubavu's receipt-bound query endpoint, unchanged polygons and explicit identity failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/rw-nla-rubavu.json', import.meta.url)));
const endpoint = 'https://geodata.rw/server/rest/services/LAISData/Rubavu_Parcels/FeatureServer/24/query';
const descriptor = {
    id: 'rw-nla-lais-rubavu-parcels', adapter: 'arcgis', endpoint,
    idField: 'upi', objectIdField: 'objectid', idType: 'string',
    idPrefix: 'RW-LAIS-RUBAVU-', idPattern: '^[0-9]+(?:/[0-9]+){4}$',
    outFields: ['objectid', 'upi'], queryFormat: 'esri-json',
    boundsQueryMode: 'offset', idsQueryMode: 'offset', pageSize: 2,
    maxFeatures: 10000, maxBboxKm2: 25
};
const ids = fixture.sample.features.map(row => descriptor.idPrefix + row.attributes.upi);
const response = payload => ({ ok: true, status: 200, json: async () => structuredClone(payload) });

function pagedFetch() {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const target = new URL(url);
        assert.equal(target.origin + target.pathname, endpoint);
        const params = init.method === 'POST' ? new URLSearchParams(init.body) : target.searchParams;
        assert.equal(params.get('outFields'), 'objectid,upi');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('returnGeometry'), 'true');
        assert.equal(params.get('returnTrueCurves'), 'true');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.has('geometryPrecision'), false);
        calls.push({ params, method: init.method || 'GET' });
        const offset = Number(params.get('resultOffset'));
        const limit = Number(params.get('resultRecordCount'));
        return response({ ...fixture.sample, features: fixture.sample.features.slice(offset, offset + limit),
            exceededTransferLimit: offset + limit < fixture.sample.features.length });
    };
    return { calls, fetchImpl };
}

function assertUnchanged(result) {
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), ids);
    result.features.forEach((feature, index) => {
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.equal(feature.properties.sourceParcelId, fixture.sample.features[index].attributes.upi);
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: fixture.sample.features[index].geometry.rings });
        assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['objectid', 'upi']);
    });
}

test('Rubavu layer and query endpoint forms read every page without changing full polygons', async () => {
    for (const configured of [endpoint, endpoint + '/', endpoint.slice(0, -6), endpoint.slice(0, -5)]) {
        const { fetchImpl, calls } = pagedFetch();
        const source = createArcgisParcelSource({ ...descriptor, endpoint: configured }, { fetchImpl });
        assertUnchanged(await source.queryBounds([29.287, -1.694, 29.292, -1.690]));
        assert.deepEqual(calls.map(c => c.params.get('resultOffset')), ['0', '2']);
        assert.equal(calls[0].params.get('inSR'), '4326');
        assert.equal(calls[0].params.get('geometryType'), 'esriGeometryEnvelope');
    }
});

test('Rubavu exact UPI reads quote the native keys and repeat unchanged geometry', async () => {
    const { fetchImpl, calls } = pagedFetch();
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    const first = await source.queryIds(ids);
    assertUnchanged(first);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(await source.queryIds(ids), first);
    const expected = `upi IN (${fixture.sample.features.map(row => `'${row.attributes.upi}'`).join(',')})`;
    assert.ok(calls.every(c => c.params.get('where') === expected && !c.params.has('geometry')));
});

test('Rubavu long exact predicates use the same receipt endpoint for form POST', async () => {
    const { fetchImpl, calls } = pagedFetch();
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    const extra = Array.from({ length: 77 }, (_, index) => descriptor.idPrefix + `3/03/11/07/${900000000 + index}`);
    const result = await source.queryIds([...ids, ...extra]);
    assertUnchanged(result);
    assert.deepEqual(result.absentIds, extra);
    assert.ok(calls.every(c => c.method === 'POST'));
});

test('Rubavu repeated objectid/UPI rows with two real geometries are rejected without repair', async () => {
    assert.equal(fixture.collision.features.length, 2);
    assert.notDeepEqual(fixture.collision.features[0].geometry, fixture.collision.features[1].geometry);
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async () => response(fixture.collision) });
    await assert.rejects(source.queryIds([descriptor.idPrefix + '3/03/11/07/5007']), /repeated or omitted an object ID/);
});

test('Rubavu conflicting UPI geometries with distinct object IDs are rejected', async () => {
    const payload = structuredClone(fixture.collision);
    payload.features[1].attributes.objectid++;
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async () => response(payload) });
    await assert.rejects(source.queryIds([descriptor.idPrefix + '3/03/11/07/5007']), /conflicting geometry/);
});

test('Rubavu invalid IDs and service errors cannot become complete absence', async () => {
    let calls = 0;
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async () => {
        calls++;
        return response({ error: { code: 403 } });
    } });
    await assert.rejects(source.queryIds([descriptor.idPrefix + "3/03/11/07/68' OR 1=1"]), /Invalid parcel ID/);
    assert.equal(calls, 0);
    await assert.rejects(source.queryIds(ids), error => error.code === 'parcel-source-blocked' && error.upstreamStatus === 403);
});
