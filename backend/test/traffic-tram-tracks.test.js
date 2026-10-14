// Protect the simulator's tram overlay from bbox clipping shortcuts and cross-section regressions.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TramTracks = require('../../frontend/traffic/tram-tracks.js');
const { offsetPolylinePlanar } = require('../../frontend/js/corridor-profile.js');

const BBOX = [0, 0, 10, 10];

function feature(osmId, coordinates, properties = {}) {
    return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { osm_id: osmId, railway: 'tram', gauge: '1000', ...properties },
    };
}

function collection(features, metadata = {}) {
    return { type: 'FeatureCollection', features, metadata };
}

describe('traffic tram track geometry', () => {
    it('clips a through-way at the requested bbox instead of dropping the whole way', () => {
        const records = TramTracks.fromGeoJSON(collection([
            feature(101, [[-2, 2], [2, 2], [12, 2]]),
        ]), BBOX);

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: 'tram:101:0', sourceWayId: '101', gaugeM: 1, trackCount: 1 });
        expect(records[0].points).toEqual([[0, 2], [2, 2], [10, 2]]);
    });

    it('splits outside excursions into separate fragments without drawing a shortcut', () => {
        const records = TramTracks.fromGeoJSON(collection([
            feature(202, [[1, 1], [3, 1], [12, 1], [12, 8], [8, 8], [8, 9], [12, 9]]),
        ]), BBOX);

        expect(records.map(record => record.id)).toEqual(['tram:202:0', 'tram:202:1']);
        expect(records[0].points).toEqual([[1, 1], [3, 1], [10, 1]]);
        expect(records[1].points).toEqual([[10, 8], [8, 8], [8, 9], [10, 9]]);
        expect(records[0].points.at(-1)).not.toEqual(records[1].points[0]);
    });

    it('keeps active tram ways once each and defaults an unspecified track count to one', () => {
        const records = TramTracks.fromGeoJSON(collection([
            feature(303, [[1, 1], [2, 2]]),
            feature(303, [[1, 1], [2, 2]], { name: 'duplicate extract copy' }),
            feature(404, [[2, 2], [3, 3]], { railway: 'rail' }),
            feature(505, [[3, 3], [4, 4]], { railway: 'tram', tracks: '2' }),
        ]), BBOX);

        expect(records.map(record => record.sourceWayId)).toEqual(['303', '505']);
        expect(records.map(record => record.trackCount)).toEqual([1, 2]);
    });

    it('keeps the OSM curve points instead of replacing the way with a straight street centerline', () => {
        const sourcePoints = [[1, 1], [2, 3], [4, 3], [5, 5]];
        const [record] = TramTracks.fromGeoJSON(collection([feature(606, sourcePoints)]), BBOX);
        const [track] = TramTracks.build([record], ([x, y]) => [x, y], offsetPolylinePlanar);

        expect(track.path.points).toEqual(sourcePoints);
        expect(track.path.points).toHaveLength(4);
        for (const rail of track.rails) {
            expect(rail.points.flat().every(Number.isFinite)).toBe(true);
            const [start, end] = rail.points;
            const centerMidpoint = [
                (sourcePoints[0][0] + sourcePoints[1][0]) / 2,
                (sourcePoints[0][1] + sourcePoints[1][1]) / 2,
            ];
            const railMidpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
            const dx = sourcePoints[1][0] - sourcePoints[0][0];
            const dy = sourcePoints[1][1] - sourcePoints[0][1];
            const signedDistance = ((railMidpoint[0] - centerMidpoint[0]) * -dy
                + (railMidpoint[1] - centerMidpoint[1]) * dx) / Math.hypot(dx, dy);
            expect(Math.abs(signedDistance)).toBeCloseTo(0.5);
        }
    });

    it('converts a 1000 mm tram gauge to a one metre rail gap', () => {
        const [record] = TramTracks.fromGeoJSON(collection([feature(707, [[0, 1], [10, 1]])]), BBOX);
        const [track] = TramTracks.build([record], ([x, y]) => [x, y], offsetPolylinePlanar);

        expect(track.gaugeM).toBe(1);
        expect(track.rails).toHaveLength(2);
        expect(track.rails.map(rail => rail.points[0][1])).toEqual([0.5, 1.5]);
        expect(track.bedWidth).toBe(2.1);
        expect(track.railWidth).toBe(0.1);
    });

    it('places two track centers 2.8 m apart and builds four rails', () => {
        const [record] = TramTracks.fromGeoJSON(collection([
            feature(808, [[0, 1], [10, 1]], { tracks: '2' }),
        ]), BBOX);
        const tracks = TramTracks.build([record], ([x, y]) => [x, y], offsetPolylinePlanar);

        expect(tracks).toHaveLength(2);
        expect(tracks.map(track => track.path.points[0][1] - 1)).toEqual([-1.4, 1.4]);
        const railOffsets = tracks.flatMap(track => track.rails.map(rail => rail.points[0][1] - 1));
        [-1.9, -0.9, 0.9, 1.9].forEach((offset, index) => {
            expect(railOffsets[index]).toBeCloseTo(offset);
        });
    });

    it('rejects missing or truncated source data and malformed tram geometry', () => {
        expect(() => TramTracks.fromGeoJSON(null, BBOX)).toThrow();
        expect(() => TramTracks.fromGeoJSON(collection([], { truncated: true }), BBOX)).toThrow(/truncated/i);
        expect(() => TramTracks.fromGeoJSON(collection([
            feature(909, [[1, 1], [Number.NaN, 2]]),
        ]), BBOX)).toThrow(/geometry/i);
    });
});
