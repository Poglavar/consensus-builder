// Panning across Šibenik logged several clipper failures per second:
//
//   "Unable to complete output ring starting at [15.8737012344…]"
//   "Unable to find segment #2311428 [15.8719317, 43.753128113] -> … in SweepLine tree"
//   "Maximum call stack size exceeded"
//
// All three are `polygon-clipping`'s sweep line failing to order two vertices that are the same
// corner to any surveyor but differ in their last bit. The giveaway is in the coordinates the
// errors print: source parcels arrive from the cadastre at ~9 decimal places, while derived pieces
// carry the full 15-dp output of the previous clip. Feed those back in against each other and a
// shared boundary is described twice, differently, below the precision anyone measured.
//
// The fix is one grid for everything, applied BEFORE the first attempt rather than after a throw.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../frontend/js/proposals/parcel-arrangement.js');
const turf = require('@turf/turf');

/** Records what turf was actually handed, so "it snaps" is observed rather than assumed. */
function spyTurf(behaviour) {
    const calls = [];
    globalThis.turf = new Proxy({}, {
        get(_target, name) {
            if (name === 'intersect' || name === 'difference') {
                return (a, b) => {
                    calls.push({ operation: name, a, b });
                    return behaviour(calls.length, a, b);
                };
            }
            return turf[name];
        }
    });
    return calls;
}

afterEach(() => { delete globalThis.turf; });

const ring = () => [[15.873701234414993, 43.75495522108252], [15.873739948, 43.754963653],
    [15.873800000000001, 43.755000000000003], [15.873701234414993, 43.75495522108252]];
const poly = () => turf.polygon([ring()]);

describe('every clip runs on one grid', () => {
    it('snaps the FIRST attempt, not only the retry', () => {
        const calls = spyTurf(() => poly());
        A.clip('intersect', poly(), poly());

        expect(calls).toHaveLength(1);
        const first = calls[0].a.geometry.coordinates[0];
        // 15 decimal places went in; 9 came out. Unsnapped, this vertex is 15.873701234414993.
        expect(first[0][0]).toBe(15.873701234);
        expect(first[0][1]).toBe(43.754955221);
    });

    it('snaps BOTH operands — one snapped edge against one raw edge is the bug itself', () => {
        const calls = spyTurf(() => poly());
        A.clip('difference', poly(), poly());
        expect(calls[0].b.geometry.coordinates[0][0][0]).toBe(15.873701234);
    });

    it('leaves a coordinate already on the grid exactly alone', () => {
        const calls = spyTurf(() => poly());
        const flat = turf.polygon([[[15.87, 43.75], [15.88, 43.75], [15.88, 43.76], [15.87, 43.75]]]);
        A.clip('intersect', flat, flat);
        expect(calls[0].a.geometry.coordinates[0]).toEqual(flat.geometry.coordinates[0]);
    });
});

describe('what a surveyor would notice', () => {
    it('moves nothing anyone measured: under a tenth of a millimetre', () => {
        const calls = spyTurf(() => poly());
        A.clip('intersect', poly(), poly());
        const before = ring()[0];
        const after = calls[0].a.geometry.coordinates[0][0];
        // 1e-9 degrees of latitude is ~0.11 mm; the shift is at most half a grid step.
        const metres = Math.hypot((after[0] - before[0]) * 80500, (after[1] - before[1]) * 111320);
        expect(metres).toBeLessThan(0.0001);
    });

    it('still cuts real ground into real pieces', () => {
        // The real clipper, on a parcel a road crosses. (Set rather than deleted: the module's
        // require fallback resolves from frontend/, where @turf/turf is not installed.)
        globalThis.turf = turf;
        const parcel = turf.polygon([[[15.87, 43.75], [15.88, 43.75], [15.88, 43.76], [15.87, 43.76], [15.87, 43.75]]]);
        const road = turf.polygon([[[15.874, 43.749], [15.876, 43.749], [15.876, 43.761], [15.874, 43.761], [15.874, 43.749]]]);
        // A take is {id, geometry} — the corridor's footprint, not a wrapped feature.
        const { pieces, takersUsed } = A.arrangementOf(parcel, 'HR-330264-1', [{ id: 'r1', geometry: road.geometry }]);
        expect(takersUsed).toEqual(['r1']);
        // Two flanks plus the strip under the road, every one of them real ground.
        expect(pieces.length).toBe(3);
        pieces.forEach(piece => expect(piece.areaM2).toBeGreaterThan(1));
        // And they still add up to the parcel: a snap must not lose or invent land.
        const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
        expect(total).toBeCloseTo(turf.area(parcel), 0);
    });
});

describe('when the grid is not enough', () => {
    beforeEach(() => { A.clipHealth().rescued; });

    it('coarsens, and counts the rescue instead of only printing it', () => {
        // Fails at 9 dp, succeeds at 8 — the shape of a real sweep-line failure.
        const before = A.clipHealth();
        spyTurf(attempt => {
            if (attempt === 1) throw new Error('Unable to find segment #2311428 in SweepLine tree');
            return poly();
        });
        expect(A.clip('intersect', poly(), poly())).toBeTruthy();

        const after = A.clipHealth();
        expect(after.rescued).toBe(before.rescued + 1);
        expect(after.failed).toBe(before.failed);
        expect(after.lastMessage).toContain('8dp');
    });

    it('a clip that cannot be done stays LOUD rather than silently dropping a parcel', () => {
        // Swallowing this is how HR-330264-519 sat whole under two roads that crossed it.
        const before = A.clipHealth();
        spyTurf(() => { throw new Error('Maximum call stack size exceeded'); });
        expect(() => A.clip('intersect', poly(), poly())).toThrow('Maximum call stack size exceeded');
        expect(A.clipHealth().failed).toBe(before.failed + 1);
    });

    it('counts every clip, so "no failures" can be told from "no clips"', () => {
        const before = A.clipHealth();
        spyTurf(() => poly());
        A.clip('intersect', poly(), poly());
        A.clip('difference', poly(), poly());
        expect(A.clipHealth().clips).toBe(before.clips + 2);
    });
});
