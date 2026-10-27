// Verify Pakpattan Urban confinement and unchanged geometry in both production runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const endpoint = 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/26';
const filters = { District: 'Pakpattan', Tehsil: 'Pakpattan', Mouza: 'Pakpattan Urban' };
const descriptor = {
    id: 'pk-pulse-pakpattan-cadastral', adapter: 'pulse-public', endpoint,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'PK-PULSE-PAKPATTAN-', outFields: ['OBJECTID', ...Object.keys(filters)],
    attributeFilters: filters, queryFormat: 'geojson', boundsQueryMode: 'object-ids',
    idsQueryMode: 'object-ids', boundsSrid: 3857, boundsProjection: 'EPSG:3857',
    pageSize: 100, maxFeatures: 3000, maxBboxKm2: 1, maxResponseBytes: 16777216
};
const id = descriptor.idPrefix + '13943633';
// Synthetic full outline extends beyond the requested viewport and contains a hole.
const geometry = { type: 'Polygon', coordinates: [
    [[73.395, 30.359], [73.397, 30.359], [73.397, 30.361], [73.395, 30.361], [73.395, 30.359]],
    [[73.3952, 30.3592], [73.3952, 30.3593], [73.3953, 30.3593], [73.3953, 30.3592], [73.3952, 30.3592]]
] };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories['pulse-public']]]) {
    function reader(mouza = filters.Mouza) {
        return factory(descriptor, { fetchImpl: async input => {
            if (input === 'https://lis.pulse.gop.pk/api/gis/token') return json({ success: true,
                token: 'synthetic-reader', expiresAt: new Date(Date.now() + 60000).toISOString() });
            const url = new URL(input), p = url.searchParams;
            assert.equal(url.origin + url.pathname, endpoint + '/query');
            for (const [field, value] of Object.entries(filters)) assert.ok(p.get('where').includes(`${field} = '${value}'`));
            assert.equal(p.get('outFields'), p.has('returnCountOnly') || p.has('returnIdsOnly')
                ? 'OBJECTID' : descriptor.outFields.join(','));
            if (p.has('returnCountOnly')) return json({ count: 1 });
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [13943633] });
            assert.equal(p.get('outSR'), '4326');
            assert.equal(p.has('geometry'), false);
            assert.equal(p.has('geometryPrecision'), false);
            return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 13943633,
                properties: { OBJECTID: 13943633, ...filters, Mouza: mouza }, geometry }] });
        } });
    }
    test(`${runtime} Pakpattan confines manifest and exact reads and preserves full polygons`, async () => {
        const source = reader();
        const bounds = await source.queryBounds([73.3955, 30.3595, 73.396, 30.36]);
        const first = await source.queryIds([id]);
        const second = await source.queryIds([id]);
        for (const result of [bounds, first, second]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id), [id]);
            assert.deepEqual(result.features[0].geometry, geometry);
            assert.equal(JSON.stringify(result).includes('synthetic-reader'), false);
            assert.deepEqual(result.features[0].properties.sourceProperties, { OBJECTID: 13943633, ...filters });
        }
        assert.deepEqual(first.features, second.features);
    });
    test(`${runtime} Pakpattan rejects out-of-scope rows when the provider ignores its filter`, async () => {
        await assert.rejects(reader('Arifwala').queryIds([id]), /outside the configured ground status/);
    });
}
