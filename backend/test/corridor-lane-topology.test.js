// Verifies lane-divider lineage across width changes and crossroads without a browser or renderer.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    build,
    mapOffsetAcross,
    splitDashedPolyline,
} = require('../../frontend/js/corridor-lane-topology.js');
const {
    buildCorridorLaneMarkingsForEntries,
    corridorMarkingLinksForTopologyEntries,
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

// A solved lane topology already states which lane continues into which. These lock the path that
// consumes that answer instead of re-deriving it from endpoint distance and heading.
describe('mapOffsetAcross', () => {
    const pairs = [{ from: -3, to: -1.5 }, { from: 3, to: 4.5 }];

    it('interpolates between the lanes that are known to continue', () => {
        expect(mapOffsetAcross(0, pairs)).toBeCloseTo(1.5, 9);
        expect(mapOffsetAcross(-3, pairs)).toBeCloseTo(-1.5, 9);
        expect(mapOffsetAcross(3, pairs)).toBeCloseTo(4.5, 9);
    });

    it('keeps a curb its measured distance outside the matched lanes rather than scaling it', () => {
        expect(mapOffsetAcross(-6, pairs)).toBeCloseTo(-4.5, 9);
        expect(mapOffsetAcross(6, pairs)).toBeCloseTo(7.5, 9);
    });

    it('shifts rigidly when only one lane is known to continue', () => {
        expect(mapOffsetAcross(2, [{ from: 0, to: 5 }])).toBeCloseTo(7, 9);
    });

    // Two sections digitized head to head have mirrored cross-section frames. Uncommon — one joint
    // in 37 over a Vukovarska viewport — but real, and silently wrong until the data was checked.
    describe('across a mirrored joint', () => {
        const mirrored = [{ from: -1.5, to: 1.5 }, { from: 1.5, to: -1.5 }];

        it('interpolates straight through the mirror', () => {
            expect(mapOffsetAcross(0, mirrored)).toBeCloseTo(0, 9);
        });

        it('sends a curb outward in the mirrored sense, not back across the road', () => {
            expect(mapOffsetAcross(-3, mirrored)).toBeCloseTo(3, 9);
            expect(mapOffsetAcross(3, mirrored)).toBeCloseTo(-3, 9);
        });

        it('takes the caller\'s orientation only when one pair leaves the data mute', () => {
            expect(mapOffsetAcross(2, [{ from: 0, to: 5 }], -1)).toBeCloseTo(3, 9);
            expect(mapOffsetAcross(2, [{ from: 0, to: 5 }], 1)).toBeCloseTo(7, 9);
        });

        it('believes the data over the caller when the pairs disagree with it', () => {
            expect(mapOffsetAcross(-3, mirrored, 1)).toBeCloseTo(3, 9);
        });
    });

    it('does not depend on the order the pairs arrive in', () => {
        expect(mapOffsetAcross(0, [...pairs].reverse())).toBeCloseTo(1.5, 9);
    });

    it('has no answer without pairs, or for an offset that is not a number', () => {
        expect(mapOffsetAcross(0, [])).toBeNull();
        expect(mapOffsetAcross(0, null)).toBeNull();
        expect(mapOffsetAcross(null, pairs)).toBeNull();
        expect(mapOffsetAcross(undefined, pairs)).toBeNull();
    });
});

describe('build with explicit topology links', () => {
    // Deliberately NOT touching: geometric pairing needs endpoints within a centimetre, so a gap
    // here means any warping observed can only have come from the supplied link.
    function detachedSection(id, from, to, offsets, corridorId = 'road') {
        return {
            id,
            corridorId,
            centerline: [[from, 0], [to, 0]],
            paths: offsets.map(offset => ({
                offset,
                kind: 'lane',
                points: [[from, offset], [to, offset]],
            })),
            boundaryPaths: [],
        };
    }

    it('lands each divider where the solved cross-section says, across a gap the guess cannot bridge', () => {
        const entries = [
            detachedSection('before', 0, 40, [-1.5, 1.5]),
            detachedSection('after', 60, 100, [1.5, 4.5]),
        ];

        expect(endpointOffsets(build(entries)[0], 'end')).toEqual([-1.5, 1.5]);

        const results = build(entries, {
            links: [{
                source: { entryIndex: 0, side: 'end' },
                targets: [{ entryIndex: 1, side: 'start' }],
                offsetPairs: [{ from: -1.5, to: 1.5 }, { from: 1.5, to: 4.5 }],
            }],
        });

        expect(endpointOffsets(results[0], 'end')).toEqual([1.5, 4.5]);
        // Only the linked end moves; the far end of the same section stays where it was drawn.
        expect(endpointOffsets(results[0], 'start')).toEqual([-1.5, 1.5]);
        expect(endpointOffsets(results[1], 'start')).toEqual([1.5, 4.5]);
    });

    it('tapers a dropped divider into its cross-section neighbour instead of leaving it hanging', () => {
        const results = build(
            [
                detachedSection('before', 0, 40, [-3, 0, 3]),
                detachedSection('after', 60, 100, [0, 3]),
            ],
            {
                links: [{
                    source: { entryIndex: 0, side: 'end' },
                    targets: [{ entryIndex: 1, side: 'start' }],
                    offsetPairs: [{ from: 0, to: 0 }, { from: 3, to: 3 }],
                }],
            },
        );

        const ends = results[0].paths.map(path => path.points[path.points.length - 1][1]);
        // -3 has nowhere to go, so it merges into the nearest divider that does: the one at 0.
        expect(ends[0]).toBeCloseTo(0, 6);
        expect(ends[1]).toBeCloseTo(0, 6);
        expect(ends[2]).toBeCloseTo(3, 6);
    });

    it('leaves a divider alone when the solved cross-section puts nothing near it', () => {
        const results = build(
            [
                detachedSection('before', 0, 40, [-1.5, 1.5]),
                detachedSection('after', 60, 100, [20, 23]),
            ],
            {
                links: [{
                    source: { entryIndex: 0, side: 'end' },
                    targets: [{ entryIndex: 1, side: 'start' }],
                    offsetPairs: [{ from: -1.5, to: 40 }, { from: 1.5, to: 43 }],
                }],
            },
        );

        expect(endpointOffsets(results[0], 'end')).toEqual([-1.5, 1.5]);
    });

    it('stops guessing once links are supplied — an unlinked pair is left as drawn', () => {
        const results = build(
            [
                section('narrow', 0, 40, 2),
                section('wide', 40, 100, 4),
                detachedSection('linked-a', 200, 240, [0]),
                detachedSection('linked-b', 260, 300, [6]),
            ],
            {
                links: [{
                    source: { entryIndex: 2, side: 'end' },
                    targets: [{ entryIndex: 3, side: 'start' }],
                    offsetPairs: [{ from: 0, to: 6 }],
                }],
            },
        );

        // Without links the geometric pass drags the wide section's dividers onto the narrow one.
        expect(endpointOffsets(results[1], 'start')).toEqual([-3, 0, 3]);
        expect(endpointOffsets(results[2], 'end')).toEqual([6]);
    });

    it('ignores a link that names an entry or a side that does not exist', () => {
        const entries = [
            detachedSection('before', 0, 40, [-1.5, 1.5]),
            detachedSection('after', 60, 100, [1.5, 4.5]),
        ];
        const results = build(entries, {
            links: [
                { source: { entryIndex: 9, side: 'end' }, targets: [{ entryIndex: 1, side: 'start' }], offsetPairs: [] },
                { source: { entryIndex: 0, side: 'middle' }, targets: [{ entryIndex: 1, side: 'start' }], offsetPairs: [] },
                { source: { entryIndex: 0, side: 'end' }, targets: [{ entryIndex: 9, side: 'start' }], offsetPairs: [] },
                null,
            ],
        });

        expect(endpointOffsets(results[0], 'end')).toEqual([-1.5, 1.5]);
    });
});

describe('corridorMarkingLinksForTopologyEntries', () => {
    function entry(sectionId, pathCount) {
        return { sectionId, paths: Array.from({ length: pathCount }, (_, index) => ({ offset: index })) };
    }

    const link = {
        a: { sectionId: 's:a', side: 'end' },
        b: { sectionId: 's:b', side: 'start' },
        matches: [{ aOffset: -1.5, bOffset: 1.5 }, { aOffset: 1.5, bOffset: 4.5 }],
    };

    it('warps the busier cross-section into the simpler one, offsets read in that direction', () => {
        const resolved = corridorMarkingLinksForTopologyEntries(
            [link],
            [entry('s:a', 3), entry('s:b', 2)],
        );

        expect(resolved).toEqual([{
            source: { entryIndex: 0, side: 'end' },
            targets: [{ entryIndex: 1, side: 'start' }],
            offsetPairs: [{ from: -1.5, to: 1.5 }, { from: 1.5, to: 4.5 }],
            offsetDirection: 1,
        }]);
    });

    it('marks a head-to-head joint as mirrored, and an end-to-start one as aligned', () => {
        const headToHead = {
            a: { sectionId: 's:a', side: 'end' },
            b: { sectionId: 's:b', side: 'end' },
            matches: [{ aOffset: -1.5, bOffset: 1.5 }],
        };
        const entries = [entry('s:a', 3), entry('s:b', 2)];

        expect(corridorMarkingLinksForTopologyEntries([headToHead], entries)[0].offsetDirection).toBe(-1);
        expect(corridorMarkingLinksForTopologyEntries([link], entries)[0].offsetDirection).toBe(1);
    });

    it('flips source and offset direction when the other side is the busier one', () => {
        const resolved = corridorMarkingLinksForTopologyEntries(
            [link],
            [entry('s:a', 2), entry('s:b', 3)],
        );

        expect(resolved[0].source).toEqual({ entryIndex: 1, side: 'start' });
        expect(resolved[0].targets).toEqual([{ entryIndex: 0, side: 'end' }]);
        expect(resolved[0].offsetPairs).toEqual([{ from: 1.5, to: -1.5 }, { from: 4.5, to: 1.5 }]);
    });

    it('breaks a tie by section id, so input order cannot change the result', () => {
        const entries = [entry('s:a', 2), entry('s:b', 2)];
        const resolved = corridorMarkingLinksForTopologyEntries([link], entries);
        const reordered = corridorMarkingLinksForTopologyEntries([link], [...entries].reverse());

        expect(resolved[0].source.side).toBe('start');
        expect(reordered[0].source.side).toBe('start');
    });

    it('offers every run of a section, so a divider finds the run that occupies its band', () => {
        const resolved = corridorMarkingLinksForTopologyEntries(
            [link],
            [entry('s:a', 2), entry('s:a', 2), entry('s:b', 1)],
        );

        expect(resolved).toHaveLength(2);
        expect(resolved.map(entryLink => entryLink.source.entryIndex)).toEqual([0, 1]);
        resolved.forEach(entryLink => {
            expect(entryLink.targets).toEqual([{ entryIndex: 2, side: 'start' }]);
        });
    });

    it('drops a link whose section was never painted, and one with nothing to match', () => {
        expect(corridorMarkingLinksForTopologyEntries([link], [entry('s:a', 2)])).toEqual([]);
        expect(corridorMarkingLinksForTopologyEntries(
            [{ ...link, matches: [] }],
            [entry('s:a', 2), entry('s:b', 2)],
        )).toEqual([]);
        expect(corridorMarkingLinksForTopologyEntries(null, [entry('s:a', 2)])).toEqual([]);
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
