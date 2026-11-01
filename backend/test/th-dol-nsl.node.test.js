// Locks the DOL WFS 1.0 wire settings and unchanged multipart/Z geometry in both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'th-dol-lpcpublic-nsl', adapter: 'wfs',
    endpoint: 'https://portal.dol.go.th/geoserver/LPCPUBLIC/ows',
    featureType: 'LPCPUBLIC:DOLNSL', version: '1.0.0', geometryField: 'geom',
    nativeIdMode: 'feature-id', featureIdParameter: 'featureID',
    idField: null, idType: 'string', idPrefix: 'TH-DOL-NSL-',
    idPattern: '^DOLNSL\\.[0-9]+$', outFields: [], requestProperties: true,
    responseSrid: 4326, pageSize: 100, maxFeatures: 1000, maxBboxKm2: 25
};
// Synthetic geometry, including a hole and a separate polygon; no provider dataset fixture.
const geometry = { type: 'MultiPolygon', coordinates: [
    [
        [[98.391, 7.876, 0], [98.392, 7.876, 0], [98.392, 7.877, 0], [98.391, 7.877, 0], [98.391, 7.876, 0]],
        [[98.3912, 7.8762, 0], [98.3912, 7.8763, 0], [98.3913, 7.8763, 0], [98.3912, 7.8762, 0]]
    ],
    [[[98.393, 7.876, 0], [98.394, 7.876, 0], [98.394, 7.877, 0], [98.393, 7.876, 0]]]
] };

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name}: DOL native-ID bounds witnesses preserve every ring and zero Z`, async () => {
        const requests = [];
        const source = await factory(descriptor, { fetchImpl: async input => {
            const url = new URL(input);
            requests.push(url.searchParams);
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 1,
                numberMatched: 1, numberReturned: 1,
                crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
                features: [{ type: 'Feature', id: 'DOLNSL.63090', properties: {}, geometry }] }));
        } });
        const bounds = [98.3908, 7.876, 98.3942, 7.8771];
        const result = await source.queryBounds(bounds);
        const exact = await source.queryIds(['TH-DOL-NSL-DOLNSL.63090']);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.deepEqual(exact.features[0].geometry, geometry);
        assert.equal(exact.features[0].properties.sourceParcelId, 'DOLNSL.63090');
        assert.deepEqual(exact.features[0].properties.sourceProperties, {});
        assert.deepEqual(exact.absentIds, []);
        assert.equal(requests.length, 3, 'bounds must witness native identity through the exact route');
        assert.equal(requests[0].get('bbox'), `${bounds.join(',')},EPSG:4326`);
        assert.equal(requests[1].get('featureID'), 'DOLNSL.63090');
        for (const params of requests) {
            assert.equal(params.get('version'), '1.0.0');
            assert.equal(params.get('typeName'), 'LPCPUBLIC:DOLNSL');
            assert.equal(params.get('propertyName'), 'geom');
            assert.equal(params.get('srsName'), 'EPSG:4326');
            assert.equal(params.has('sortBy'), false);
            assert.equal(params.has('cql_filter'), false);
        }
    });
}
