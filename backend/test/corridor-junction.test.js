// The junction object (frontend/js/corridor-junction.js): kerb-return fillets between angular
// neighbours, the carriageway surface, footway corners, the land a corner needs, approach
// furniture and per-arm cuts — pure planar geometry, so it is tested in metres with no frame.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const J = require('../../frontend/js/corridor-junction.js');
const {
    buildCorridorJunctionTreatmentsForEntries,
    buildCorridorLaneMarkingsForEntries,
    buildCorridorParkingBays,
    buildCorridorJunctionSet,
    corridorProfileEdges,
    cutPolylineByStations,
    CORRIDOR_PROFILE_PRESETS
} = require('../../frontend/js/corridor-profile.js');

const IDENTITY_FRAME = { latLngToMetric: (lat, lng) => [lng, lat], metricToLatLng: (x, y) => [y, x] };

// 26 m main street: 3 + 1.5 of footway outside the kerb on each side, 17 m of carriageway.
const main = { total: 26, carriagewayLeft: 8.5, carriagewayRight: -8.5, outerLeft: 4.5, outerRight: 4.5 };
// 7.5 m alley: 1 m footways, 5.5 m carriageway.
const alley = { total: 7.5, carriagewayLeft: 2.75, carriagewayRight: -2.75, outerLeft: 1, outerRight: 1 };
const local = { total: 10, carriagewayLeft: 3.5, carriagewayRight: -3.5, outerLeft: 1.5, outerRight: 1.5 };

function tJunction() {
    return J.buildJunction([0, 0], [
        { dir: [1, 0], edges: main, hasSidewalk: true, inbound: [-8.5, -3.25], length: 100, label: 'east' },
        { dir: [-1, 0], edges: main, reversed: true, hasSidewalk: true, inbound: [3.25, 8.5], length: 100, label: 'west' },
        // The alley starts at the node and runs north: its inbound (backward) lane is on the left
        // of travel, lateral 0..2.75, which is world x −2.75..0.
        { dir: [0, 1], edges: alley, hasSidewalk: true, inbound: [0, 2.75], length: 60, label: 'north' }
    ]);
}

describe('corridor-junction', () => {
    // Point-in-ring (even-odd) over a planar ring, for "does the surface cover this spot".
    const ringContains = (ring, [x, y]) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
            const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    };

    it('covers the wedge a slightly bent continuation leaves between its two boxes at the node', () => {
        // East leaves 5° south of straight: the two through boxes' node-line ends diverge on the
        // north side, where no third arm lies, so only the continuation notch can cover it.
        const bend = -5 * Math.PI / 180;
        const j = J.buildJunction([0, 0], [
            { dir: [Math.cos(bend), Math.sin(bend)], edges: main, hasSidewalk: true, length: 100, label: 'east' },
            { dir: [-1, 0], edges: main, reversed: true, hasSidewalk: true, length: 100, label: 'west' },
            { dir: [0, -1], edges: alley, hasSidewalk: true, length: 60, label: 'south' }
        ]);
        // 5 m north of the node and 0.2 m east: outside the west box (x ≤ 0.05) and short of the
        // east box's tilted end (x ≥ 5·tan 5° ≈ 0.44).
        expect(j.surface.some(ring => ringContains(ring, [0.2, 5]))).toBe(true);
        // The boxes themselves start a hair behind the node, so neighbours overlap rather than touch.
        const westBox = j.surface.find(ring => ring.length === 4 && ring.every(([x]) => x <= 0.051) && ring.some(([x]) => x > 0));
        expect(westBox).toBeTruthy();
    });

    it('picks the kerb-return radius from the narrower arm: 6 / 9 / 12 m by class', () => {
        expect(J.kerbReturnRadius(7.5, 26)).toBe(6);
        expect(J.kerbReturnRadius(26, 18)).toBe(9);
        expect(J.kerbReturnRadius(40, 80)).toBe(12);
    });

    it('gives a T two fillets, each arm a cut that reaches the other road, and leaves the far side alone', () => {
        const j = tJunction();
        expect(j.degree).toBe(3);
        const byLabel = Object.fromEntries(j.arms.map(arm => [arm.source.label, arm]));
        // The through arms' cut is the alley's half carriageway (2.75) plus the 6 m fillet tangent.
        expect(byLabel.east.cut).toBeCloseTo(8.75, 2);
        expect(byLabel.west.cut).toBeCloseTo(8.75, 2);
        // The alley's cut is the main street's half carriageway (8.5) plus the tangent.
        expect(byLabel.north.cut).toBeCloseTo(14.5, 2);
        // Only the branch side gets corners: the far side of the through road is a straight 180°.
        expect(j.fillets).toHaveLength(2);
        expect(j.fillets.every(fillet => fillet.radius === 6)).toBe(true);
        expect(j.corners).toHaveLength(2);
        // Surface: three arm boxes plus the two corner pieces the fillets add to the carriageway.
        expect(j.surface).toHaveLength(5);
        // The corner piece between K and the arc has the area of a square corner minus a quarter disc.
        const pieces = j.surface.map(ring => Math.abs(J.ringArea(ring))).sort((a, b) => a - b);
        expect(pieces[0]).toBeCloseTo(36 * (1 - Math.PI / 4), 0);
    });

    it('takes land at a corner only where the footway is narrower than the kerb return', () => {
        // Four-way crossing of two 10 m locals (1.5 m footways, 6 m fillet): each corner needs
        // (6 − 1.5)² · (1 − π/4) ≈ 4.3 m² beyond the straight land edges.
        const x = J.buildJunction([0, 0], [
            { dir: [1, 0], edges: local, hasSidewalk: true, inbound: [-3.5, 0], length: 50 },
            { dir: [-1, 0], edges: local, reversed: true, hasSidewalk: true, inbound: [0, 3.5], length: 50 },
            { dir: [0, 1], edges: local, hasSidewalk: true, inbound: [-3.5, 0], length: 50 },
            { dir: [0, -1], edges: local, reversed: true, hasSidewalk: true, inbound: [0, 3.5], length: 50 }
        ]);
        expect(x.land).toHaveLength(4);
        x.land.forEach(ring => expect(Math.abs(J.ringArea(ring))).toBeCloseTo(4.5 * 4.5 * (1 - Math.PI / 4), 0));
        expect(x.arms.every(arm => Math.abs(arm.cut - 9.5) < 0.01)).toBe(true);
        // The main street's 4.5 m footway swallows most of a 6 m fillet: a sliver of land at the T.
        const t = tJunction();
        expect(t.land).toHaveLength(2);
        t.land.forEach(ring => {
            expect(Math.abs(J.ringArea(ring))).toBeGreaterThan(0.3);
            expect(Math.abs(J.ringArea(ring))).toBeLessThan(2);
            expect(J.ringSelfIntersects(ring)).toBe(false);
        });
    });

    it('puts the zebra beyond the cut and the stop line behind the zebra, across inbound lanes only', () => {
        const j = tJunction();
        const north = j.arms.find(arm => arm.source.label === 'north');
        expect(j.stopLines).toHaveLength(3);
        // The alley's stop line sits at cut + 0.5 (zebra setback) + 3 (zebra) + 0.5 → 18.5..18.85 m
        // from the node, and spans only its inbound lane (x from −2.75 to 0).
        const alleyStop = j.stopLines.find(ring => ring.every(point => point[1] > 15));
        expect(alleyStop).toBeTruthy();
        expect(Math.min(...alleyStop.map(p => p[1]))).toBeCloseTo(north.cut + J.CROSSING_SETBACK + J.CROSSING_DEPTH + J.STOP_LINE_GAP, 2);
        expect(Math.min(...alleyStop.map(p => p[0]))).toBeCloseTo(-2.75, 2);
        expect(Math.max(...alleyStop.map(p => p[0]))).toBeCloseTo(0, 2);
        // Zebra stripes on the alley lie between cut + 0.5 and cut + 3.5, never inside the box.
        const alleyStripes = j.crossings.filter(ring => ring.every(point => Math.abs(point[0]) < 3));
        expect(alleyStripes.length).toBeGreaterThan(0);
        alleyStripes.forEach(ring => expect(Math.min(...ring.map(p => p[1]))).toBeGreaterThanOrEqual(north.cut + J.CROSSING_SETBACK - 1e-9));
        // Lane lines stop just past the stop line.
        expect(north.markingTrim).toBeCloseTo(north.cut + 4 + 0.35 + 0.5, 2);
    });

    it('treats a two-arm node as a bend: a notch triangle, short boxes, no furniture', () => {
        const b = J.buildJunction([0, 0], [
            { dir: [1, 0], edges: local, reversed: true, hasSidewalk: true, length: 50 },
            { dir: [-Math.cos(20 * Math.PI / 180), Math.sin(20 * Math.PI / 180)], edges: local, hasSidewalk: true, length: 50 }
        ]);
        expect(b.degree).toBe(2);
        expect(b.surface).toHaveLength(3);
        expect(b.corners).toHaveLength(1);
        expect(b.stopLines).toEqual([]);
        expect(b.crossings).toEqual([]);
        expect(b.arms.every(arm => arm.cut < 2)).toBe(true);
    });

    it('shrinks a fillet to fit a stub and refuses a corner beyond the arm end', () => {
        const stub = J.buildJunction([0, 0], [
            { dir: [1, 0], edges: main, hasSidewalk: true, length: 100 },
            { dir: [-1, 0], edges: main, reversed: true, hasSidewalk: true, length: 100 },
            { dir: [0, 1], edges: alley, hasSidewalk: true, length: 12 } // ends 3.5 m past the main kerb
        ]);
        expect(stub.fillets.every(fillet => fillet.radius < 6 && fillet.radius >= 0.5)).toBe(true);
        const tooShort = J.buildJunction([0, 0], [
            { dir: [1, 0], edges: main, hasSidewalk: true, length: 100 },
            { dir: [-1, 0], edges: main, reversed: true, hasSidewalk: true, length: 100 },
            { dir: [0, 1], edges: alley, hasSidewalk: true, length: 5 } // ends inside the main carriageway
        ]);
        expect(tooShort.fillets).toEqual([]);
    });

    it('collects arms at every node, measuring each arm to the next junction or the polyline end', () => {
        const nodes = J.collectNodes([
            { points: [[-50, 0], [0, 0], [50, 0]], width: 26 },
            { points: [[0, 0], [0, 40], [0, 80]], width: 7.5 },
            { points: [[0, 40], [30, 40]], width: 7.5 }
        ], { minDegree: 3 });
        expect(nodes).toHaveLength(2);
        const origin = nodes.find(node => node.point[0] === 0 && node.point[1] === 0);
        const north = origin.arms.find(arm => arm.dir[1] > 0.5);
        expect(north.length).toBe(40); // stops at the next junction, not at the polyline end (80)
        expect(north.reversed).toBe(false);
        const west = origin.arms.find(arm => arm.dir[0] < -0.5);
        expect(west.reversed).toBe(true);
        expect(west.length).toBe(50);
    });
});

describe('junction treatments from cross-sections', () => {
    const mainProfile = { strips: CORRIDOR_PROFILE_PRESETS[26] };
    const alleyProfile = { strips: CORRIDOR_PROFILE_PRESETS[7.5] };

    it('derives kerbs, footways and inbound lanes from a profile', () => {
        const edges = corridorProfileEdges(mainProfile);
        expect(edges.total).toBeCloseTo(26, 6);
        expect(edges.carriagewayLeft).toBeCloseTo(8.5, 6);
        expect(edges.outerLeft).toBeCloseTo(4.5, 6);
        expect(edges.hasSidewalk).toBe(true);
        // Backward lanes flow towards the start: the first driving lane (left of the median),
        // 3.25 m wide between the parking lane (ends at 4.5) and the median (starts at 1.25).
        expect(edges.inbound.start).toEqual([1.25, 4.5]);
        expect(edges.inbound.end).toEqual([-4.5, -1.25]);
        expect(edges.outerStrips.left.type).toBe('sidewalk');
    });

    it('stops lane lines at the stop line and keeps parking bays out of the junction', () => {
        const entries = [
            { points: [{ lat: 0, lng: -80 }, { lat: 0, lng: 0 }, { lat: 0, lng: 80 }], profile: mainProfile, corridorId: 'm', segmentId: 's1' },
            { points: [{ lat: 0, lng: 0 }, { lat: 60, lng: 0 }], profile: alleyProfile, corridorId: 'm', segmentId: 's2' }
        ];
        const junctions = buildCorridorJunctionTreatmentsForEntries(entries, IDENTITY_FRAME);
        expect(junctions).toHaveLength(1);
        const branchArm = junctions[0].arms.find(arm => arm.segmentId === 's2');
        expect(branchArm.markingTrim).toBeGreaterThan(14.5);
        const markings = buildCorridorLaneMarkingsForEntries(entries, IDENTITY_FRAME);
        // The alley's centre line: one line, starting past the stop line instead of at the node.
        const alleyLines = markings[1].flatMap(marking => marking.lines);
        expect(alleyLines.length).toBeGreaterThan(0);
        alleyLines.forEach(line => line.forEach(point => expect(point.lat).toBeGreaterThanOrEqual(branchArm.markingTrim - 1e-6)));
        // The main street's lines are cut around the interior junction node (a gap, two pieces).
        const mainLines = markings[0].flatMap(marking => marking.lines);
        const throughArm = junctions[0].arms.find(arm => arm.segmentId === 's1');
        mainLines.forEach(line => line.forEach(point => expect(Math.abs(point.lng)).toBeGreaterThanOrEqual(throughArm.markingTrim - 1e-6)));
        // Parking bays stay out of the trimmed stretch.
        const trims = { start: 0, end: 0, interior: [{ station: 80, before: throughArm.markingTrim, after: throughArm.markingTrim }] };
        const bays = buildCorridorParkingBays([entries[0].points], mainProfile, IDENTITY_FRAME, { trims });
        bays.filter(bay => bay.kind === 'divider').forEach(bay => {
            expect(Math.abs(bay.line[0].lng)).toBeGreaterThan(throughArm.markingTrim - 6);
        });
        // and so does the bay edge line: two pieces, neither reaching into the junction.
        const edges = bays.filter(bay => bay.kind === 'edge');
        expect(edges.length).toBeGreaterThanOrEqual(2);
        edges.forEach(bay => bay.line.forEach(point => expect(Math.abs(point.lng)).toBeGreaterThanOrEqual(throughArm.markingTrim - 1e-6)));
    });

    it('builds one set for own and shared junctions and names every corridor at a node', () => {
        const set = buildCorridorJunctionSet([
            { corridorId: 'a', entries: [{ segmentId: 'a1', points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.972 }], profile: mainProfile }] },
            { corridorId: 'b', entries: [{ segmentId: 'b1', points: [{ lat: 45.8, lng: 15.971 }, { lat: 45.8005, lng: 15.971 }], profile: alleyProfile }] }
        ]);
        expect(set).toHaveLength(1);
        expect(set[0].corridorIds).toEqual(['a', 'b']);
        expect(set[0].degree).toBe(3);
        expect(set[0].landPolygons.length).toBeGreaterThan(0);
    });

    it('does not join a point crossing on a different level, but still joins the same level', () => {
        const crossing = (mainLevel, branchLevel, mainHasVertex = true) => {
            const lat = 45.8;
            const lng = 15.97;
            const offset = 0.0008;
            const main = [
                { lat, lng: lng - offset, level: mainLevel },
                ...(mainHasVertex ? [{ lat, lng, level: mainLevel }] : []),
                { lat, lng: lng + offset, level: mainLevel }
            ];
            const branch = [
                { lat: lat - offset, lng, level: branchLevel },
                { lat, lng, level: branchLevel },
                { lat: lat + offset, lng, level: branchLevel }
            ];
            return buildCorridorJunctionSet([
                { corridorId: 'main', entries: [{ points: main, profile: mainProfile }] },
                { corridorId: 'branch', entries: [{ points: branch, profile: alleyProfile }] }
            ]);
        };

        expect(crossing(0, 0)).toHaveLength(1);
        expect(crossing(undefined, undefined)).toHaveLength(1);
        expect(crossing(0, 1)).toEqual([]);
        // A branch node projected onto an edge is inserted only if its discrete level matches the span.
        expect(crossing(0, 0, false)).toHaveLength(1);
        expect(crossing(0, 1, false)).toEqual([]);
    });

    it('keeps same-position junction treatments distinct by level', () => {
        const lat = 45.8;
        const lng = 15.97;
        const offset = 0.0008;
        const levels = [0, 1];
        const junctions = buildCorridorJunctionSet([
            { corridorId: 'main', entries: levels.map(level => ({
                segmentId: `main-${level}`,
                points: [
                    { lat, lng: lng - offset, level },
                    { lat, lng, level },
                    { lat, lng: lng + offset, level }
                ],
                profile: mainProfile
            })) },
            { corridorId: 'branch', entries: levels.map(level => ({
                segmentId: `branch-${level}`,
                points: [
                    { lat: lat - offset, lng, level },
                    { lat, lng, level },
                    { lat: lat + offset, lng, level }
                ],
                profile: alleyProfile
            })) }
        ]);

        expect(junctions).toHaveLength(2);
        expect(junctions.map(junction => junction.level).sort()).toEqual([0, 1]);
        expect(junctions[0].lat).toBeCloseTo(junctions[1].lat, 7);
        expect(junctions[0].lng).toBeCloseTo(junctions[1].lng, 7);
    });

    it('chooses equal-width duplicate arms deterministically and normalizes reverse alignment', () => {
        const leftFootway = { strips: [{ type: 'sidewalk', width: 1 }, { type: 'driving', width: 9 }] };
        const rightFootway = { strips: [{ type: 'driving', width: 9 }, { type: 'sidewalk', width: 1 }] };
        const lat = 45.8;
        const lng = 15.97;
        const offset = 0.0008;
        const eastEntry = (profile, segmentId, reverse = false) => ({
            segmentId,
            points: reverse ? [{ lat, lng: lng + offset }, { lat, lng }] : [{ lat, lng }, { lat, lng: lng + offset }],
            profile
        });
        const westEntry = { segmentId: 'west', points: [{ lat, lng: lng - offset }, { lat, lng }], profile: mainProfile };
        const northEntry = { segmentId: 'north', points: [{ lat, lng }, { lat: lat + offset, lng }], profile: alleyProfile };
        const treatmentFor = eastEntries => buildCorridorJunctionSet([
            { corridorId: 'main', entries: [...eastEntries, westEntry] },
            { corridorId: 'branch', entries: [northEntry] }
        ])[0];
        const leftFirst = treatmentFor([eastEntry(leftFootway, 'east-left'), eastEntry(rightFootway, 'east-right')]);
        const rightFirst = treatmentFor([eastEntry(rightFootway, 'east-right'), eastEntry(leftFootway, 'east-left')]);

        expect(corridorProfileEdges(leftFootway).total).toBe(corridorProfileEdges(rightFootway).total);
        expect(leftFirst.surfacePolygons).toEqual(rightFirst.surfacePolygons);
        expect(leftFirst.cornerPolygons).toEqual(rightFirst.cornerPolygons);

        const forward = treatmentFor([eastEntry(leftFootway, 'east')]);
        // The mirrored strip order on a reverse-aligned segment is the same profile facing east.
        const reverse = treatmentFor([eastEntry(rightFootway, 'east', true)]);
        expect(forward.surfacePolygons).toEqual(reverse.surfacePolygons);
        expect(forward.cornerPolygons.map(corner => corner.polygon)).toEqual(reverse.cornerPolygons.map(corner => corner.polygon));
    });
});

describe('cutPolylineByStations', () => {
    it('removes the stations inside the intervals and keeps the rest as pieces', () => {
        const line = [[0, 0], [10, 0], [20, 0], [30, 0]];
        expect(cutPolylineByStations(line, [[0, 5]])).toEqual([[[5, 0], [10, 0], [20, 0], [30, 0]]]);
        expect(cutPolylineByStations(line, [[12, 18]])).toEqual([[[0, 0], [10, 0], [12, 0]], [[18, 0], [20, 0], [30, 0]]]);
        expect(cutPolylineByStations(line, [[0, 29.8]])).toEqual([]); // a 0.2 m remainder is dropped
        expect(cutPolylineByStations(line, [])).toEqual([line]);
    });
});
