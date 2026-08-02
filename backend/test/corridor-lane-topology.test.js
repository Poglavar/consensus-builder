// Verifies lane-divider lineage across width changes and crossroads without a browser or renderer.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    build,
    splitDashedPolyline,
} = require('../../frontend/js/corridor-lane-topology.js');
const {
    buildCorridorLaneMarkingsForEntries,
} = require('../../frontend/js/corridor-profile.js');

function section(id, from, to, laneCount, corridorId = 'road') {
    const laneWidth = 3;
    const offsets = Array.from(
        { length: Math.max(0, laneCount - 1) },
        (_, index) => (index + 1 - laneCount / 2) * laneWidth,
    );
    const boundaries = Array.from(
        { length: laneCount + 1 },
        (_, index) => (index - laneCount / 2) * laneWidth,
    );
    const pathAt = (offset, kind) => ({
        offset,
        kind,
        points: [[from, offset], [to, offset]],
    });
    return {
        id,
        corridorId,
        centerline: [[from, 0], [to, 0]],
        paths: offsets.map(offset => pathAt(offset, 'lane')),
        boundaryPaths: boundaries.map((offset, index) => pathAt(
            offset,
            index === 0 || index === boundaries.length - 1 ? 'edge' : 'lane',
        )),
    };
}

function endpointOffsets(result, side) {
    return result.paths
        .map(path => path.points[side === 'start' ? 0 : path.points.length - 1][1])
        .sort((a, b) => a - b);
}

describe('corridor lane topology', () => {
    it('uses both old curbs when two lanes expand to four', () => {
        const results = build([
            section('before', 0, 40, 2),
            section('after', 40, 100, 4),
        ]);

        expect(endpointOffsets(results[1], 'start')).toEqual([-3, 0, 3]);
        expect(endpointOffsets(results[1], 'end')).toEqual([-3, 0, 3]);
    });

    it('keeps the temporary extra lane on one side through a 4→5→4 sequence', () => {
        const results = build([
            section('before', 0, 40, 4),
            section('wider', 40, 120, 5),
            section('after', 120, 180, 4),
        ]);

        expect(endpointOffsets(results[1], 'start')).toEqual([-6, -3, 0, 3]);
        expect(endpointOffsets(results[1], 'end')).toEqual([-6, -3, 0, 3]);
    });

    it('pairs both straight-through roads at a four-way intersection', () => {
        const horizontalBefore = section('west', -50, 0, 3, 'horizontal');
        const horizontalAfter = section('east', 0, 50, 3, 'horizontal');
        const rotate = entry => ({
            ...entry,
            centerline: entry.centerline.map(([x, y]) => [y, x]),
            paths: entry.paths.map(path => ({
                ...path,
                points: path.points.map(([x, y]) => [y, x]),
            })),
            boundaryPaths: entry.boundaryPaths.map(path => ({
                ...path,
                points: path.points.map(([x, y]) => [y, x]),
            })),
        });
        const verticalBefore = rotate(section('south', -50, 0, 2, 'vertical'));
        const verticalAfter = rotate(section('north', 0, 50, 2, 'vertical'));
        const results = build([
            horizontalBefore,
            horizontalAfter,
            verticalBefore,
            verticalAfter,
        ]);

        expect(results[0].paths.map(path => path.points.at(-1)))
            .toEqual(results[1].paths.map(path => path.points[0]));
        expect(results[2].paths.map(path => path.points.at(-1)))
            .toEqual(results[3].paths.map(path => path.points[0]));
    });

    it('keeps one dash phase across topology stations', () => {
        const segments = splitDashedPolyline(
            [[0, 0], [5, 0], [10, 0]],
            { on: 1.5, off: 2.5 },
        );

        expect(segments).toEqual([
            [[0, 0], [1.5, 0]],
            [[4, 0], [5, 0]],
            [[5, 0], [5.5, 0]],
            [[8, 0], [9.5, 0]],
        ]);
    });
});

describe('corridor profile integration', () => {
    it('feeds per-segment profiles through the shared topology builder', () => {
        global.wgs84ToHTRS96 = (lat, lng) => [lng, lat];
        global.htrs96ToWGS84 = (x, y) => [y, x];
        try {
            const profile = laneCount => ({
                strips: Array.from({ length: laneCount }, () => ({
                    type: 'driving',
                    width: 3,
                    direction: 'forward',
                })),
            });
            const markings = buildCorridorLaneMarkingsForEntries([
                {
                    corridorId: 'road',
                    points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 40 }],
                    profile: profile(2),
                },
                {
                    corridorId: 'road',
                    points: [{ lat: 0, lng: 40 }, { lat: 0, lng: 100 }],
                    profile: profile(4),
                },
            ]);
            const widerStarts = markings[1]
                .flatMap(marking => marking.lines)
                .map(line => line[0].lat)
                .sort((a, b) => a - b);

            expect(widerStarts).toEqual([-3, 0, 3]);
        } finally {
            delete global.wgs84ToHTRS96;
            delete global.htrs96ToWGS84;
        }
    });
});
