// Tests for splitting a road network into the pieces a person would call "one segment".
// The shapes below are the ones the rule has to get right: a T yields three segments (not a
// through-street plus a stub), an L yields two even as a single way, and a sweeping curve — which
// turns just as far as the L — must stay one.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RS = require('../../frontend/js/road-segmentation.js');

const straightStreet = [[0, 0], [50, 0], [100, 0]];

describe('segment breaking points', () => {
    it('leaves an unbroken street as one segment', () => {
        expect(RS.segmentRoadNetwork([straightStreet])).toHaveLength(1);
    });

    it('breaks a T into three segments, cutting the through street at the stem', () => {
        const segments = RS.segmentRoadNetwork([straightStreet, [[50, 0], [50, 60]]]);
        expect(segments).toHaveLength(3);
        // The through street really is cut in two: no surviving segment spans the whole 100 m.
        expect(Math.max(...segments.map(RS.polylineLength))).toBeLessThan(90);
    });

    it('breaks a crossroads into four segments', () => {
        expect(RS.segmentRoadNetwork([
            [[-100, 0], [0, 0], [100, 0]],
            [[0, -100], [0, 0], [0, 100]]
        ])).toHaveLength(4);
    });

    it('breaks where a cul-de-sac joins, even though it is a dead end', () => {
        expect(RS.segmentRoadNetwork([
            [[0, 0], [40, 0], [80, 0]],
            [[40, 0], [40, 25]]
        ])).toHaveLength(3);
    });

    it('does not break where two roads cross without sharing a node', () => {
        // A bridge over a road: the ways cross geometrically but never meet.
        expect(RS.segmentRoadNetwork([
            [[-50, 0], [50, 0]],
            [[0, -50], [0, 50]]
        ])).toHaveLength(2);
    });

    it('treats ways that share a stretch as one edge rather than a junction', () => {
        // The same centreline delivered twice must not read as a node of degree 4.
        expect(RS.segmentRoadNetwork([straightStreet, straightStreet])).toHaveLength(1);
    });
});

describe('corners inside a single way', () => {
    it('breaks an L into two segments', () => {
        expect(RS.segmentRoadNetwork([[[0, 0], [0, 60], [60, 60]]])).toHaveLength(2);
    });

    it('breaks a corner that was drawn with a chamfer', () => {
        expect(RS.segmentRoadNetwork([[[0, 0], [0, 50], [4, 56], [10, 60], [60, 60]]])).toHaveLength(2);
    });

    it('does not break a sweeping curve that turns the same 90 degrees', () => {
        const curve = [];
        for (let i = 0; i <= 20; i += 1) {
            const angle = (Math.PI / 2) * (i / 20);
            curve.push([100 * Math.sin(angle), 100 - 100 * Math.cos(angle)]);
        }
        expect(RS.segmentRoadNetwork([curve])).toHaveLength(1);
    });

    it('does not break an S-bend, whose two opposite kinks are not a corner', () => {
        expect(RS.segmentRoadNetwork([[[0, 0], [30, 0], [40, 12], [70, 12], [100, 12]]])).toHaveLength(1);
    });

    it('never cuts a stub shorter than the minimum off an end', () => {
        // A kink two metres from the end is a corner by angle, but a 2 m segment is not a segment.
        const segments = RS.segmentRoadNetwork([[[0, 0], [98, 0], [100, 2], [100, 4]]]);
        segments.forEach(segment => expect(RS.polylineLength(segment)).toBeGreaterThan(4));
    });
});

describe('choosing and bounding the clicked segment', () => {
    const cross = [
        [[-100, 0], [0, 0], [100, 0]],
        [[0, -100], [0, 0], [0, 100]]
    ];

    it('picks the arm the click landed on', () => {
        const picked = RS.nearestSegment(RS.segmentRoadNetwork(cross), [60, 2]);
        expect(picked).toBeTruthy();
        expect(picked.points.every(([x, y]) => x >= -0.001 && Math.abs(y) < 0.001)).toBe(true);
    });

    it('prefers a real segment over a stub when the click is near both', () => {
        const segments = [
            [[0, 0], [3, 0]],          // stub
            [[0, 1], [80, 1]]          // street
        ];
        const picked = RS.nearestSegment(segments, [1, 0.4], { minPieceLength: 8 });
        expect(RS.polylineLength(picked.points)).toBeGreaterThan(50);
    });

    it('clips a segment to the clicked parcel', () => {
        const parcel = [[[0, -10], [0, 10], [40, 10], [40, -10], [0, -10]]];
        const pieces = RS.clipPolylineToRings([[-50, 0], [100, 0]], parcel);
        expect(pieces).toHaveLength(1);
        expect(RS.polylineLength(pieces[0])).toBeCloseTo(40, 6);
    });

    it('keeps both runs when a segment leaves and re-enters the parcel', () => {
        const parcels = [
            [[0, -5], [0, 5], [20, 5], [20, -5], [0, -5]],
            [[40, -5], [40, 5], [60, 5], [60, -5], [40, -5]]
        ];
        expect(RS.clipPolylineToRings([[-10, 0], [70, 0]], parcels)).toHaveLength(2);
    });
});

describe('picking the run a click meant', () => {
    // A road parcel 24 m wide running east, with a side street crossing it at x=60. The side street
    // is long, so picking by full length and clipping afterwards hands back its 24 m crossing — the
    // "small selection square in the middle of a segment".
    const parcel = [[[0, -12], [0, 12], [200, 12], [200, -12], [0, -12]]];
    const network = [
        [[-50, 0], [60, 0], [250, 0]],   // the street the parcel is
        [[60, -150], [60, 0], [60, 150]] // the crossing street
    ];

    it('keeps only the parts of each segment that lie inside the parcel', () => {
        const runs = RS.runsInsideRings(RS.segmentRoadNetwork(network), parcel);
        expect(runs.length).toBeGreaterThan(0);
        runs.forEach(run => run.forEach(([x, y]) => {
            expect(x).toBeGreaterThanOrEqual(-0.001);
            expect(x).toBeLessThanOrEqual(200.001);
            expect(Math.abs(y)).toBeLessThanOrEqual(12.001);
        }));
    });

    it('picks the street, not the crossing stub, for a click near the junction', () => {
        const runs = RS.runsInsideRings(RS.segmentRoadNetwork(network), parcel);
        const picked = RS.pickRunForClick(runs, [58, 1]);
        // The crossing contributes a 24 m run; the street runs the length of the parcel.
        expect(RS.polylineLength(picked.points)).toBeGreaterThan(50);
    });

    it('picks the run the pointer is actually on, not a longer one nearby', () => {
        // Two parallel streets 12 m apart, the far one much longer. Pointing at the short one must
        // highlight the short one — a generous tie window highlighted the neighbour instead, which
        // over one real parcel put the outline on the wrong street for 16% of pointer positions.
        const parallel = [
            [[0, 0], [60, 0]],
            [[-200, 12], [200, 12]]
        ];
        const wide = [[[-200, -10], [-200, 25], [200, 25], [200, -10], [-200, -10]]];
        const runs = RS.runsInsideRings(RS.segmentRoadNetwork(parallel), wide);
        const picked = RS.pickRunForClick(runs, [30, 1]);
        expect(RS.polylineLength(picked.points)).toBeLessThan(100);
    });

    it('still picks the nearest street when two run far apart', () => {
        const twoStreets = [
            [[0, 0], [200, 0]],
            [[0, 300], [200, 300]]
        ];
        const wideParcel = [[[0, -20], [0, 320], [200, 320], [200, -20], [0, -20]]];
        const runs = RS.runsInsideRings(RS.segmentRoadNetwork(twoStreets), wideParcel);
        const picked = RS.pickRunForClick(runs, [100, 295]);
        expect(picked.points[0][1]).toBeCloseTo(300, 6);
    });

    it('returns null for an empty network rather than throwing', () => {
        expect(RS.pickRunForClick([], [0, 0])).toBeNull();
        expect(RS.pickRunForClick(null, [0, 0])).toBeNull();
    });
});

describe('available width', () => {
    it('measures the gap between the two sides of the road parcel', () => {
        const twelveMetreParcel = [[[0, -6], [0, 6], [100, 6], [100, -6], [0, -6]]];
        const measured = RS.measureAvailableWidth([[5, 0], [95, 0]], twelveMetreParcel);
        expect(measured.width).toBeCloseTo(12, 1);
    });

    it('reports the narrow end rather than the average when the parcel pinches', () => {
        // 16 m wide at one end, 6 m at the other: the quantile has to sit below the mean, or an
        // adopted road would be built wider than the narrow half of its own parcel.
        const taper = [[[0, -8], [0, 8], [100, 3], [100, -3], [0, -8]]];
        const measured = RS.measureAvailableWidth([[2, 0], [98, 0]], taper);
        expect(measured.width).toBeLessThan((16 + 6) / 2);
        expect(measured.width).toBeGreaterThan(6);
    });

    it('returns null when there is no parcel to measure against', () => {
        expect(RS.measureAvailableWidth([[0, 0], [10, 0]], [])).toBeNull();
    });
});

describe('picking by the strip the pointer is in', () => {
    it('picks the road the pointer is inside, even when its centreline is further away', () => {
        // Two roads. The pointer is plainly inside the wide one, but sits nearer the NARROW road's
        // centreline — which is what an OSM centreline offset from the cadastral parcel produces,
        // and what made the highlight jump to the street next door.
        const parcel = [[[0, -30], [0, 30], [200, 30], [200, -30], [0, -30]]];
        const wideRoad = [[0, 20], [200, 20]];     // centreline at y=20, strip roughly y=0..30
        const narrowRoad = [[0, -20], [200, -20]]; // centreline at y=-20
        const runs = [wideRoad, narrowRoad];
        const bands = [
            [[0, 2], [200, 2], [200, 30], [0, 30]],     // the wide road's strip: y 2..30
            [[0, -30], [200, -30], [200, -14], [0, -14]]
        ];
        // y=4 is inside the wide road's strip but 16 m from its centreline and 24 m from the other.
        const picked = RS.pickRunAtPoint(runs, bands, [100, 4]);
        expect(picked.points).toBe(wideRoad);
    });

    it('falls back to the nearest run where the pointer is just outside a strip', () => {
        const runs = [[[0, 0], [100, 0]]];
        const picked = RS.pickRunAtPoint(runs, [null], [50, 8]);
        expect(picked.points).toBe(runs[0]);
    });

    it('gives up rather than reaching for a distant street across open ground', () => {
        // A road parcel holds ground that belongs to no street — junction plazas, verges. Reaching
        // for the nearest centreline there highlighted a street 116 m from the pointer.
        const runs = [[[0, 0], [100, 0]]];
        expect(RS.pickRunAtPoint(runs, [null], [50, 60])).toBeNull();
        expect(RS.pickRunAtPoint(runs, [null], [50, 14])).not.toBeNull();
    });

    it('resolves overlapping strips at a junction by the nearer centreline', () => {
        const a = [[0, 0], [100, 0]];
        const b = [[50, -50], [50, 50]];
        const wide = [[[-10, -60], [110, -60], [110, 60], [-10, 60]]];
        const picked = RS.pickRunAtPoint([a, b], [wide, wide], [20, 2]);
        expect(picked.points).toBe(a);
    });
});

describe('the segment band', () => {
    const ringArea = ring => {
        let sum = 0;
        for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        return Math.abs(sum / 2);
    };
    const closed = ring => (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
        ? ring : [...ring, ring[0]];

    it('covers the parcel edge to edge, not a narrower strip about the centreline', () => {
        const parcel = [[[0, -10], [0, 10], [100, 10], [100, -10], [0, -10]]];  // 20 m wide
        const band = RS.segmentBandRing([[5, 0], [95, 0]], parcel);
        expect(band).toBeTruthy();
        // 90 m of run at ~20 m wide; the band must be about the parcel's full width.
        expect(ringArea(closed(band)) / 90).toBeGreaterThan(18);
    });

    it('follows an off-centre parcel rather than assuming the run is in the middle', () => {
        // The parcel reaches 16 m north of the centreline but only 4 m south, as one carrying a
        // pavement on a single side does. A band centred on the run would leave the north showing.
        const lopsided = [[[0, -4], [0, 16], [100, 16], [100, -4], [0, -4]]];
        const band = RS.segmentBandRing([[5, 0], [95, 0]], lopsided);
        const northReach = Math.max(...band.map(([, y]) => y));
        const southReach = Math.min(...band.map(([, y]) => y));
        expect(northReach).toBeGreaterThan(15);
        expect(southReach).toBeLessThan(-3);
    });

    it('does not balloon where the parcel opens into a junction', () => {
        // A 12 m street opening into a 60 m plaza halfway along: the band must not lurch out to the
        // plaza edge and fold over itself, which clipped the whole highlight away.
        const withPlaza = [[[0, -6], [0, 6], [40, 6], [40, 60], [60, 60], [60, 6], [100, 6], [100, -6], [0, -6]]];
        const band = RS.segmentBandRing([[5, 0], [95, 0]], withPlaza);
        expect(band).toBeTruthy();
        expect(Math.max(...band.map(([, y]) => y))).toBeLessThan(25);
    });

    it('returns null rather than throwing when there is no parcel', () => {
        expect(RS.segmentBandRing([[0, 0], [10, 0]], [])).toBeNull();
        expect(RS.segmentBandRing([[0, 0]], [[[0, 0], [1, 0], [1, 1], [0, 0]]])).toBeNull();
    });
});

describe('malformed input', () => {
    it('yields no segments rather than throwing', () => {
        expect(RS.segmentRoadNetwork(null)).toEqual([]);
        expect(RS.segmentRoadNetwork([null, [], [[0, 0]]])).toEqual([]);
        expect(RS.segmentRoadNetwork([[['a', 'b'], [1, 2]]])).toEqual([]);
    });
});
