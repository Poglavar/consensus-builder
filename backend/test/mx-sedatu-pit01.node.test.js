import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'mx-sedatu-ran-pit01-parcelas-2020-wfs', adapter: 'wfs',
    endpoint: 'https://ide.sedatu.gob.mx/geoserver/ows', version: '1.0.0',
    featureType: 'geonode:a__01_PARCELAS_RAN_2020', geometryField: 'the_geom',
    idField: 'CLAVE', idType: 'string', idPrefix: 'MEX-RAN-PIT01-',
    idPattern: '^[0-9]{8}-[0-9]{19}$', outFields: ['CLAVE'], requestProperties: true,
    pageSize: 1, idBatchSize: 3, maxResponseBytes: 16777216
};
const nativeIds = ['01001046-0100000100000000013', '01001046-0100000100000000157'];
const ids = nativeIds.map(id => descriptor.idPrefix + id);
// Synthetic polygons exercise holes and disconnected components; no source proof is duplicated here.
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[-102.36, 21.87], [-102.35, 21.87], [-102.35, 21.88], [-102.36, 21.87]],
        [[-102.355, 21.872], [-102.354, 21.872], [-102.354, 21.873], [-102.355, 21.872]]],
    [[[-102.34, 21.87], [-102.33, 21.87], [-102.33, 21.88], [-102.34, 21.87]]]
] };
function payload(offset, { nativeId = nativeIds[offset], fid = offset } = {}) {
    return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 2,
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
        features: [{ type: 'Feature', id: `a__01_PARCELAS_RAN_2020.${fid}`,
            properties: { CLAVE: nativeId }, geometry }] }));
}

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime}: PIT1 CLAVE paging and repeated exact reads preserve leading zeroes and all rings`, async () => {
        const requests = [];
        const adapter = factory(descriptor, { fetchImpl: async url => {
            const parsed = new URL(url), params = parsed.searchParams;
            requests.push(params);
            assert.equal(parsed.origin + parsed.pathname, descriptor.endpoint);
            assert.equal(params.get('typeName'), descriptor.featureType);
            assert.equal(params.get('propertyName'), 'the_geom,CLAVE');
            assert.equal(params.get('sortBy'), 'CLAVE');
            assert.equal(params.get('srsName'), 'EPSG:4326');
            assert.equal(params.get('maxFeatures'), '1');
            assert.equal(params.get('count'), '1');
            if (params.has('cql_filter')) {
                assert.equal(params.get('cql_filter'), `CLAVE IN ('${nativeIds.join("','")}')`);
            } else assert.equal(params.get('bbox'), '-102.36,21.87,-102.33,21.89,EPSG:4326');
            const offset = Number(params.get('startIndex'));
            // Transport FIDs change between reads and must never enter the identity.
            return payload(offset, { fid: 100 * requests.length + offset });
        } });
        const bounds = await adapter.queryBounds([-102.36, 21.87, -102.33, 21.89]);
        const first = await adapter.queryIds(ids);
        const second = await adapter.queryIds(ids);
        assert.deepEqual(bounds.features.map(feature => feature.id), ids);
        assert.deepEqual(first, second);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.equal(requests.length, 6);
        assert.deepEqual(requests.map(params => params.get('startIndex')), ['0', '1', '0', '1', '0', '1']);
        for (const feature of first.features) {
            assert.deepEqual(feature.geometry, geometry);
            assert.equal(feature.properties.sourceParcelId, feature.id.slice(descriptor.idPrefix.length));
            assert.deepEqual(Object.keys(feature.properties.sourceProperties), ['CLAVE']);
        }
    });

    test(`${runtime}: malformed CLAVE values and foreign IDs cannot issue a query`, async () => {
        const adapter = factory(descriptor, { fetchImpl: async () => assert.fail('invalid ID reached provider') });
        for (const id of ['foreign-' + nativeIds[0], descriptor.idPrefix + nativeIds[0].slice(1),
            descriptor.idPrefix + nativeIds[0] + "' OR 1=1"]) {
            await assert.rejects(adapter.queryIds([id]), { status: 400 });
        }
    });

    test(`${runtime}: one CLAVE with conflicting geometry fails instead of replacing a parcel`, async () => {
        const adapter = factory(descriptor, { fetchImpl: async url => {
            const offset = Number(new URL(url).searchParams.get('startIndex'));
            const response = await payload(offset, { nativeId: nativeIds[0] }).json();
            if (offset) response.features[0].geometry.coordinates[0][0][1][0] += 0.001;
            return new Response(JSON.stringify(response));
        } });
        await assert.rejects(adapter.queryIds(ids), /conflicting geometry/);
    });
}
