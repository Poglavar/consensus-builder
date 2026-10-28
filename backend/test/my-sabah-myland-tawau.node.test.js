// Synthetic two-city regression: Tawau shares Sabah's production adapter with Sandakan.
import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../../frontend/data/source-catalog.json' with { type: 'json' };
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const profile = catalog.sources.find(source => source.id === 'my-sabah-myland-lot-ml12');
const descriptor = { ...profile, cityIds: [...new Set([...profile.cityIds, 'tawau'])], minRequestIntervalMs: 100 };
const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.0001, y],
    [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]] });
const fixtures = [
    { id: 'lot.53', geometry: square(117.898, 4.253), bounds: [117.8979, 4.2529, 117.8982, 4.2532] },
    { id: 'lot.49', geometry: square(118.073, 5.866), bounds: [118.0729, 5.8659, 118.0732, 5.8662] }
];

for (const [name, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`${name}: shared Sabah profile keeps Tawau and Sandakan bounds and exact IDs distinct`, async () => {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async (url, options) => {
            const params = new URL(url).searchParams;
            requests.push(params);
            assert.equal(params.get('propertyName'), 'geom');
            assert.equal(params.get('srsName'), 'EPSG:4326');
            assert.equal(options.cache, 'no-store');
            const nativeIds = params.get('featureID')?.split(',');
            const bbox = params.get('bbox')?.split(',').slice(0, 4).map(Number);
            const rows = fixtures.filter(row => nativeIds ? nativeIds.includes(row.id)
                : row.geometry.coordinates[0][0][0] >= bbox[0] && row.geometry.coordinates[0][0][0] <= bbox[2]
                && row.geometry.coordinates[0][0][1] >= bbox[1] && row.geometry.coordinates[0][0][1] <= bbox[3]);
            return new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: rows.length,
                features: rows.map(row => ({ type: 'Feature', id: row.id, properties: {}, geometry: row.geometry })),
                crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } } }));
        } });
        for (const fixture of fixtures) {
            const result = await source.queryBounds(fixture.bounds);
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(feature => feature.id), [descriptor.idPrefix + fixture.id]);
            assert.deepEqual(result.features[0].geometry, fixture.geometry);
        }
        assert.equal(requests.length, 4, 'Each city bounds read has its own live exact-ID witness');
        const repeated = await source.queryBounds(fixtures[0].bounds);
        assert.equal(repeated.features[0].id, descriptor.idPrefix + 'lot.53');
        assert.equal(requests.length, 4, 'The Tawau block remains distinct in the shared source cache');
        for (let repeat = 0; repeat < 2; repeat++) {
            const result = await source.queryIds([descriptor.idPrefix + 'lot.53']);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.deepEqual(result.features[0].geometry, fixtures[0].geometry);
        }
        assert.equal(requests.length, 6, 'Exact reads bypass both cities bounds caches');
        assert.equal(requests[0].get('bbox'), '117.895,4.25,117.9,4.255,CRS:84');
        assert.equal(requests[2].get('bbox'), '118.07,5.865,118.075,5.87,CRS:84');
    });
}
