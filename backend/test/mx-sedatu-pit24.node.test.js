// Verify PIT24's safe native PAR_ID routing and unchanged multipart geometry in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'mx-sedatu-ran-pit24-parcelas-2020-wfs', adapter: 'wfs',
    endpoint: 'https://ide.sedatu.gob.mx/geoserver/ows', version: '2.0.0',
    featureType: 'geonode:a__24_PARCELAS_RAN_2020', geometryField: 'the_geom',
    idField: 'PAR_ID', idType: 'integer', idPrefix: 'MX-SEDATU-RAN-PIT24-2020-PAR_ID-',
    outFields: ['PAR_ID'], requestProperties: true, pageSize: 1, idBatchSize: 3,
    maxResponseBytes: 16777216
};
// Synthetic geometry exercises holes and multiple parts; it is not retained source proof.
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[-100.955, 22.219], [-100.954, 22.219], [-100.954, 22.220], [-100.955, 22.220], [-100.955, 22.219]],
        [[-100.9548, 22.2192], [-100.9548, 22.2193], [-100.9547, 22.2193], [-100.9547, 22.2192], [-100.9548, 22.2192]]],
    [[[-100.953, 22.219], [-100.952, 22.219], [-100.952, 22.220], [-100.953, 22.219]]]
] };
const ids = [4217110, 4217111, 4217113];
const canonicalIds = ids.map(id => descriptor.idPrefix + id);
const page = (nativeId, offset) => new Response(JSON.stringify({
    type: 'FeatureCollection', numberMatched: 3, numberReturned: 1,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
    features: [{ type: 'Feature', id: `a__24_PARCELAS_RAN_2020.${91258 + offset}`,
        properties: { PAR_ID: nativeId }, geometry }]
}));

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime}: safe WFS paging and independent exact PAR_ID reads preserve all geometry`, async () => {
        const requests = [];
        const adapter = factory(descriptor, { fetchImpl: async url => {
            const parsed = new URL(url), params = parsed.searchParams;
            requests.push(params);
            assert.equal(parsed.origin + parsed.pathname, descriptor.endpoint);
            assert.equal(params.get('typeNames'), descriptor.featureType);
            assert.equal(params.get('propertyName'), 'the_geom,PAR_ID');
            assert.equal(params.get('sortBy'), 'PAR_ID');
            assert.equal(params.get('srsName'), 'CRS:84');
            assert.equal(params.get('count'), '1');
            if (params.has('cql_filter')) assert.equal(params.get('cql_filter'), 'PAR_ID IN (4217110,4217111,4217113)');
            else assert.equal(params.get('bbox'), '-100.956,22.218,-100.951,22.221,CRS:84');
            const offset = Number(params.get('startIndex'));
            return page(ids[offset], offset);
        } });
        const area = await adapter.queryBounds([-100.956, 22.218, -100.951, 22.221]);
        const first = await adapter.queryIds(canonicalIds);
        const second = await adapter.queryIds(canonicalIds);
        assert.deepEqual(area.features.map(feature => feature.id), canonicalIds);
        assert.deepEqual(first, second);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.equal(requests.length, 9);
        assert.deepEqual(requests.slice(0, 3).map(params => params.get('startIndex')), ['0', '1', '2']);
        for (const feature of first.features) {
            assert.deepEqual(feature.geometry, geometry);
            assert.deepEqual(Object.keys(feature.properties.sourceProperties), ['PAR_ID']);
        }
    });

    test(`${runtime}: foreign and malformed IDs fail before network access`, async () => {
        const adapter = factory(descriptor, { fetchImpl: async () => assert.fail('Invalid IDs must not reach provider') });
        for (const id of ['foreign-4217110', descriptor.idPrefix + '4217110 OR 1=1', descriptor.idPrefix + '04217110']) {
            await assert.rejects(adapter.queryIds([id]), { status: 400 });
        }
    });

    test(`${runtime}: a missing native PAR_ID cannot become a transport-derived identity`, async () => {
        const adapter = factory(descriptor, { fetchImpl: async () => page(undefined, 0) });
        await assert.rejects(adapter.queryIds(canonicalIds), /missing or invalid native parcel ID/);
    });
}
