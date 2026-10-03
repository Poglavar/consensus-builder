import { describe, expect, it, vi } from 'vitest';
import { discoverCustomParcelSource } from '../parcels/custom-source-discovery.js';

const bbox = [-73.99, 40.70, -73.9895, 40.7005];
const polygon = { type: 'Polygon', coordinates: [[[-73.99,40.70],[-73.9898,40.70],[-73.9898,40.7002],[-73.99,40.7002],[-73.99,40.70]]] };
const feature = { type: 'Feature', id: 'CUSTOM-test-1', geometry: polygon, properties: {} };
const response = (body, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => body
});

function sourceFactory() {
    return vi.fn(() => ({
        queryBounds: async () => ({ complete: true, features: [feature] }),
        queryIds: async ids => ({ complete: true, features: ids.map(() => feature), absentIds: [] })
    }));
}

describe('discoverCustomParcelSource', () => {
    it.each([
        ['arcgis', 'https://data.example/arcgis/rest/services/Parcels/FeatureServer/0', async () => response({
            objectIdField: 'OBJECTID', fields: [
                { name: 'OBJECTID', type: 'esriFieldTypeOID' },
                { name: 'PARCEL_ID', type: 'esriFieldTypeString' }
            ]
        })],
        ['wfs', 'https://data.example/geoserver/wfs?service=WFS&typeName=tax:parcel&version=2.0.0', async () => response(
            '<xsd:schema><xsd:element name="parcel_id" type="xsd:integer"/></xsd:schema>')],
        ['ogc-api', 'https://data.example/collections/parcels/items', async url => response({
            itemPropertiesSchema: { properties: { parcel_id: { type: 'integer' } } }
        })],
        ['socrata', 'https://data.example/resource/abcd-1234.json', async () => response({ columns: [
            { fieldName: 'parcel_id', name: 'Parcel ID', dataTypeName: 'number' },
            { fieldName: 'the_geom', name: 'Geometry', dataTypeName: 'multipolygon' }
        ] })]
    ])('verifies a %s adapter with exact IDs', async (adapter, url, metadataResponse) => {
        const fetchImpl = vi.fn(metadataResponse);
        const createSource = sourceFactory();
        const result = await discoverCustomParcelSource({ url, city: 'nyc', metricSrid: 2263, bbox }, { fetchImpl, createSource });
        expect(result.descriptor.adapter).toBe(adapter);
        expect(result.descriptor.defaultForCity).toBe(false);
        expect(result.descriptor.cityIds).toEqual(['nyc']);
        expect(result.descriptor.id).toMatch(/^custom-[a-f0-9]{64}$/);
        expect(result.attempts.find(attempt => attempt.adapter === adapter).status).toBe('verified');
        expect(createSource).toHaveBeenCalledTimes(1);
    });

    it('requires a bounded, pinned complete snapshot before selecting the snapshot adapter', async () => {
        const fetchImpl = vi.fn(async () => response({
            type: 'FeatureCollection', complete: true, bbox: [-74, 40, -73, 41],
            features: [{ type: 'Feature', geometry: polygon, properties: { parcel_id: 'A-1' } }]
        }, { headers: { etag: '"release-1"', 'content-length': '200' } }));
        const result = await discoverCustomParcelSource({ url: 'https://data.example/parcels.geojson', city: 'nyc', metricSrid: 2263, bbox }, {
            fetchImpl, createSource: sourceFactory()
        });
        expect(result.descriptor.adapter).toBe('geojson-snapshot');
        expect(result.descriptor.expectedSnapshotFeatures).toBe(1);
        expect(result.descriptor.expectedEtag).toBe('"release-1"');
        expect(result.descriptor.bbox).toEqual([-74, 40, -73, 41]);
    });

    it('rejects a schema candidate if exact ID lookup differs from spatial geometry', async () => {
        const changed = { ...feature, geometry: { ...polygon, coordinates: [[[-73.99,40.70],[-73.9897,40.70],[-73.9897,40.7002],[-73.99,40.7002],[-73.99,40.70]]] } };
        const result = await discoverCustomParcelSource({
            url: 'https://data.example/arcgis/rest/services/Parcels/FeatureServer/0', city: 'nyc', metricSrid: 2263, bbox
        }, {
            fetchImpl: async () => response({ objectIdField: 'OBJECTID', fields: [
                { name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'PARCEL_ID', type: 'esriFieldTypeString' }
            ] }),
            createSource: () => ({ queryBounds: async () => ({ complete: true, features: [feature] }),
                queryIds: async () => ({ complete: true, features: [changed], absentIds: [] }) })
        }).catch(error => error);
        expect(result.code).toBe('no-available-adapter');
        expect(result.attempts[0].status).toBe('rejected');
    });

    it('stops after a blocked upstream response and returns safe, stable error metadata', async () => {
        const fetchImpl = vi.fn(async () => response('secret token=private https://data.example/private', { status: 403 }));
        const error = await discoverCustomParcelSource({
            url: 'https://data.example/arcgis/rest/services/Parcels/FeatureServer/0', city: 'nyc', metricSrid: 2263, bbox
        }, { fetchImpl, createSource: sourceFactory() }).catch(value => value);
        expect(error.code).toBe('parcel-source-blocked');
        expect(error.status).toBe(502);
        expect(error.upstreamStatus).toBe(403);
        expect(error.attempts).toHaveLength(5);
        expect(error.attempts[0].error.message).not.toMatch(/secret|private|https:/i);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
