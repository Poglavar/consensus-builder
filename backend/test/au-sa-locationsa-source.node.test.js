// Location SA strata keys can name several outlines. Preserve each complete Esri polygon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { nativeGeometryHash } from '../parcels/arcgis-source.js';

const descriptor = {
    id: 'au-sa-locationsa-parcel-cadastre', adapter: 'arcgis',
    endpoint: 'https://lsa4.geohub.sa.gov.au/server/rest/services/LSA/LocationSAViewerV34/MapServer/124/query',
    idField: 'planparcel', idType: 'string', objectIdField: 'objectid',
    idPrefix: 'AU-SA-PARCEL-', outFields: ['objectid', 'parcel_id', 'planparcel'],
    queryFormat: 'esri-json', boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
    identityKind: 'native-key-geometry-sha256-v1', pageSize: 1, maxResponseBytes: 16777216
};
const rings = [0, 0.0002].map(offset => [[[138.599 + offset, -34.891],
    [138.5991 + offset, -34.891], [138.5991 + offset, -34.8911],
    [138.599 + offset, -34.8911], [138.599 + offset, -34.891]]]);
const ids = rings.map(coordinates => descriptor.idPrefix + 'S13145UN1-'
    + nativeGeometryHash({ type: 'Polygon', coordinates }));

function provider({ wrongCount = false } = {}) {
    let generation = 0;
    return { fetchImpl: async input => {
        const url = new URL(input), params = url.searchParams;
        assert.equal(url.origin + url.pathname, descriptor.endpoint);
        let payload;
        if (params.get('returnCountOnly') === 'true') {
            generation += 10; // OIDs may change; durable references must not.
            payload = { count: wrongCount ? 3 : 2 };
        } else if (params.get('returnIdsOnly') === 'true') {
            payload = { objectIdFieldName: 'objectid', objectIds: [generation, generation + 1] };
        } else {
            assert.equal(params.get('outFields'), descriptor.outFields.join(','));
            assert.equal(params.get('outSR'), '4326');
            assert.equal(params.get('f'), 'json');
            assert.equal(params.get('returnTrueCurves'), 'true');
            for (const field of ['geometryPrecision', 'maxAllowableOffset']) assert.equal(params.has(field), false);
            const objectId = Number(params.get('objectIds'));
            payload = { geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
                features: [{ attributes: { objectid: objectId, parcel_id: 'S13145   U1', planparcel: 'S13145UN1' },
                    geometry: { rings: rings[objectId - generation] } }], exceededTransferLimit: false };
        }
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    } };
}

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: Location SA retains distinct outlines for repeated native strata keys`, async () => {
        const source = factory(descriptor, provider());
        const bounds = await source.queryBounds([138.5989, -34.8912, 138.5994, -34.8909]);
        assert.equal(bounds.complete, true);
        assert.deepEqual(bounds.features.map(feature => feature.id), ids);
        for (const requested of [ids, [ids[1]]]) {
            const first = await source.queryIds(requested), second = await source.queryIds(requested);
            for (const result of [first, second]) {
                assert.equal(result.complete, true);
                assert.deepEqual(result.absentIds, []);
                assert.deepEqual(result.features.map(feature => feature.id), requested);
                for (const feature of result.features) {
                    assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: rings[ids.indexOf(feature.id)] });
                    assert.equal(feature.properties.sourceNativeParcelId, 'S13145UN1');
                }
            }
            assert.notEqual(first.features[0].properties.sourceProperties.objectid,
                second.features[0].properties.sourceProperties.objectid);
        }
    });
    test(`${runtime}: Location SA rejects incomplete manifests`, async () => {
        const source = factory(descriptor, provider({ wrongCount: true }));
        await assert.rejects(source.queryIds(ids), /incomplete or invalid object-ID list/);
    });
}
