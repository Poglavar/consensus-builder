// Verify Joharabad locality confinement and full native geometry in both PULSE runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/15';
const descriptor = {
    id: 'pk-pulse-khushab-parcels', adapter: 'pulse-public', endpoint,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'pk-pulse-khushab-OBJECTID-', outFields: ['OBJECTID', 'QH', 'PC', 'Mouza'],
    attributeFilters: { QH: 'Jauharabad', PC: 'Jauharabad', Mouza: 'Jauharabad' },
    queryFormat: 'geojson', boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    boundsSrid: 3857, boundsProjection: 'EPSG:3857', pageSize: 100,
    maxFeatures: 3000, maxBboxKm2: 25, maxResponseBytes: 16777216
};
const id = descriptor.idPrefix + '4919168';
// Synthetic polygon extends past the queried viewport and contains a hole.
const geometry = { type: 'Polygon', coordinates: [
    [[72.28, 32.30], [72.29, 32.30], [72.29, 32.31], [72.28, 32.31], [72.28, 32.30]],
    [[72.282, 32.302], [72.282, 32.303], [72.283, 32.303], [72.283, 32.302], [72.282, 32.302]]
] };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories['pulse-public']]]) {
    function reader(mouza = 'Jauharabad') {
        return factory(descriptor, { fetchImpl: async input => {
            if (input === 'https://lis.pulse.gop.pk/api/gis/token') return json({ success: true,
                token: 'synthetic-public-reader', expiresAt: new Date(Date.now() + 60000).toISOString() });
            const url = new URL(input), p = url.searchParams;
            assert.equal(url.origin + url.pathname, endpoint + '/query');
            for (const field of ['QH', 'PC', 'Mouza']) assert.ok(p.get('where').includes(`${field} = 'Jauharabad'`));
            assert.equal(p.get('outFields'), p.has('returnCountOnly') || p.has('returnIdsOnly')
                ? 'OBJECTID' : descriptor.outFields.join(','));
            if (p.has('returnCountOnly')) return json({ count: 1 });
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [4919168] });
            assert.equal(p.get('outSR'), '4326');
            assert.equal(p.has('geometry'), false);
            assert.equal(p.has('geometryPrecision'), false);
            return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 4919168,
                properties: { OBJECTID: 4919168, QH: 'Jauharabad', PC: 'Jauharabad', Mouza: mouza }, geometry }] });
        } });
    }
    test(`${runtime} Khushab confines every manifest/exact read to Joharabad and preserves full geometry`, async () => {
        const source = reader();
        const bounds = await source.queryBounds([72.284, 32.304, 72.285, 32.305]);
        const first = await source.queryIds([id]);
        const second = await source.queryIds([id]);
        for (const result of [bounds, first, second]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id), [id]);
            assert.deepEqual(result.features[0].geometry, geometry);
            assert.equal(JSON.stringify(result).includes('synthetic-public-reader'), false);
            assert.deepEqual(result.features[0].properties.sourceProperties,
                { OBJECTID: 4919168, QH: 'Jauharabad', PC: 'Jauharabad', Mouza: 'Jauharabad' });
        }
        assert.deepEqual(first.features, second.features);
    });
    test(`${runtime} Khushab refuses polygons outside the configured Mouza even if provider ignores SQL`, async () => {
        await assert.rejects(reader('Mangoor').queryIds([id]), /outside the configured ground status/);
    });
}
