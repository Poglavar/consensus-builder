// Keep SIGEF native UUID identity and safe WFS projection identical in backend and browser adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const uuids = ['808ac423-e98a-4810-8bc8-fa0bf7a75fdf', '6a691fa4-6129-4584-9b9b-bc2ef486cfce'];
const descriptor = {
    id: 'br-incra-geonode-parcels', adapter: 'wfs',
    endpoint: 'https://geonodeincra.serpro.gov.br/geoserver/ows',
    featureType: 'geonode:sigef_geo', version: '1.0.0',
    idField: 'parcela_codigo', idType: 'string', idPrefix: 'BR-INCRA-SIGEF-',
    idPattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    outFields: ['parcela_codigo'], geometryField: 'geometry', requestProperties: true,
    pageSize: 1, idBatchSize: 3, maxFeatures: 10, maxBboxKm2: 25, maxResponseBytes: 16777216
};
// Synthetic geometry avoids retaining another copy of live research polygons.
const geometry = { type: 'MultiPolygon', coordinates: [[[[-44.247, -2.582], [-44.246, -2.582],
    [-44.246, -2.581], [-44.247, -2.581], [-44.247, -2.582]]]] };
function provider() {
    const calls = [];
    let generation = 0;
    return { calls, fetchImpl: async url => {
        const u = new URL(url), q = u.searchParams;
        calls.push(u);
        assert.equal(u.origin + u.pathname, descriptor.endpoint);
        assert.equal(q.get('propertyName'), 'geometry,parcela_codigo');
        assert.equal(q.get('srsName'), 'EPSG:4326');
        assert.equal(q.get('sortBy'), 'parcela_codigo');
        const offset = Number(q.get('startIndex'));
        const requested = q.has('cql_filter') ? uuids.filter(id => q.get('cql_filter').includes(id)) : uuids;
        const row = requested.slice(offset, offset + 1).map(id => ({ type: 'Feature',
            id: `sigef_geo.${++generation}`, properties: { parcela_codigo: id }, geometry }));
        return Response.json({ type: 'FeatureCollection', totalFeatures: requested.length,
            numberMatched: requested.length, numberReturned: row.length,
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } }, features: row });
    } };
}
for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name}: SIGEF UUID exact reads survive changing transport IDs and preserve full geometry`, async () => {
        const mock = provider(), source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const ids = uuids.map(id => descriptor.idPrefix + id);
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(f => f.id), ids);
        assert.deepEqual(first.features.map(f => f.geometry), [geometry, geometry]);
        assert.deepEqual(first.absentIds, []);
        assert.equal(mock.calls.length, 4);
        assert.deepEqual(mock.calls.map(u => u.searchParams.get('startIndex')), ['0', '1', '0', '1']);
        const before = mock.calls.length;
        await assert.rejects(source.queryIds(['BR-INCRA-SIGEF-invalid']), /Invalid parcel ID/);
        assert.equal(mock.calls.length, before);
    });
    test(`${name}: SIGEF viewport reads page safely and retain native UUIDs`, async () => {
        const mock = provider(), source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        const result = await source.queryBounds([-44.248, -2.583, -44.245, -2.580]);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(f => f.id), uuids.map(id => descriptor.idPrefix + id));
        assert.ok(mock.calls.every(u => u.searchParams.get('bbox') === '-44.248,-2.583,-44.245,-2.58,EPSG:4326'));
        assert.deepEqual(result.features.map(f => f.geometry), [geometry, geometry]);
    });
}
