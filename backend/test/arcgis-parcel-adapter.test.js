// Verifies canonical parcel identity, complete ArcGIS paging and geometry/error handling.
import { describe, expect, it, vi } from 'vitest';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    adapter: 'arcgis',
    id: 'ca-on-toronto',
    endpoint: 'https://gis.toronto.ca/arcgis/rest/services/cot_geospatial27/FeatureServer/36',
    idField: 'PARCELID',
    objectIdField: 'OBJECTID',
    idPrefix: 'CA-ON-TORONTO-',
    outFields: ['OBJECTID', 'PARCELID'],
    pageSize: 2,
    maxFeatures: 10
};

const polygon = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});

function feature(objectId, parcelId, geometry = polygon(-79.3838, 43.6522, -79.3832, 43.6528)) {
    return { type: 'Feature', id: objectId, properties: { OBJECTID: objectId, PARCELID: parcelId }, geometry };
}

function response(features, exceededTransferLimit = false) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit }) };
}

function makeFetch(pages) {
    const calls = [];
    const fetchImpl = vi.fn(async url => {
        const parsed = new URL(url);
        calls.push(parsed);
        const page = pages[calls.length - 1];
        if (page instanceof Error) throw page;
        return page;
    });
    return { fetchImpl, calls };
}

describe('createArcgisParcelSource', () => {
    it('pages a bounded query in object-id order and emits namespaced canonical IDs', async () => {
        const { fetchImpl, calls } = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(3, '1003')])
        ]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryBounds([-79.384, 43.652, -79.383, 43.653]);

        expect(result.type).toBe('FeatureCollection');
        expect(result.complete).toBe(true);
        expect(result.features.map(item => item.id)).toEqual([
            'CA-ON-TORONTO-1001', 'CA-ON-TORONTO-1002', 'CA-ON-TORONTO-1003'
        ]);
        expect(result.features[0].properties).toMatchObject({ sourceId: 'ca-on-toronto', sourceParcelId: '1001' });
        expect(result.features[0].properties.sourceProperties).toEqual({ OBJECTID: 1, PARCELID: '1001' });
        expect(calls).toHaveLength(2);
        for (const url of calls) {
            expect(url.searchParams.get('f')).toBe('geojson');
            expect(url.searchParams.get('inSR')).toBe('4326');
            expect(url.searchParams.get('outSR')).toBe('4326');
            expect(url.searchParams.get('orderByFields')).toBe('OBJECTID');
            expect(url.searchParams.get('outFields')).toBe('OBJECTID,PARCELID');
        }
        expect(calls[0].searchParams.get('resultOffset')).toBe('0');
        expect(calls[1].searchParams.get('resultOffset')).toBe('2');
    });

    it('uses the native parcel ID for canonical-ID lookup and reports absences only after complete paging', async () => {
        const { fetchImpl, calls } = makeFetch([
            response([feature(7, '7007'), feature(8, '8008')], true),
            response([feature(9, '9009')])
        ]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryIds([
            'CA-ON-TORONTO-7007', 'CA-ON-TORONTO-8008', 'CA-ON-TORONTO-9009', 'CA-ON-TORONTO-4040'
        ]);

        expect(result.features.map(item => item.id)).toEqual([
            'CA-ON-TORONTO-7007', 'CA-ON-TORONTO-8008', 'CA-ON-TORONTO-9009'
        ]);
        expect(result.absentIds).toEqual(['CA-ON-TORONTO-4040']);
        expect(result.complete).toBe(true);
        expect(calls[0].searchParams.get('where')).toContain('PARCELID IN');
        expect(calls[0].searchParams.get('where')).toContain('7007');
        expect(calls[0].searchParams.get('where')).toContain('9009');
    });

    it('rejects foreign, malformed, or empty IDs without making a request', async () => {
        const { fetchImpl } = makeFetch([]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        await expect(source.queryIds(['CA-ON-TORONTO-1', 'CA-ON-TORONTO-2 OR 1=1']))
            .rejects.toThrow(/id/i);
        await expect(source.queryIds(['US-NY-1'])).rejects.toThrow(/id/i);
        await expect(source.queryIds([])).rejects.toThrow(/id/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('uses a search envelope and then removes features that do not intersect the requested geometry', async () => {
        const target = { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]] };
        const { fetchImpl, calls } = makeFetch([response([
            feature(1, '1001', polygon(0.001, 0.001, 0.002, 0.002)),
            feature(2, '1002', polygon(0.008, 0.008, 0.009, 0.009))
        ])]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryGeometry(target);

        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['1001']);
        expect(result.complete).toBe(true);
        const envelope = calls[0].searchParams.get('geometry').split(',').map(Number);
        expect(envelope).toEqual([0, 0, 0.01, 0.01]);
        expect(calls[0].searchParams.get('geometryType')).toBe('esriGeometryEnvelope');
    });

    it('fails closed on upstream errors, malformed polygons, missing native IDs, or truncated paging', async () => {
        const sourceFor = page => createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([page]).fetchImpl });
        const upstreamError = { ok: true, status: 200, json: async () => ({ error: { message: 'service unavailable' } }) };
        await expect(sourceFor(upstreamError).queryBounds([-79.384, 43.652, -79.383, 43.653]))
            .rejects.toThrow();
        await expect(sourceFor(response([feature(1, 'broken', { type: 'LineString', coordinates: [[0, 0], [1, 1]] })]))
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();
        await expect(sourceFor(response([feature(1, null)]))
            .queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();

        const { fetchImpl } = makeFetch([response([feature(1, '1001'), feature(2, '1002')], true)]);
        const truncated = createArcgisParcelSource({ ...descriptor, maxFeatures: 2 }, { fetchImpl });
        await expect(truncated.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/complete|limit|page/i);
    });

    it('rejects malformed feature collections and empty pages that claim more results', async () => {
        const malformed = {
            ok: true, status: 200,
            json: async () => ({ type: 'FeatureCollection', features: 'not-an-array', exceededTransferLimit: false })
        };
        for (const page of [malformed, response([], true)]) {
            const source = createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([page]).fetchImpl });
            await expect(source.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow();
        }
    });

    it('rejects repeated object IDs across pages and duplicate parcel IDs with conflicting geometry', async () => {
        const repeatedPages = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(2, '1003')])
        ]);
        const repeatedSource = createArcgisParcelSource(descriptor, { fetchImpl: repeatedPages.fetchImpl });
        await expect(repeatedSource.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/object ID/i);

        const conflictingPages = makeFetch([
            response([feature(1, '1001'), feature(2, '1002')], true),
            response([feature(3, '1001', polygon(-79.38, 43.65, -79.379, 43.651))])
        ]);
        const conflictingSource = createArcgisParcelSource(descriptor, { fetchImpl: conflictingPages.fetchImpl });
        await expect(conflictingSource.queryBounds([-79.384, 43.652, -79.383, 43.653])).rejects.toThrow(/conflicting geometry/i);
    });

    it('supports MultiPolygon footprints and excludes parcel features inside a polygon hole', async () => {
        const multipolygon = {
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
                [[[0.02, 0], [0.03, 0], [0.03, 0.01], [0.02, 0.01], [0.02, 0]]]
            ]
        };
        const holedPolygon = {
            type: 'Polygon',
            coordinates: [
                [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]],
                [[0.003, 0.003], [0.007, 0.003], [0.007, 0.007], [0.003, 0.007], [0.003, 0.003]]
            ]
        };
        const { fetchImpl } = makeFetch([response([
            feature(1, '1001', polygon(0.001, 0.001, 0.002, 0.002)),
            feature(2, '1002', polygon(0.004, 0.004, 0.005, 0.005)),
            feature(3, '1003', polygon(0.021, 0.001, 0.022, 0.002))
        ])]);
        const source = createArcgisParcelSource(descriptor, { fetchImpl });

        const result = await source.queryGeometry(holedPolygon);

        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['1001']);
        // The multi-part footprint is accepted and its envelope is bounded to the component extents.
        const multipartSource = createArcgisParcelSource(descriptor, { fetchImpl: makeFetch([response([])]).fetchImpl });
        await expect(multipartSource.queryGeometry(multipolygon)).resolves.toMatchObject({ type: 'FeatureCollection', complete: true });
    });
});
