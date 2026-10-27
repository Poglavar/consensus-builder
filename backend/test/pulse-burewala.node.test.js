// Exercise the Vehari descriptor in both production factories, preserving complete source outlines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'pk-pulse-vehari-burewala-parcels', adapter: 'pulse-public',
    endpoint: 'https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer/37',
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer',
    idPrefix: 'PK-PULSE-VEHARI-OBJECTID-', outFields: ['OBJECTID'],
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', objectIdManifestCheck: 'id-rows', queryFormat: 'geojson',
    boundsSrid: 3857, boundsProjection: 'EPSG:3857', pageSize: 100,
    maxFeatures: 3000, maxBboxKm2: 1, maxResponseBytes: 16777216
};
// Synthetic outline extends beyond the query viewport and contains an interior ring.
const geometry = { type: 'Polygon', coordinates: [
    [[72.691, 30.168], [72.693, 30.168], [72.693, 30.17], [72.691, 30.17], [72.691, 30.168]],
    [[72.6911, 30.1681], [72.6911, 30.1682], [72.6912, 30.1682], [72.6912, 30.1681], [72.6911, 30.1681]]
] };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories['pulse-public']]]) {
    test(`${runtime} Vehari uses safe native-ID manifests and retains full geometry`, async () => {
        let bootstraps = 0;
        const source = factory(descriptor, { fetchImpl: async input => {
            if (input === 'https://lis.pulse.gop.pk/api/gis/token') {
                bootstraps++;
                return json({ success: true, token: 'synthetic-public-reader', expiresAt: new Date(Date.now() + 60000).toISOString() });
            }
            const url = new URL(input), p = url.searchParams;
            assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
            assert.equal(p.get('outFields'), 'OBJECTID');
            assert.equal(p.get('token'), 'synthetic-public-reader');
            assert.equal(p.has('returnCountOnly'), false);
            if (p.has('returnIdsOnly')) return json({ objectIdFieldName: 'OBJECTID', objectIds: [1894529] });
            if (p.get('returnGeometry') === 'false') return json({ features: [{ attributes: { OBJECTID: 1894529 } }] });
            assert.equal(p.get('objectIds'), '1894529');
            assert.equal(p.get('outSR'), '4326');
            assert.equal(p.has('geometry'), false);
            assert.equal(p.has('geometryPrecision'), false);
            return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 1894529,
                properties: { OBJECTID: 1894529 }, geometry }] });
        } });
        const id = descriptor.idPrefix + '1894529';
        for (const result of [await source.queryBounds([72.6915, 30.1685, 72.692, 30.169]),
            await source.queryIds([id]), await source.queryIds([id])]) {
            assert.equal(result.complete, true);
            assert.deepEqual(result.features.map(f => f.id), [id]);
            assert.deepEqual(result.features[0].geometry, geometry);
            assert.deepEqual(result.features[0].properties.sourceProperties, { OBJECTID: 1894529 });
            assert.equal(JSON.stringify(result).includes('synthetic-public-reader'), false);
        }
        assert.equal(bootstraps, 1);
        await assert.rejects(source.queryIds(['PK-PULSE-OKARA-1894529']), /different source/);
    });
    test(`${runtime} Vehari refuses incomplete manifests instead of reporting complete ground`, async () => {
        const source = factory(descriptor, { fetchImpl: async input => {
            if (input === 'https://lis.pulse.gop.pk/api/gis/token') return json({ success: true,
                token: 'synthetic-public-reader', expiresAt: new Date(Date.now() + 60000).toISOString() });
            return json(new URL(input).searchParams.has('returnIdsOnly')
                ? { objectIdFieldName: 'OBJECTID', objectIds: [1894529] }
                : { features: [{ attributes: { OBJECTID: 1894529 } }, { attributes: { OBJECTID: 1894506 } }] });
        } });
        await assert.rejects(source.queryBounds([72.6915, 30.1685, 72.692, 30.169]), /incomplete or invalid object-ID/);
    });
}
