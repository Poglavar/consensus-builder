// Exercises Kigali's native UPI and unchanged Esri polygons through the production ArcGIS reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/rw-nla-kigali.json', import.meta.url)));
const descriptor = {
    id: 'rw-nla-rsdi-kigali-parcels', adapter: 'arcgis',
    endpoint: 'https://geodata.rw/server/rest/services/LAISData/Kigali_Parcels/FeatureServer/11',
    idField: 'upi', objectIdField: 'objectid', idType: 'string',
    idPrefix: 'RW-LAIS-KGL-', idPattern: '^[0-9]+(?:/[0-9]+){4}$',
    outFields: ['objectid', 'upi'], queryFormat: 'esri-json',
    boundsQueryMode: 'offset', idsQueryMode: 'offset', pageSize: 2,
    maxFeatures: 10000, maxBboxKm2: 25
};
const ids = fixture.features.map(row => descriptor.idPrefix + row.attributes.upi);
const response = payload => ({ ok: true, status: 200, json: async () => structuredClone(payload) });

function pagedFetch(rows = fixture.features) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const params = new URL(url).searchParams;
        assert.equal(init.method, undefined);
        assert.equal(params.get('outFields'), 'objectid,upi');
        assert.equal(params.get('outSR'), '4326');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('returnGeometry'), 'true');
        assert.equal(params.get('orderByFields'), 'objectid');
        assert.equal(params.has('geometryPrecision'), false);
        calls.push(params);
        const offset = Number(params.get('resultOffset'));
        const limit = Number(params.get('resultRecordCount'));
        return response({ ...fixture, features: rows.slice(offset, offset + limit),
            exceededTransferLimit: offset + limit < rows.length });
    };
    return { fetchImpl, calls };
}

function assertUnchanged(result) {
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), ids);
    result.features.forEach((feature, i) => {
        assert.equal(feature.properties.sourceParcelId, fixture.features[i].attributes.upi);
        assert.equal(feature.properties.sourceId, descriptor.id);
        assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: fixture.features[i].geometry.rings });
        assert.deepEqual(Object.keys(feature.properties.sourceProperties).sort(), ['objectid', 'upi']);
    });
}

test('Kigali bounded reads consume every offset page and preserve native IDs and rings', async () => {
    const { fetchImpl, calls } = pagedFetch();
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    assertUnchanged(await source.queryBounds([30.093, -1.952, 30.096, -1.949]));
    assert.deepEqual(calls.map(p => p.get('resultOffset')), ['0', '2', '4']);
    assert.equal(calls[0].get('inSR'), '4326');
    assert.equal(calls[0].get('geometryType'), 'esriGeometryEnvelope');
});

test('Kigali exact UPI reads quote slash-containing keys and repeat unchanged geometry', async () => {
    const { fetchImpl, calls } = pagedFetch();
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    const first = await source.queryIds(ids);
    const second = await source.queryIds(ids);
    assertUnchanged(first);
    assert.deepEqual(second, first);
    assert.deepEqual(first.absentIds, []);
    const expected = `upi IN (${fixture.features.map(f => `'${f.attributes.upi}'`).join(',')})`;
    assert.ok(calls.every(p => p.get('where') === expected && !p.has('geometry')));
});

test('Kigali repeated provider pages fail instead of claiming a complete result', async () => {
    const fetchImpl = async () => response({ ...fixture,
        features: fixture.features.slice(0, 2), exceededTransferLimit: true });
    const source = createArcgisParcelSource(descriptor, { fetchImpl });
    await assert.rejects(source.queryIds(ids), /pagination repeated or omitted an object ID/);
});

test('Kigali ArcGIS error bodies remain upstream failures rather than parcel absence', async () => {
    const source = createArcgisParcelSource(descriptor, {
        fetchImpl: async () => response({ error: { code: 404, message: 'Service not found' } })
    });
    await assert.rejects(source.queryIds(ids), error =>
        error.code === 'parcel-source-unavailable' && error.upstreamStatus === 404);
});

test('Kigali malformed UPI keys fail before any request', async () => {
    let requests = 0;
    const source = createArcgisParcelSource(descriptor, { fetchImpl: async () => { requests++; } });
    await assert.rejects(source.queryIds([descriptor.idPrefix + "1/02/08/01/783' OR 1=1"]), /Invalid parcel ID/);
    assert.equal(requests, 0);
});
