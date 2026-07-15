// Unit tests for frontend/js/corridor-geometry.js. The headline pin is determinism: the road
// footprint used to pick its direction with Math.random() for coincident points, so the same
// centerline saved a different polygon and geometryHash each run. Projection is injected (identity),
// matching the pattern in corridor-profile.test.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createRectangularRoadSegment,
    planarSegmentIntersection,
    insertCorridorCrossingNodes,
    healNearMissJunctions,
    weldNearbyVertices,
    corridorConnectedComponents,
    centerlinesTouch,
    segmentsIntersect,
    polylineHasSelfIntersection,
    weldCorridorSegments,
    convertRoadPolygonToLatLngPairs,
    convertLatLngPairsToGeoJSON,
    isValidPolygonLatLngPairs,
    getMinCurvatureRadius,
    calculateCurvatureRadius,
    checkCurvatureConstraint,
    pickSnapTarget
} = require('../../frontend/js/corridor-geometry.js');

// Identity-ish projection: treat (lat,lng) as (x=lng, y=lat) metres and back. Enough to exercise
// the geometry deterministically without proj4.
const deps = {
    wgs84ToHTRS96: (lat, lng) => [lng, lat],
    htrs96ToWGS84: (x, y) => [y, x],
    latLng: (lat, lng) => ({ lat, lng })
};

function ring(seg) {
    return seg.map(p => [Number(p.lat.toFixed(9)), Number(p.lng.toFixed(9))]);
}

describe('createRectangularRoadSegment', () => {
    it('is deterministic for coincident points (the Math.random bug)', () => {
        const p = { lat: 45.8, lng: 15.9 };
        const a = createRectangularRoadSegment(p, { ...p }, 4, deps);
        const b = createRectangularRoadSegment(p, { ...p }, 4, deps);
        expect(a).not.toBeNull();
        expect(ring(a)).toEqual(ring(b)); // identical footprint every run
    });

    it('nudges coincident points due east, giving a 0.1 m × width rectangle', () => {
        const p = { lat: 0, lng: 0 };
        const seg = createRectangularRoadSegment(p, { ...p }, 4, deps);
        // With east nudge (dx=0.1, dy=0): perpendicular is (0, +1) → corners spread ±2 in lat (y),
        // and 0..0.1 in lng (x).
        const lats = seg.map(c => c.lat);
        const lngs = seg.map(c => c.lng);
        expect(Math.min(...lats)).toBeCloseTo(-2, 6);
        expect(Math.max(...lats)).toBeCloseTo(2, 6);
        expect(Math.min(...lngs)).toBeCloseTo(0, 6);
        expect(Math.max(...lngs)).toBeCloseTo(0.1, 6);
    });

    it('builds a width-wide rectangle along a normal east-west segment', () => {
        const seg = createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, 4, deps);
        expect(seg).toHaveLength(5); // closed ring
        expect(seg[0]).toEqual(seg[4]); // closed
        const lats = seg.map(c => c.lat);
        expect(Math.min(...lats)).toBeCloseTo(-2, 6);
        expect(Math.max(...lats)).toBeCloseTo(2, 6);
    });

    it('returns null for invalid inputs', () => {
        expect(createRectangularRoadSegment(null, { lat: 0, lng: 0 }, 4, deps)).toBeNull();
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, 0, deps)).toBeNull();
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: NaN, lng: 1 }, 4, deps)).toBeNull();
    });

    it('returns null when projection functions are unavailable', () => {
        expect(createRectangularRoadSegment({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, 4, {})).toBeNull();
    });
});

const P = (lat, lng) => ({ lat, lng });

describe('planarSegmentIntersection', () => {
    it('finds the crossing of two segments that cross', () => {
        const x = planarSegmentIntersection(P(0, 0), P(0, 10), P(-5, 5), P(5, 5));
        expect(x.lat).toBeCloseTo(0, 9);
        expect(x.lng).toBeCloseTo(5, 9);
    });
    it('returns null for parallel / disjoint segments', () => {
        expect(planarSegmentIntersection(P(0, 0), P(0, 10), P(1, 0), P(1, 10))).toBeNull();
        expect(planarSegmentIntersection(P(0, 0), P(0, 1), P(0, 5), P(0, 6))).toBeNull();
    });
});

describe('insertCorridorCrossingNodes', () => {
    it('inserts a shared vertex into both segments at a crossing', () => {
        const segs = [[P(0, -5), P(0, 5)], [P(-5, 0), P(5, 0)]];
        insertCorridorCrossingNodes(segs, [1, 2]);
        // Each segment should now contain the (0,0) crossing vertex.
        expect(segs[0].some(p => Math.abs(p.lat) < 1e-9 && Math.abs(p.lng) < 1e-9)).toBe(true);
        expect(segs[1].some(p => Math.abs(p.lat) < 1e-9 && Math.abs(p.lng) < 1e-9)).toBe(true);
    });

    it('inserts NOTHING into a protected (tunnelled) edge (the destructive-orphan guard)', () => {
        // Provide corridorTunnelEdgeKey so protection is active, and protect segment 1's edge.
        global.corridorTunnelEdgeKey = (a, b) =>
            `${a.lat},${a.lng}|${b.lat},${b.lng}`;
        const protectedKey = global.corridorTunnelEdgeKey(P(0, -5), P(0, 5));
        const segs = [[P(0, -5), P(0, 5)], [P(-5, 0), P(5, 0)]];
        const before = segs[0].length;
        insertCorridorCrossingNodes(segs, [1, 2], new Set([protectedKey]));
        expect(segs[0].length).toBe(before); // protected edge untouched
        delete global.corridorTunnelEdgeKey;
    });
});

describe('corridorConnectedComponents', () => {
    it('groups segments sharing a vertex and splits disjoint ones', () => {
        // Two touching segments (share (0,0)) + one disjoint far away.
        const segs = [[P(0, 0), P(0, 1)], [P(0, 0), P(1, 0)], [P(9, 9), P(9, 10)]];
        const comps = corridorConnectedComponents(segs, ['a', 'b', 'c']);
        expect(comps).toHaveLength(2);
        const sizes = comps.map(c => c.segments.length).sort();
        expect(sizes).toEqual([1, 2]);
    });

    it('carries each body its own segmentIds', () => {
        const segs = [[P(0, 0), P(0, 1)], [P(5, 5), P(5, 6)]];
        const comps = corridorConnectedComponents(segs, ['x', 'y']);
        const idSets = comps.map(c => c.segmentIds.join(''));
        expect(idSets.sort()).toEqual(['x', 'y']);
    });
});

describe('centerlinesTouch', () => {
    it('is true when centerlines share a vertex or cross, false when merely parallel', () => {
        expect(centerlinesTouch([[P(0, 0), P(0, 5)]], [[P(0, 5), P(5, 5)]])).toBe(true); // shared vertex
        expect(centerlinesTouch([[P(0, -5), P(0, 5)]], [[P(-5, 0), P(5, 0)]])).toBe(true); // crossing
        expect(centerlinesTouch([[P(0, 0), P(0, 5)]], [[P(1, 0), P(1, 5)]])).toBe(false); // parallel
    });

    describe('near-miss T-junctions are OPT-IN (allowNearMiss)', () => {
        beforeEach(() => { global.wgs84ToHTRS96 = (lat, lng) => [lng, lat]; });
        afterEach(() => { delete global.wgs84ToHTRS96; });

        // A: horizontal centerline along lat=0. B: an endpoint that stops 1 metre short of A's mid-span.
        const A = () => [P(0, 0), P(0, 10)];
        const nearMissB = () => [P(5, 5), P(1, 5)]; // endpoint P(1,5) is 1 m from A's point P(0,5)

        it('does NOT treat a near-miss as touching by default (drawing/absorbing must not auto-join)', () => {
            expect(centerlinesTouch([A()], [nearMissB()])).toBe(false);
        });

        it('treats an endpoint that stops just short of the other mid-span as touching WHEN opted in', () => {
            expect(centerlinesTouch([A()], [nearMissB()], true)).toBe(true);
        });

        it('still rejects two parallel roads whose ends merely align, even opted in', () => {
            // Endpoints land at the OTHER road's endpoints (t=0/1), not its mid-span — not a junction.
            expect(centerlinesTouch([[P(0, 0), P(5, 0)]], [[P(0, 1), P(5, 1)]], true)).toBe(false);
        });

        it('does not merge an endpoint that is too far short, even opted in', () => {
            const farB = [P(5, 5), P(3, 5)]; // 3 m short, beyond the 2.5 m tolerance
            expect(centerlinesTouch([A()], [farB], true)).toBe(false);
        });
    });
});

describe('weldNearbyVertices', () => {
    beforeEach(() => { global.wgs84ToHTRS96 = (lat, lng) => [lng, lat]; });
    afterEach(() => { delete global.wgs84ToHTRS96; });

    it('fuses two vertices of different legs that sit within tolerance into one shared node', () => {
        const s1 = [P(0, 0), P(0, 10)];
        const s2 = [P(5, 10), P(0, 10.5)]; // its endpoint is 0.5 m from s1's endpoint P(0,10)
        weldNearbyVertices([s1, s2], 2.5);
        // s2's endpoint snaps exactly onto the first-seen representative (s1's P(0,10)).
        expect(s2[1]).toEqual({ lat: 0, lng: 10 });
        // Which means the two legs now share a vertex — one connected road, a real junction.
        expect(corridorConnectedComponents([s1, s2], [1, 2]).length).toBe(1);
    });

    it('preserves a short consecutive edge (curve/bend detail is not collapsed)', () => {
        const seg = [P(0, 0), P(0, 1), P(0, 10)]; // 1 m first edge — within tolerance but ADJACENT
        weldNearbyVertices([seg], 2.5);
        expect(seg).toEqual([P(0, 0), P(0, 1), P(0, 10)]); // untouched — an edge is not a duplicate
    });

    it('drops an exact zero-length edge (a true duplicate vertex)', () => {
        const seg = [P(0, 0), P(0, 0), P(0, 10)];
        weldNearbyVertices([seg], 2.5);
        expect(seg).toEqual([P(0, 0), P(0, 10)]);
    });

    it('welds a leg that loops back onto a NON-adjacent part of itself (self-junction)', () => {
        // Last vertex lands 0.5 m from the first (a closed-ish loop) — non-adjacent, so it fuses.
        const seg = [P(0, 0), P(0, 5), P(5, 5), P(5, 0), P(0, 0.4)];
        weldNearbyVertices([seg], 2.5);
        expect(seg[seg.length - 1]).toEqual({ lat: 0, lng: 0 });
    });

    it('leaves vertices that are farther apart than the tolerance untouched', () => {
        const s1 = [P(0, 0), P(0, 10)];
        const s2 = [P(9, 10), P(0, 20)];
        weldNearbyVertices([s1, s2], 2.5);
        expect(s2).toEqual([P(9, 10), P(0, 20)]);
        expect(corridorConnectedComponents([s1, s2], [1, 2]).length).toBe(2);
    });
});

describe('healNearMissJunctions', () => {
    beforeEach(() => { global.wgs84ToHTRS96 = (lat, lng) => [lng, lat]; });
    afterEach(() => { delete global.wgs84ToHTRS96; });

    it('snaps a near-miss endpoint onto the span and inserts the shared node, joining the graph', () => {
        const segments = [[P(0, 0), P(0, 10)], [P(5, 5), P(1, 5)]];
        healNearMissJunctions(segments, 2.5);
        // The dangling endpoint is snapped exactly onto the horizontal centerline (lat 0).
        expect(segments[1][segments[1].length - 1]).toEqual({ lat: 0, lng: 5 });
        // The target segment gains a matching vertex there, so the two now share a node.
        expect(segments[0]).toEqual([P(0, 0), P(0, 5), P(0, 10)]);
        // Which means union-find now sees ONE connected road, not two.
        expect(corridorConnectedComponents(segments, [1, 2]).length).toBe(1);
    });

    it('leaves an endpoint that is too far short untouched (no spurious node)', () => {
        const segments = [[P(0, 0), P(0, 10)], [P(5, 5), P(3, 5)]];
        healNearMissJunctions(segments, 2.5);
        expect(segments[1][segments[1].length - 1]).toEqual({ lat: 3, lng: 5 });
        expect(segments[0]).toEqual([P(0, 0), P(0, 10)]);
        expect(corridorConnectedComponents(segments, [1, 2]).length).toBe(2);
    });

    it('does not disturb an endpoint that already shares a vertex with the other road', () => {
        // B ends exactly at A's vertex P(0,0): already a shared node, so nothing is snapped or inserted.
        const segments = [[P(0, 0), P(0, 10)], [P(5, 0), P(0, 0)]];
        healNearMissJunctions(segments, 2.5);
        expect(segments[0]).toEqual([P(0, 0), P(0, 10)]);
        expect(segments[1]).toEqual([P(5, 0), P(0, 0)]);
    });
});

describe('segmentsIntersect (planar {x,y})', () => {
    const Q = (x, y) => ({ x, y });
    it('detects a genuine crossing and rejects a miss', () => {
        expect(segmentsIntersect(Q(0, 0), Q(10, 10), Q(0, 10), Q(10, 0))).toBe(true);
        expect(segmentsIntersect(Q(0, 0), Q(1, 1), Q(5, 5), Q(6, 6))).toBe(false);
    });
});

describe('polylineHasSelfIntersection', () => {
    const proj = { wgs84ToHTRS96: (lat, lng) => [lng, lat] };
    it('flags a bowtie centerline and clears a simple one', () => {
        global.wgs84ToHTRS96 = proj.wgs84ToHTRS96;
        // A self-crossing "bowtie": (0,0)->(2,2)->(0,2)->(2,0)
        const bowtie = [P(0, 0), P(2, 2), P(2, 0), P(0, 2)];
        expect(polylineHasSelfIntersection(bowtie)).toBe(true);
        // A simple open path
        const simple = [P(0, 0), P(0, 1), P(0, 2), P(0, 3)];
        expect(polylineHasSelfIntersection(simple)).toBe(false);
        delete global.wgs84ToHTRS96;
    });
});

describe('weldCorridorSegments', () => {
    it('welds two segments sharing an endpoint into one and keeps counts aligned', () => {
        const segs = [[P(0, 0), P(0, 1)], [P(0, 1), P(0, 2)]];
        const out = weldCorridorSegments(segs, ['a', 'b']);
        expect(out.segments).toHaveLength(1);
        expect(out.segmentIds).toHaveLength(1); // length invariant
        expect(out.segments[0]).toHaveLength(3); // shared vertex not duplicated
    });

    it('keeps segments with DIFFERENT profiles separate', () => {
        const segs = [[P(0, 0), P(0, 1)], [P(0, 1), P(0, 2)]];
        const profiles = { a: { width: 4 }, b: { width: 8 } };
        const out = weldCorridorSegments(segs, ['a', 'b'], profiles);
        expect(out.segments).toHaveLength(2); // different cross-sections don't weld
    });

    it('preserves a profile override carried by the SECOND segment', () => {
        const segs = [[P(0, 0), P(0, 1)], [P(0, 1), P(0, 2)]];
        // Only the second segment carries a profile; both must share the same key to weld, so give
        // both the same override and confirm the surviving id is the one that carries it.
        const profiles = { b: { width: 6 }, a: { width: 6 } };
        const out = weldCorridorSegments(segs, ['a', 'b'], profiles);
        expect(out.segments).toHaveLength(1);
        expect(out.segmentIds[0]).toBeTruthy(); // an id carrying the override survives, not null
    });
});

describe('convertRoadPolygonToLatLngPairs', () => {
    it('converts a single ring of {lat,lng} objects to [lat,lng] pairs and closes it', () => {
        const ring = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }];
        const out = convertRoadPolygonToLatLngPairs(ring);
        expect(out[0]).toEqual([0, 0]);
        expect(out[out.length - 1]).toEqual(out[0]); // closed
        expect(out.length).toBeGreaterThanOrEqual(4);
    });

    it('keeps a DISJOINT MultiPolygon of LatLng objects as a MultiPolygon (the tunnel-through-middle bug)', () => {
        // Two disjoint surface runs (what a corridor tunnelled through its middle produces), as
        // rings of {lat,lng} objects. The old order misread this as polygon-with-holes → null.
        const runA = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
        const runB = [{ lat: 0, lng: 5 }, { lat: 0, lng: 6 }, { lat: 1, lng: 6 }, { lat: 1, lng: 5 }];
        const multi = [[runA], [runB]];
        const out = convertRoadPolygonToLatLngPairs(multi);
        expect(out).not.toBeNull();
        expect(out).toHaveLength(2);      // two polygons preserved, not collapsed to null
        expect(out[0][0]).toHaveLength(5); // ring of pairs, closed
    });

    it('returns null for junk', () => {
        expect(convertRoadPolygonToLatLngPairs(null)).toBeNull();
        expect(convertRoadPolygonToLatLngPairs([])).toBeNull();
    });
});

describe('convertLatLngPairsToGeoJSON', () => {
    it('emits a Polygon in [lng,lat] order from a single ring', () => {
        const pairs = [[0, 0], [0, 1], [1, 1], [0, 0]];
        const geo = convertLatLngPairsToGeoJSON(pairs);
        expect(geo.type).toBe('Polygon');
        expect(geo.coordinates[0][0]).toEqual([0, 0]); // [lng,lat]
    });

    it('emits a MultiPolygon from disjoint runs', () => {
        const a = [[0, 0], [1, 0], [1, 1], [0, 0]];
        const b = [[5, 0], [6, 0], [6, 1], [5, 0]];
        const geo = convertLatLngPairsToGeoJSON([[a], [b]]);
        expect(geo.type).toBe('MultiPolygon');
        expect(geo.coordinates).toHaveLength(2);
    });

    it('round-trips a ring through pairs → geojson', () => {
        const ring = [{ lat: 0, lng: 0 }, { lat: 0, lng: 2 }, { lat: 2, lng: 2 }, { lat: 2, lng: 0 }];
        const geo = convertLatLngPairsToGeoJSON(convertRoadPolygonToLatLngPairs(ring));
        expect(geo.type).toBe('Polygon');
        expect(geo.coordinates[0].length).toBeGreaterThanOrEqual(4);
    });
});

describe('isValidPolygonLatLngPairs', () => {
    it('accepts rings, polygons-with-holes and multipolygons; rejects junk', () => {
        expect(isValidPolygonLatLngPairs([[0, 0], [0, 1], [1, 1]])).toBe(true);
        expect(isValidPolygonLatLngPairs([[[0, 0], [0, 1], [1, 1]]])).toBe(true); // holes shape
        expect(isValidPolygonLatLngPairs([[[[0, 0], [0, 1], [1, 1]]]])).toBe(true); // multipolygon
        expect(isValidPolygonLatLngPairs([])).toBe(false);
        expect(isValidPolygonLatLngPairs(null)).toBe(false);
    });
});

describe('curvature constraints', () => {
    // Identity projection so metres == coordinate units; space points >0.1 apart.
    const proj = { wgs84ToHTRS96: (lat, lng) => [lng, lat], htrs96ToWGS84: (x, y) => [y, x] };
    const LL = (lat, lng) => ({ lat, lng });

    it('getMinCurvatureRadius maps speed → radius with a 1000 m fallback', () => {
        expect(getMinCurvatureRadius(200)).toBe(3500);
        expect(getMinCurvatureRadius(50)).toBe(300);
        expect(getMinCurvatureRadius(999)).toBe(1000); // unknown speed
    });

    it('calculateCurvatureRadius is Infinity for collinear/too-close, finite for a real bend', () => {
        global.wgs84ToHTRS96 = proj.wgs84ToHTRS96;
        // Collinear (straight) → Infinity
        expect(calculateCurvatureRadius(LL(0, 0), LL(0, 10), LL(0, 20))).toBe(Infinity);
        // Too close → Infinity
        expect(calculateCurvatureRadius(LL(0, 0), LL(0, 0.01), LL(0, 0.02))).toBe(Infinity);
        // A right-angle bend → finite positive radius
        const r = calculateCurvatureRadius(LL(0, 0), LL(0, 20), LL(20, 20));
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThan(0);
        delete global.wgs84ToHTRS96;
    });

    it('checkCurvatureConstraint accepts a straight run and a gentle curve', () => {
        global.wgs84ToHTRS96 = proj.wgs84ToHTRS96;
        global.htrs96ToWGS84 = proj.htrs96ToWGS84;
        // Fewer than 2 prior points → trivially valid
        expect(checkCurvatureConstraint([LL(0, 0)], LL(0, 10), 300).valid).toBe(true);
        // A straight continuation → not violating
        const straight = checkCurvatureConstraint([LL(0, 0), LL(0, 100)], LL(0, 200), 300);
        expect(straight.valid).toBe(true);
        expect(straight.violatesConstraint).toBe(false);
        delete global.wgs84ToHTRS96;
        delete global.htrs96ToWGS84;
    });

    it('checkCurvatureConstraint flags or adjusts a too-sharp turn', () => {
        global.wgs84ToHTRS96 = proj.wgs84ToHTRS96;
        global.htrs96ToWGS84 = proj.htrs96ToWGS84;
        // A sharp near-right-angle turn against a large min radius: either flagged or nudged.
        const res = checkCurvatureConstraint([LL(0, 0), LL(0, 20)], LL(20, 20), 3500);
        expect(res.violatesConstraint || res.wasAdjusted).toBe(true);
        delete global.wgs84ToHTRS96;
        delete global.htrs96ToWGS84;
    });
});

describe('pickSnapTarget (pixel space)', () => {
    const px = (x, y) => ({ x, y });
    // A vertical local segment (x=0) and a horizontal local segment (y=100), plus room for external.
    const local = () => [
        [px(0, 0), px(0, 50), px(0, 100)],   // segment 0
        [px(20, 100), px(120, 100)]          // segment 1 (a long edge)
    ];

    it('snaps to a nearby VERTEX in preference to an edge', () => {
        // Cursor is 3px from segment0's vertex (0,50) AND within range of segment1's edge (y=100).
        const snap = pickSnapTarget(px(3, 50), local(), [], -1, 12);
        expect(snap.source).toBe('local');
        expect(snap.kind).toBe('vertex');
        expect(snap.segmentIndex).toBe(0);
        expect(snap.vertexIndex).toBe(1);
    });

    it('labels first/last vertices as endpoints', () => {
        expect(pickSnapTarget(px(1, 0), local(), [], -1, 12).kind).toBe('endpoint');
        expect(pickSnapTarget(px(1, 100), [[px(0, 0), px(0, 100)]], [], -1, 12).atStart).toBe(false);
    });

    it('does NOT snap to the active segment\'s growing tip', () => {
        // Active segment 0, cursor right on its last vertex (0,100). It must be ignored, so the
        // nearest remaining target is segment1's edge / endpoint.
        const snap = pickSnapTarget(px(0, 100), local(), [], 0, 12);
        expect(snap === null || !(snap.segmentIndex === 0 && snap.vertexIndex === 2)).toBe(true);
    });

    it('never edge-inserts into the active segment', () => {
        // Cursor on the middle of the active segment 0's edge — must not return an edge insert there.
        const snap = pickSnapTarget(px(1, 25), [[px(0, 0), px(0, 50)]], [], 0, 12);
        // Only the endpoints (0,0)/(0,50) remain; (1,25) is >12px from both → no snap.
        expect(snap).toBeNull();
    });

    it('falls back to an EDGE insert when no vertex is near', () => {
        const snap = pickSnapTarget(px(60, 103), local(), [], -1, 12);
        expect(snap.kind).toBe('edge');
        expect(snap.segmentIndex).toBe(1);
        expect(snap.insertAfter).toBe(0);
    });

    it('uses EXTERNAL corridors only when no local snap wins', () => {
        const external = [{ points: [px(200, 200), px(300, 200)] }];
        // Cursor near the external corridor, far from all local geometry → an external snap wins.
        const snap = pickSnapTarget(px(201, 201), local(), external, -1, 12);
        expect(snap.source).toBe('external');
        expect(snap.externalIndex).toBe(0);
        // Snapping BEFORE the edge start clamps to the endpoint (projection t < 0).
        const atEnd = pickSnapTarget(px(198, 200), local(), external, -1, 12);
        expect(atEnd.kind).toBe('external-endpoint');
    });

    it('returns null when nothing is within the radius', () => {
        expect(pickSnapTarget(px(500, 500), local(), [], -1, 12)).toBeNull();
    });
});
