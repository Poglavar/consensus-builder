// Exercises Rubavu exact subsets through the production factory with unchanged source rings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParcelSource } from '../parcels/sources.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/rw-nla-rubavu.json', import.meta.url)));
const descriptor = {
    id: 'rw-nla-lais-rubavu-parcels', adapter: 'arcgis',
    endpoint: 'https://geodata.rw/server/rest/services/LAISData/Rubavu_Parcels/FeatureServer/24/query',
    idField: 'upi', objectIdField: 'objectid', idType: 'string',
    idPrefix: 'RW-LAIS-RUBAVU-', idPattern: '^[0-9]+(?:/[0-9]+){4}$',
    outFields: ['objectid', 'upi'], queryFormat: 'esri-json',
    boundsQueryMode: 'offset', idsQueryMode: 'offset', pageSize: 1,
    maxFeatures: 10000, maxBboxKm2: 25
};
const id = row => descriptor.idPrefix + row.attributes.upi;
const response = payload => ({ ok: true, status: 200, json: async () => structuredClone(payload) });

test('Rubavu exact subsets page and repeat independently, with explicit absence and full polygons', async () => {
    const calls = [];
    const source = createParcelSource(descriptor, { fetchImpl: async (url, init) => {
        const target = new URL(url);
        assert.equal(target.origin + target.pathname, descriptor.endpoint);
        assert.equal(init.method, undefined);
        const p = target.searchParams;
        assert.equal(p.get('outFields'), 'objectid,upi');
        assert.equal(p.get('outSR'), '4326');
        assert.equal(p.get('returnTrueCurves'), 'true');
        assert.equal(p.get('returnGeometry'), 'true');
        assert.equal(p.get('f'), 'json');
        assert.equal(p.get('orderByFields'), 'objectid');
        assert.equal(p.has('geometry'), false);
        assert.equal(p.has('geometryPrecision'), false);
        const predicate = p.get('where');
        assert.match(predicate, /^upi IN \('[0-9/]+(?:','[0-9/]+)*'\)$/);
        const keys = [...predicate.matchAll(/'([0-9/]+)'/g)].map(match => match[1]);
        const rows = fixture.sample.features.filter(row => keys.includes(row.attributes.upi));
        const offset = Number(p.get('resultOffset')), limit = Number(p.get('resultRecordCount'));
        calls.push({ offset, limit });
        return response({ ...fixture.sample, features: rows.slice(offset, offset + limit),
            exceededTransferLimit: offset + limit < rows.length });
    } });
    const selected = [fixture.sample.features[0], fixture.sample.features[2]];
    const absent = descriptor.idPrefix + '3/99/99/99/999999999';
    for (let pass = 0; pass < 2; pass++) {
        const result = await source.queryIds([id(selected[1]), absent, id(selected[0])]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.absentIds, [absent]);
        assert.deepEqual(result.features.map(feature => feature.id), selected.map(id));
        result.features.forEach((feature, index) => {
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: selected[index].geometry.rings });
            assert.equal(feature.properties.sourceParcelId, selected[index].attributes.upi);
            assert.deepEqual(feature.properties.sourceProperties, selected[index].attributes);
        });
    }
    assert.deepEqual(calls, [{ offset: 0, limit: 1 }, { offset: 1, limit: 1 },
        { offset: 0, limit: 1 }, { offset: 1, limit: 1 }]);
});

test('Rubavu production exact reads reject unrelated rows and colliding object IDs', async () => {
    const unrelated = createParcelSource(descriptor, { fetchImpl: async () => response({ ...fixture.sample,
        features: [fixture.sample.features[1]], exceededTransferLimit: false }) });
    await assert.rejects(unrelated.queryIds([id(fixture.sample.features[0])]), /unexpected parcels/);
    const collision = createParcelSource(descriptor, { fetchImpl: async () => response(fixture.collision) });
    await assert.rejects(collision.queryIds([id(fixture.collision.features[0])]), /repeated or omitted an object ID/);
});

test('Rubavu service failures cannot become complete absence through the production factory', async () => {
    const source = createParcelSource(descriptor, { fetchImpl: async () => response({ error: { code: 403 } }) });
    await assert.rejects(source.queryIds([id(fixture.sample.features[0])]),
        error => error.code === 'parcel-source-blocked' && error.upstreamStatus === 403);
});
