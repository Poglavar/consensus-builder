// Verifies fixed-form snapshot reads and complete, non-overlapping native parcel groups.
import { describe, expect, it, vi } from 'vitest';
import { createGeojsonSnapshotParcelSource } from '../parcels/geojson-snapshot-source.js';

const descriptor = {
    id: 'accra-publisher', endpoint: 'https://example.org/parcels', idPrefix: 'GH-ACC-',
    idFields: ['parcelid'], outFields: ['parcelid', 'parcelcode'], parcelNumberField: 'parcelcode',
    nativeGeometryMode: 'parts', disjointParts: true, partMatchFields: ['parcelcode'],
    requestForm: { f: 'geojson', where: '1=1' }, maxSnapshotBytes: 100000, maxSnapshotFeatures: 100,
    maxFeatures: 100, maxBboxKm2: 25
};
const polygon = (west, east, south = 5.55, north = 5.551) => ({ type: 'Polygon', coordinates: [[
    [west, south], [east, south], [east, north], [west, north], [west, south]
]] });
const part = (geometry, parcelid = 417, parcelcode = 'GA-417') => ({ type: 'Feature', geometry,
    properties: { parcelid, parcelcode } });
const collection = features => ({ type: 'FeatureCollection', features });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/geo+json' } });
const source = (features, changes = {}, fetchImpl = vi.fn(async () => response(collection(features)))) =>
    createGeojsonSnapshotParcelSource({ ...descriptor, ...changes }, { fetchImpl });
const id = 'GH-ACC-417';

describe('GeoJSON snapshot disjoint parcel components', () => {
    it('POSTs the fixed form and merges complete PID groups before bounds, exact-ID and footprint reads', async () => {
        const fetchImpl = vi.fn(async (_url, options) => response(collection([
            part(polygon(0.001, 0.002)), part(polygon(0.002, 0.003))
        ])));
        const parcels = source([], {}, fetchImpl);
        const boundsResult = await parcels.queryBounds([0.0009, 5.5499, 0.0021, 5.5511]);
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, request] = fetchImpl.mock.calls[0];
        expect(url).toBe(descriptor.endpoint);
        expect(request.method).toBe('POST');
        expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(request.body).toBe('f=geojson&where=1%3D1');
        expect(boundsResult.features).toHaveLength(1);
        expect(boundsResult.features[0].properties).toMatchObject({ parcelId: id, sourcePartCount: 2 });
        expect(boundsResult.features[0].geometry.type).toBe('Polygon');

        const exact = await parcels.queryIds([id]);
        const footprint = await parcels.queryGeometry(polygon(0.0025, 0.0031));
        expect(exact.features[0].geometry).toEqual(boundsResult.features[0].geometry);
        expect(footprint.features[0].geometry).toEqual(boundsResult.features[0].geometry);
        expect(exact.features[0].properties.sourcePartCount).toBe(2);
        expect(footprint.features[0].properties.sourcePartCount).toBe(2);
    });

    it('keeps the existing GET snapshot request when no fixed form is configured', async () => {
        const fetchImpl = vi.fn(async () => response(collection([part(polygon(0.001, 0.002))])));
        const parcels = source([], { requestForm: undefined }, fetchImpl);
        await parcels.queryBounds([0.0009, 5.5499, 0.0021, 5.5511]);
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Accept: 'application/geo+json, application/json' } });
        expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('method');
        expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');
    });

    it('keeps duplicate native IDs rejected unless component mode is explicitly configured', async () => {
        const duplicate = [part(polygon(0.001, 0.002)), part(polygon(0.003, 0.004))];
        const parcels = source(duplicate, { nativeGeometryMode: undefined, disjointParts: undefined, partMatchFields: undefined });
        await expect(parcels.queryBounds([0.0009, 5.5499, 0.0041, 5.5511])).rejects.toThrow(/repeated a native parcel identity/);
    });

    it('rejects overlapping components and changed parcel references', async () => {
        const overlapping = source([part(polygon(0.001, 0.0025)), part(polygon(0.002, 0.003))]);
        await expect(overlapping.queryBounds([0.0009, 5.5499, 0.0031, 5.5511])).rejects.toThrow(/complete parcel/);

        const changedReference = source([part(polygon(0.001, 0.002)), part(polygon(0.002, 0.003), 417, 'DIFFERENT')]);
        await expect(changedReference.queryBounds([0.0009, 5.5499, 0.0031, 5.5511])).rejects.toThrow(/inconsistent administrative references/);
    });

    it('validates bounded fixed form fields and required component references', async () => {
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, requestForm: { f: 4 } })).toThrow(/descriptor/);
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor,
            requestForm: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, 'x'])) })).toThrow(/descriptor/);
        const missingReference = source([{ type: 'Feature', geometry: polygon(0.001, 0.002), properties: { parcelid: 417 } }]);
        await expect(missingReference.queryBounds([0.0009, 5.5499, 0.0021, 5.5511])).rejects.toThrow(/administrative references/);
    });
});
