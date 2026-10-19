// Which stretches of a corridor take the cadastral surface, and — just as important — which
// corridors this rule must not touch at all.
//
// Two properties are pinned. First, NO-OP FOR EXISTING CORRIDORS: every corridor drawn by hand has
// no levels, and for those acquiringSpans must return the whole centreline as one span, because
// that single list is exactly what the footprint builder received before levels existed. If this
// ever returns something else, every road already on the map silently changes what it acquires.
// Second, the GAP IS IN THE FOOTPRINT, NOT THE CENTRELINE: a tunnel splits the acquiring spans
// while the centreline stays one connected run, which is what lets a part-tunnelled line remain one
// proposal under the one-contiguous-stretch ruling instead of being split at every portal.

import { describe, it, expect } from 'vitest';
import levels from '../../frontend/js/proposals/corridor-levels.js';

const at = (lat, lng, level) => (level === undefined ? { lat, lng } : { lat, lng, level });
const line = (...points) => points;

describe('acquiringSpans — corridors without levels', () => {
    it('returns the whole centreline as one span when no point carries a level', () => {
        const points = line(at(45, 15), at(45.1, 15.1), at(45.2, 15.2));
        expect(levels.acquiringSpans(points)).toEqual([points]);
    });

    it('treats an explicit level 0 exactly like no level at all', () => {
        const points = line(at(45, 15, 0), at(45.1, 15.1, 0), at(45.2, 15.2, 0));
        expect(levels.acquiringSpans(points)).toEqual([points]);
    });

    it('does not exempt an elevated corridor — +1 acquires like level 0', () => {
        const points = line(at(45, 15, 1), at(45.1, 15.1, 1), at(45.2, 15.2, 1));
        expect(levels.acquiringSpans(points)).toEqual([points]);
    });
});

describe('acquiringSpans — underground stretches', () => {
    it('drops an edge only when both of its ends are underground', () => {
        expect(levels.edgeAcquires(at(45, 15, -1), at(45, 15, -1))).toBe(false);
        expect(levels.edgeAcquires(at(45, 15, -1), at(45, 15, 0))).toBe(true);
        expect(levels.edgeAcquires(at(45, 15, -1), at(45, 15, -0.5))).toBe(true);
    });

    it('splits the footprint at a tunnel while every vertex stays on the centreline', () => {
        const points = line(
            at(45.0, 15.0, 0), at(45.1, 15.0, 0),
            at(45.2, 15.0, -1), at(45.3, 15.0, -1), at(45.4, 15.0, -1),
            at(45.5, 15.0, 0), at(45.6, 15.0, 0)
        );
        const spans = levels.acquiringSpans(points);
        expect(spans).toHaveLength(2);
        // The portal edges (0 -> -1 and -1 -> 0) acquire, so each span reaches into the tunnel mouth.
        expect(spans[0]).toEqual(points.slice(0, 3));
        expect(spans[1]).toEqual(points.slice(4));
        // Nothing was removed from the centreline itself — that stays the caller's array.
        expect(points).toHaveLength(7);
    });

    it('yields no span at all for a corridor that is underground end to end', () => {
        expect(levels.acquiringSpans(line(at(45, 15, -1), at(45.1, 15, -1)))).toEqual([]);
    });

    it('treats a ramp as acquiring at every fractional level', () => {
        const points = line(at(45, 15, -1), at(45.1, 15, -0.6), at(45.2, 15, -0.2), at(45.3, 15, 0));
        expect(levels.acquiringSpans(points)).toEqual([points]);
    });
});

describe('verticesFromTrack', () => {
    it('pairs the planner parallel arrays into levelled vertices', () => {
        const track = { latlngs: [[45, 15], [45.1, 15.1]], levels: [0, -1] };
        expect(levels.verticesFromTrack(track)).toEqual([
            { lat: 45, lng: 15, level: 0 },
            { lat: 45.1, lng: 15.1, level: -1 }
        ]);
    });

    it('reads a missing or short levels array as level 0 rather than as absent geometry', () => {
        const track = { latlngs: [[45, 15], [45.1, 15.1], [45.2, 15.2]], levels: [-1] };
        const vertices = levels.verticesFromTrack(track);
        expect(vertices).toHaveLength(3);
        expect(vertices.map(vertex => vertex.level)).toEqual([-1, 0, 0]);
    });

    it('drops malformed coordinate pairs instead of emitting NaN vertices', () => {
        const track = { latlngs: [[45, 15], [null, 15], ['x', 'y'], [45.2, 15.2]], levels: [0, 0, 0, 0] };
        expect(levels.verticesFromTrack(track)).toHaveLength(2);
    });
});

describe('summarizeLevels', () => {
    it('classifies every edge so an import can state what it is about to take', () => {
        const points = line(
            at(45.0, 15, 0), at(45.1, 15, 0),
            at(45.2, 15, -1), at(45.3, 15, -1),
            at(45.4, 15, 1), at(45.5, 15, 1)
        );
        expect(levels.summarizeLevels(points)).toEqual({
            edges: 5, surface: 1, elevated: 1, underground: 1, ramp: 2
        });
    });
});
