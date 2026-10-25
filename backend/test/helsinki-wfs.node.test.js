// Verify Helsinki's safe WFS requests, reserved integer ID filter and unchanged multipart geometry in both runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'fi-helsinki-city-kiinteisto-alue-wfs', adapter: 'wfs',
    endpoint: 'https://kartta.hel.fi/ws/geoserver/avoindata/wfs', version: '1.1.0',
    featureType: 'avoindata:Kiinteisto_alue', geometryField: 'geom',
    idField: 'id', idType: 'integer', idPrefix: 'FI-HEL-KIINTEISTO-',
    outFields: ['id'], requestProperties: true, filterBoundsGeometry: true,
    pageSize: 1, maxFeatures: 10, maxResponseBytes: 16777216
};
const geometry = { type: 'MultiPolygon', coordinates: [[[
    [24.922, 60.215], [24.923, 60.215], [24.923, 60.216], [24.922, 60.216], [24.922, 60.215]
]]] };
const outside = { type: 'Polygon', coordinates: [[
    [24.92, 60.21], [24.921, 60.21], [24.921, 60.211], [24.92, 60.21]
]] };

for (const [runtime, factory] of [['backend', createWfsParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${runtime}: Helsinki pages before intersection filtering and repeats exact integer IDs`, async () => {
        const requests = [];
        const adapter = factory(descriptor, { fetchImpl: async url => {
            const params = new URL(url).searchParams;
            requests.push(params);
            assert.equal(params.get('typeName'), descriptor.featureType);
            assert.equal(params.get('propertyName'), 'geom,id');
            assert.equal(params.get('srsName'), 'CRS:84');
            assert.equal(params.get('sortBy'), 'id');
            const exact = params.has('cql_filter');
            if (exact) assert.equal(params.get('cql_filter'), '"id" IN (10990)');
            else assert.equal(params.get('bbox'), '24.922,60.215,24.923,60.216,CRS:84');
            const inside = exact || Number(params.get('startIndex')) === 1;
            const id = inside ? 10990 : 6491;
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: exact ? 1 : 2,
                features: [{ type: 'Feature', id: `Kiinteisto_alue.${id}`, properties: { id }, geometry: inside ? geometry : outside }] }));
        } });
        const bounded = await adapter.queryBounds([24.922, 60.215, 24.923, 60.216]);
        assert.equal(bounded.complete, true);
        assert.deepEqual(bounded.features.map(f => f.id), ['FI-HEL-KIINTEISTO-10990']);
        assert.deepEqual(requests.map(p => p.get('startIndex')), ['0', '1']);
        const first = await adapter.queryIds(['FI-HEL-KIINTEISTO-10990']);
        const second = await adapter.queryIds(['FI-HEL-KIINTEISTO-10990']);
        assert.deepEqual(first, second);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features[0].geometry, geometry);
        assert.deepEqual(first.features[0].properties.sourceProperties, { id: 10990 });
        await assert.rejects(adapter.queryIds(['FI-HEL-KIINTEISTO-10990 OR 1=1']), /Invalid parcel ID/);
        assert.equal(requests.length, 4);
    });
}
