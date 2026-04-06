import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    computeBoundsFromRings,
    geoJsonToEsriRings,
    getExistingRoadUnion,
    parseBboxParam,
    queryFeatureService,
    transformCoordinates
} from '../utils/helpers.js';

describe('helpers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('parses valid bbox params and rejects invalid ones', () => {
        expect(parseBboxParam('1,2,3,4')).toEqual([1, 2, 3, 4]);
        expect(parseBboxParam('1,2,3')).toBeNull();
        expect(parseBboxParam('4,2,3,1')).toBeNull();
        expect(parseBboxParam('1,2,three,4')).toBeNull();
    });

    it('converts GeoJSON polygons and multipolygons to Esri rings', () => {
        expect(geoJsonToEsriRings({
            type: 'Polygon',
            coordinates: [[[1, 2], [3, 4], [1, 2]]]
        })).toEqual([[[1, 2], [3, 4], [1, 2]]]);

        expect(geoJsonToEsriRings({
            type: 'MultiPolygon',
            coordinates: [
                [[[1, 2], [3, 4], [1, 2]]],
                [[[5, 6], [7, 8], [5, 6]]]
            ]
        })).toEqual([
            [[1, 2], [3, 4], [1, 2]],
            [[5, 6], [7, 8], [5, 6]]
        ]);

        expect(geoJsonToEsriRings({ type: 'Point', coordinates: [1, 2] })).toEqual([]);
    });

    it('computes bounds from rings', () => {
        expect(computeBoundsFromRings([])).toBeNull();
        expect(computeBoundsFromRings([
            [[1, 5], [3, 2], [2, 7]],
            [[-1, 4], [8, 9]]
        ])).toEqual({ minX: -1, minY: 2, maxX: 8, maxY: 9 });
    });

    it('returns coordinates unchanged when SRIDs already match', async () => {
        const coords = [[[1, 2], [3, 4]]];

        await expect(transformCoordinates(coords, 4326, 4326, { query: vi.fn() })).resolves.toBe(coords);
    });

    it('transforms coordinates through the database and falls back on query errors', async () => {
        const pool = {
            query: vi.fn()
                .mockResolvedValueOnce({ rows: [{ x: 10, y: 20 }] })
                .mockResolvedValueOnce({ rows: [{ x: 30, y: 40 }] })
        };

        await expect(transformCoordinates([[[1, 2], [3, 4]]], 4326, 3765, pool)).resolves.toEqual([[[10, 20], [30, 40]]]);

        const failingPool = {
            query: vi.fn().mockRejectedValue(new Error('transform failed'))
        };

        await expect(transformCoordinates([[[1, 2]]], 4326, 3765, failingPool)).resolves.toEqual([[[1, 2]]]);
    });

    it('queries the feature service and surfaces HTTP and ArcGIS errors', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ features: [{ attributes: { OBJECTID: 1 } }] })
        }).mockResolvedValueOnce({
            ok: false,
            status: 503
        }).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ error: { message: 'Bad geometry', details: ['detail'] } })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(queryFeatureService({
            rings: [],
            spatialReference: { wkid: 3765 }
        }, 'https://example.test/query', { tolerance: 2 })).resolves.toEqual([{ attributes: { OBJECTID: 1 } }]);
        expect(fetchMock.mock.calls[0][0]).toContain('tolerance=2');
        expect(fetchMock.mock.calls[0][0]).toContain('inSR=3765');

        await expect(queryFeatureService({ rings: [] }, 'https://example.test/query')).rejects.toThrow('Feature service request failed with HTTP 503');
        await expect(queryFeatureService({ rings: [] }, 'https://example.test/query')).rejects.toThrow('Feature service error: Bad geometry Details: detail');
    });

    it('returns road union from classification view', async () => {
        const client = {
            query: vi.fn()
                .mockResolvedValueOnce({ rows: [{ geom: Buffer.from('road') }] })
        };

        await expect(getExistingRoadUnion(client, [1, 2, 3, 4])).resolves.toEqual(Buffer.from('road'));
        expect(client.query).toHaveBeenCalledTimes(1);
        expect(client.query.mock.calls[0][0]).toContain('road_parcel_classification');
    });

    it('falls back to dgu_road_usage when classification view is missing', async () => {
        const missingView = new Error('view missing');
        missingView.code = '42P01';

        const client = {
            query: vi.fn()
                .mockRejectedValueOnce(missingView)
                .mockResolvedValueOnce({ rows: [{ geom: Buffer.from('dgu-road') }] })
        };

        await expect(getExistingRoadUnion(client, [1, 2, 3, 4])).resolves.toEqual(Buffer.from('dgu-road'));
        expect(client.query).toHaveBeenCalledTimes(2);
        expect(client.query.mock.calls[1][0]).toContain('dgu_road_usage');
    });

    it('returns null when both view and table are missing', async () => {
        const missingTable = new Error('missing');
        missingTable.code = '42P01';

        const client = {
            query: vi.fn()
                .mockRejectedValueOnce(missingTable)
                .mockRejectedValueOnce(missingTable)
        };

        await expect(getExistingRoadUnion(client, null)).resolves.toBeNull();
    });

    it('rethrows non-ignorable errors from road union lookup', async () => {
        const client = {
            query: vi.fn().mockRejectedValue(new Error('database offline'))
        };

        await expect(getExistingRoadUnion(client, null)).rejects.toThrow('database offline');
    });
});