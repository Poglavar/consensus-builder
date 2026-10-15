// Unit tests for frontend/js/corridor-geometry.js: centre-line graph topology, edits, shape
// conversions, track curvature and snapping. A corridor's land is corridor-footprint.js's (and its
// tests'); metres here are measured in a frame on the gesture's own points (metric-frame.js), so the
// curvature cases use real positions near Zagreb rather than an identity "projection".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    planarSegmentIntersection,
    insertCorridorCrossingNodes,
    splitCorridorSelfJunctions,
    normalizeCorridorGraph,
    normalizeCorridorNetwork,
    normalizeCorridorDefinitionTopology,
    moveCorridorNodes,
    insertCorridorNode,
    splitCorridorStretchAtNode,
    removeCorridorEdge,
    removeCorridorNodes,
    segmentsIntersect,
    polylineHasSelfIntersection,
    convertRoadPolygonToLatLngPairs,
    convertLatLngPairsToGeoJSON,
    isValidPolygonLatLngPairs,
    getMinCurvatureRadius,
    calculateCurvatureRadius,
    checkCurvatureConstraint,
    pickSnapTarget,
    VERTEX_SNAP_PREFERENCE
} = require('../../frontend/js/corridor-geometry.js');
const {
    corridorStripRingPlanar,
    corridorClosedStripPolygonPlanar,
    ringSelfIntersectsXY
} = require('../../frontend/js/corridor-profile.js');

function ring(seg) {
    return seg.map(p => [Number(p.lat.toFixed(9)), Number(p.lng.toFixed(9))]);
}

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

    it('nodes a crossing made by two non-adjacent edges of the SAME stroke', () => {
        const stroke = [P(-5, -5), P(5, 5), P(5, -5), P(-5, 5)];
        const segs = [stroke];
        insertCorridorCrossingNodes(segs, ['star']);

        const crossingCopies = segs[0].filter(point => Math.abs(point.lat) < 1e-9 && Math.abs(point.lng) < 1e-9);
        expect(crossingCopies).toHaveLength(2);
    });
});

describe('normalizeCorridorGraph', () => {
    it('turns one self-crossing stroke into simple stretches sharing a real junction', () => {
        const segments = [[P(-5, -5), P(5, 5), P(5, -5), P(-5, 5)]];
        const segmentIds = ['star'];
        const profiles = { star: { strips: [{ type: 'driving', width: 8 }] } };

        normalizeCorridorGraph(segments, segmentIds, null, profiles);

        expect(segments.length).toBeGreaterThan(1);
        expect(segmentIds).toHaveLength(segments.length);
        expect(segments.every(segment => !polylineHasSelfIntersection(segment))).toBe(true);

        // Four incident arms meet at (0,0): two tails plus both ends of the simple middle loop.
        const crossingEndpoints = segments.flatMap(segment => [segment[0], segment[segment.length - 1]])
            .filter(point => Math.abs(point.lat) < 1e-9 && Math.abs(point.lng) < 1e-9);
        expect(crossingEndpoints).toHaveLength(4);

        // Every derived stretch keeps the source cross-section instead of reverting to defaults.
        segmentIds.slice(1).forEach(id => expect(profiles[String(id)]).toEqual(profiles.star));
    });

    it('nodes and splits a closed five-point star while preserving a simple closed loop', () => {
        const star = [
            P(10, 0), P(-8, 6), P(3, -10), P(3, 10), P(-8, -6), P(10, 0)
        ];
        const simpleLoop = [P(0, 20), P(0, 30), P(10, 30), P(10, 20), P(0, 20)];
        const segments = [star, simpleLoop];
        const segmentIds = ['star', 'loop'];

        normalizeCorridorGraph(segments, segmentIds);

        expect(segments.length).toBeGreaterThan(2);
        expect(segments.every(segment => !polylineHasSelfIntersection(segment))).toBe(true);
        expect(segments.some(segment => segmentIds[segments.indexOf(segment)] === 'loop' && segment.length === 5)).toBe(true);
    });

    it('hands 3D only simple strip rings after normalizing a closed star', () => {
        const segments = [[
            P(100, 0), P(-80, 60), P(30, -100), P(30, 100), P(-80, -60), P(100, 0)
        ]];
        const segmentIds = ['star'];
        normalizeCorridorGraph(segments, segmentIds);

        segments.forEach(segment => {
            const planar = segment.map(point => [point.lng, point.lat]);
            const closed = segment.length > 2
                && Math.hypot(planar[0][0] - planar[planar.length - 1][0], planar[0][1] - planar[planar.length - 1][1]) < 1e-7;
            if (closed) {
                const rings = corridorClosedStripPolygonPlanar(planar, 4, -4);
                expect(rings).not.toBeNull();
                expect(rings.every(ring => !ringSelfIntersectsXY(ring))).toBe(true);
            } else {
                const ring = corridorStripRingPlanar(planar, 4, -4);
                expect(ring).not.toBeNull();
                expect(ringSelfIntersectsXY(ring)).toBe(false);
            }
        });
    });

    it('keeps segment and id arrays aligned when a legacy anonymous stroke is split', () => {
        const segments = [[P(-5, -5), P(5, 5), P(5, -5), P(-5, 5)]];
        const segmentIds = [null];
        splitCorridorSelfJunctions(segments, segmentIds);
        // No crossing vertices have been inserted yet, so there is nothing to split.
        expect(segments).toHaveLength(1);
        insertCorridorCrossingNodes(segments, segmentIds);
        splitCorridorSelfJunctions(segments, segmentIds);
        expect(segmentIds).toHaveLength(segments.length);
        expect(segmentIds.slice(1).every(Boolean)).toBe(true);
    });

    it('splits a through-road at a T-junction so each arm is its own segment', () => {
        // A straight road A, and a connector B whose endpoint lands on A's mid-span.
        const A = [P(0, 0), P(0, 10)];
        const B = [P(0, 5), P(5, 5)];
        const segments = [A, B];
        const segmentIds = ['A', 'B'];
        const profiles = { A: { strips: [{ type: 'driving', width: 8 }] } };

        normalizeCorridorGraph(segments, segmentIds, null, profiles);

        // A becomes two arms (A, A~…) plus the connector B — three independently-id'd segments.
        expect(segments).toHaveLength(3);
        expect(segmentIds).toHaveLength(segments.length);
        const armIds = segmentIds.filter(id => id === 'A' || String(id).startsWith('A~'));
        expect(armIds).toHaveLength(2);
        // Both arms keep A's cross-section (a split arm cannot silently revert to the default).
        armIds.forEach(id => expect(profiles[String(id)]).toEqual(profiles.A));
        // The junction (0,5) is an endpoint shared by ≥3 stretches — a real degree-3 graph node.
        const atJunction = segments.filter(s =>
            (Math.abs(s[0].lat) < 1e-9 && Math.abs(s[0].lng - 5) < 1e-9)
            || (Math.abs(s[s.length - 1].lat) < 1e-9 && Math.abs(s[s.length - 1].lng - 5) < 1e-9));
        expect(atJunction.length).toBeGreaterThanOrEqual(3);

        // Convergent: re-running does not split further.
        normalizeCorridorGraph(segments, segmentIds, null, profiles);
        expect(segments).toHaveLength(3);
    });

    it('splits both roads at an X-crossing into four arms', () => {
        const segments = [[P(-5, 0), P(5, 0)], [P(0, -5), P(0, 5)]];
        const segmentIds = ['A', 'B'];
        normalizeCorridorGraph(segments, segmentIds);
        expect(segments).toHaveLength(4);
        expect(segmentIds).toHaveLength(4);
    });

    it('leaves a lone road with no junction as one segment', () => {
        const segments = [[P(0, 0), P(0, 5), P(0, 10)]];
        const segmentIds = ['A'];
        normalizeCorridorGraph(segments, segmentIds);
        expect(segments).toHaveLength(1);
    });

    it('upgrades an already-stored definition without changing its footprint metadata', () => {
        const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] };
        const definition = {
            points: [[P(-5, -5), P(5, 5), P(5, -5), P(-5, 5)]],
            segments: [[P(-5, -5), P(5, 5), P(5, -5), P(-5, 5)]],
            segmentIds: ['star'],
            segmentProfiles: { star: { strips: [{ type: 'driving', width: 8 }] } },
            polygon
        };

        expect(normalizeCorridorDefinitionTopology(definition)).toBe(true);
        expect(definition.points).toBe(definition.segments);
        expect(definition.segmentIds).toHaveLength(definition.points.length);
        expect(definition.points.every(segment => !polylineHasSelfIntersection(segment))).toBe(true);
        expect(definition.polygon).toBe(polygon);
        expect(normalizeCorridorDefinitionTopology(definition)).toBe(false); // convergent migration
    });
});

describe('normalizeCorridorNetwork junction identity', () => {
    it('canonicalizes sub-millimetre copies of one junction across coordinate-key buckets', () => {
        const established = P(43, 15.000000049);
        const drifting = P(43, 15.000000051);
        const entries = [
            {
                segments: [[P(43, 14.999), established, P(43, 15.001)]],
                segmentIds: ['through'],
                segmentProfiles: {}
            },
            {
                segments: [[drifting, P(43.001, 15)]],
                segmentIds: ['branch'],
                segmentProfiles: {}
            }
        ];

        normalizeCorridorNetwork(entries);

        const junctions = entries.flatMap(entry => entry.segments)
            .flatMap(segment => [segment[0], segment[segment.length - 1]])
            .filter(point => Math.abs(point.lng - established.lng) < 1e-8 && Math.abs(point.lat - 43) < 1e-8);
        expect(junctions.length).toBeGreaterThanOrEqual(3);
        expect(new Set(junctions.map(point => `${point.lat},${point.lng}`)).size).toBe(1);
    });

    it('projects a centimetre near-miss endpoint onto the road it was meant to join', () => {
        const entries = [
            {
                segments: [[P(43, 15), P(43, 15.001)]],
                segmentIds: ['through'],
                segmentProfiles: {}
            },
            {
                segments: [[P(43.001, 15.0005), P(43.0000001, 15.0005)]],
                segmentIds: ['branch'],
                segmentProfiles: {}
            }
        ];

        normalizeCorridorNetwork(entries);

        const shared = entries.flatMap(entry => entry.segments)
            .flatMap(segment => [segment[0], segment[segment.length - 1]])
            .filter(point => Math.abs(point.lat - 43) < 1e-12 && Math.abs(point.lng - 15.0005) < 1e-12);
        expect(shared.length).toBeGreaterThanOrEqual(3);
        expect(entries[1].segments.some(segment => segment.some(point => point.lat === 43))).toBe(true);
    });
});

describe('authored corridor edits', () => {
    it('moves stored junctions and arm references with selected vertices without mutating the inputs', () => {
        const segments = [[{ lat: 0, lng: 0 }, { lat: 0, lng: 5, level: 1 }], [{ lat: 0, lng: 5 }, { lat: 3, lng: 5 }]];
        const junctions = [
            { lat: 0.00000001, lng: 5, arms: [{ toward: { lat: 0, lng: 10 }, width: 8 }] },
            { lat: 3, lng: 5, arms: [{ toward: { lat: 0, lng: 5 }, profile: { strips: [{ width: 4 }] } }] }
        ];
        const before = structuredClone({ segments, junctions });
        const result = moveCorridorNodes(segments, junctions, [
            { segIndex: 0, pointIndex: 1 }, { segIndex: 1, pointIndex: 0 }
        ], { lat: 1, lng: 6 });
        expect(result.changed).toBe(true);
        expect(result.segments).toEqual([[{ lat: 0, lng: 0 }, { lat: 1, lng: 6, level: 1 }], [{ lat: 1, lng: 6 }, { lat: 3, lng: 5 }]]);
        expect(result.junctions).toEqual([
            { ...junctions[0], lat: 1, lng: 6 },
            { ...junctions[1], arms: [{ ...junctions[1].arms[0], toward: { lat: 1, lng: 6 } }] }
        ]);
        expect({ segments, junctions }).toEqual(before);
        expect(moveCorridorNodes(segments, junctions, [{ segIndex: 8, pointIndex: 0 }], { lat: 1, lng: 6 }).changed).toBe(false);
    });

    it('inserts a projected node without changing segment identity, profile, or source inputs', () => {
        const segments = [[
            { lat: 0, lng: 0, level: -1, elevationM: 100 },
            { lat: 0, lng: 10, level: -1, elevationM: 120 }
        ]];
        const profiles = { main: { strips: [{ type: 'driving', width: 6 }] } };
        const source = structuredClone({ segments, profiles });
        const result = insertCorridorNode(
            segments,
            ['main'],
            profiles,
            0,
            0,
            { lat: 4, lng: 2.5 }
        );

        expect(result.changed).toBe(true);
        expect(result.segments[0]).toHaveLength(3);
        expect(result.segments[0][1]).toEqual({ lat: 0, lng: 2.5, level: -1, elevationM: 105 });
        expect(result.segmentIds).toEqual(['main']);
        expect(result.segmentProfiles).toEqual(profiles);
        expect({ segments, profiles }).toEqual(source);
    });

    it('refuses insertion on protected edges, ramps, and endpoints', () => {
        const flat = [[P(0, 0), P(0, 10)]];
        expect(insertCorridorNode(flat, ['main'], null, 0, 0, P(0, 5), { protected: true }))
            .toMatchObject({ changed: false, reason: 'protected' });

        const ramp = [[{ lat: 0, lng: 0, level: 0 }, { lat: 0, lng: 10, level: -1 }]];
        expect(insertCorridorNode(ramp, ['main'], null, 0, 0, P(0, 5)))
            .toMatchObject({ changed: false, reason: 'ramp' });
        expect(insertCorridorNode(flat, ['main'], null, 0, 0, P(0, 10)))
            .toMatchObject({ changed: false, reason: 'endpoint' });
        expect(insertCorridorNode(flat, ['main'], null, 0, 0, { lat: null, lng: 5 }))
            .toMatchObject({ changed: false, reason: 'invalid-point' });
    });

    it('removes only the selected edge and keeps every disconnected remainder in one result', () => {
        const segments = [
            [P(0, 0), P(0, 1), P(0, 2), P(0, 3)],
            [P(10, 0), P(10, 1)]
        ];
        const profiles = {
            main: { strips: [{ type: 'driving', width: 6 }] },
            east: { strips: [{ type: 'driving', width: 4 }] }
        };
        const result = removeCorridorEdge(segments, ['main', 'east'], profiles, 0, 1);

        expect(result.changed).toBe(true);
        expect(result.segments).toEqual([
            [P(0, 0), P(0, 1)],
            [P(0, 2), P(0, 3)],
            [P(10, 0), P(10, 1)]
        ]);
        expect(result.segmentIds).toEqual(['main', 'main~2', 'east']);
        expect(result.segmentProfiles['main~2']).toEqual(profiles.main);
        expect(result.segmentProfiles.east).toEqual(profiles.east);
        expect(segments[0]).toHaveLength(4);
    });

    it('does not shift an untouched segment id when the selected polyline disappears', () => {
        const result = removeCorridorEdge(
            [[P(0, 0), P(0, 1)], [P(8, 0), P(8, 1)]],
            ['removed', 'untouched'],
            { removed: { width: 9 }, untouched: { width: 3 } },
            0,
            0
        );

        expect(result.segments).toEqual([[P(8, 0), P(8, 1)]]);
        expect(result.segmentIds).toEqual(['untouched']);
        expect(result.segmentProfiles).toEqual({ untouched: { width: 3 } });
    });

    it('removes repeated node occurrences from the end and keeps ids aligned after filtering', () => {
        const result = removeCorridorNodes(
            [
                [P(0, 0), P(1, 1), P(2, 2), P(1, 1)],
                [P(9, 0), P(9, 1)]
            ],
            ['loop', 'other'],
            { loop: { width: 8 }, other: { width: 4 } },
            [{ segIndex: 0, pointIndex: 1 }, { segIndex: 0, pointIndex: 3 }]
        );

        expect(result.segments).toEqual([
            [P(0, 0), P(2, 2)],
            [P(9, 0), P(9, 1)]
        ]);
        expect(result.segmentIds).toEqual(['loop', 'other']);
    });

    // "Split the stretch here" (road-editor.md decision 3): one stretch becomes two at a vertex, so
    // each half can take its own cross-section. Nothing may move, and identity follows the bulldoze
    // rule — the leading half keeps the id, the trailing half takes a derived id and the profile copy.
    it('splits a stretch at an interior vertex, the trailing half taking a derived id and a profile copy', () => {
        const segments = [
            [P(0, 0), { lat: 0, lng: 1, level: 0 }, P(0, 2), P(0, 3)],
            [P(5, 0), P(5, 1)]
        ];
        const profiles = {
            main: { strips: [{ type: 'driving', width: 6 }] },
            east: { strips: [{ type: 'driving', width: 4 }] }
        };
        const source = structuredClone({ segments, profiles });
        const result = splitCorridorStretchAtNode(segments, ['main', 'east'], profiles, 0, 2);

        expect(result.changed).toBe(true);
        expect(result.segments).toEqual([
            [P(0, 0), { lat: 0, lng: 1, level: 0 }, P(0, 2)],
            [P(0, 2), P(0, 3)],
            [P(5, 0), P(5, 1)]
        ]);
        expect(result.segmentIds).toEqual(['main', 'main~2', 'east']);
        expect(result.derivedId).toBe('main~2');
        expect(result.segmentProfiles['main~2']).toEqual(profiles.main);
        expect(result.segmentProfiles['main~2']).not.toBe(result.segmentProfiles.main);
        expect(result.segmentProfiles.east).toEqual(profiles.east);
        // The halves meet at one position, held as two objects.
        expect(result.segments[1][0]).toEqual(result.segments[0][2]);
        expect(result.segments[1][0]).not.toBe(result.segments[0][2]);
        expect({ segments, profiles }).toEqual(source);
    });

    it('leaves both halves on the default profile when the stretch had no cross-section of its own', () => {
        const result = splitCorridorStretchAtNode([[P(0, 0), P(0, 1), P(0, 2)]], ['main'], null, 0, 1);
        expect(result.segmentIds).toEqual(['main', 'main~2']);
        expect(result.segmentProfiles).toBe(null);
    });

    it('derives a free id when the obvious one is already taken', () => {
        const result = splitCorridorStretchAtNode(
            [[P(0, 0), P(0, 1), P(0, 2)], [P(3, 0), P(3, 1)]],
            ['main', 'main~2'],
            null,
            0,
            1
        );
        expect(result.segmentIds).toEqual(['main', 'main~2~2', 'main~2']);
    });

    it('refuses the ends of a stretch, a missing vertex and a protected one', () => {
        const segments = [[P(0, 0), P(0, 1), P(0, 2)]];
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 0, 0))
            .toMatchObject({ changed: false, reason: 'endpoint' });
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 0, 2))
            .toMatchObject({ changed: false, reason: 'endpoint' });
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 0, 7))
            .toMatchObject({ changed: false, reason: 'missing-node' });
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 3, 1))
            .toMatchObject({ changed: false, reason: 'missing-node' });
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 0, 1, { protected: true }))
            .toMatchObject({ changed: false, reason: 'protected' });
        expect(splitCorridorStretchAtNode(segments, ['main'], null, 0, 1, { protected: true }).segments)
            .toEqual(segments);
    });

    it('survives the graph normalisation every edit runs: the halves are not fused back', () => {
        const result = splitCorridorStretchAtNode(
            [[P(0, 0), P(0, 0.001), P(0, 0.002)]],
            ['main'],
            { main: { strips: [{ type: 'driving', width: 6 }] } },
            0,
            1
        );
        const segments = structuredClone(result.segments);
        const ids = result.segmentIds.slice();
        const profiles = structuredClone(result.segmentProfiles);
        normalizeCorridorGraph(segments, ids, null, profiles);
        expect(segments).toEqual(result.segments);
        expect(ids).toEqual(['main', 'main~2']);
        expect(profiles).toEqual(result.segmentProfiles);
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
    it('flags a bowtie centerline and clears a simple one, with no projection involved', () => {
        // A self-crossing "bowtie": (0,0)->(2,2)->(0,2)->(2,0)
        const bowtie = [P(0, 0), P(2, 2), P(2, 0), P(0, 2)];
        expect(polylineHasSelfIntersection(bowtie)).toBe(true);
        // A simple open path
        const simple = [P(0, 0), P(0, 1), P(0, 2), P(0, 3)];
        expect(polylineHasSelfIntersection(simple)).toBe(false);
        // the same bowtie anywhere on the globe
        expect(polylineHasSelfIntersection(bowtie.map(p => P(p.lat * 1e-4 + 64.1, p.lng * 1e-4 - 21.9)))).toBe(true);
    });

    it('refuses an unreadable point instead of answering "no crossing"', () => {
        expect(() => polylineHasSelfIntersection([P(0, 0), P(1, 1), P(NaN, 0), P(0, 1)])).toThrow(/not finite/);
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
    // LL(north, east): the position that many metres north and east of a point in Zagreb, placed
    // exactly through a local frame there (metric-frame.js, checked against the ellipsoid in
    // metric-frame.test.js) — real positions, which the code under test measures in its own frame.
    const zagreb = require('../../frontend/js/metric-frame.js').frameAt([15.97, 45.8]);
    const LL = (north, east) => { const [lat, lng] = zagreb.metricToLatLng(east, north); return { lat, lng }; };

    it('getMinCurvatureRadius maps speed → radius with a 1000 m fallback', () => {
        expect(getMinCurvatureRadius(200)).toBe(3500);
        expect(getMinCurvatureRadius(50)).toBe(300);
        expect(getMinCurvatureRadius(999)).toBe(1000); // unknown speed
    });

    it('calculateCurvatureRadius is Infinity for collinear/too-close, finite for a real bend', () => {
        // Collinear (straight) → Infinity
        expect(calculateCurvatureRadius(LL(0, 0), LL(0, 10), LL(0, 20))).toBe(Infinity);
        // Too close → Infinity
        expect(calculateCurvatureRadius(LL(0, 0), LL(0, 0.01), LL(0, 0.02))).toBe(Infinity);
        // A right-angle bend → the circle through the three points: radius 10·√2 m
        const r = calculateCurvatureRadius(LL(0, 0), LL(0, 20), LL(20, 20));
        expect(r).toBeCloseTo(10 * Math.SQRT2, 2);
    });

    it('checkCurvatureConstraint accepts a straight run and a gentle curve', () => {
        // Fewer than 2 prior points → trivially valid
        expect(checkCurvatureConstraint([LL(0, 0)], LL(0, 10), 300).valid).toBe(true);
        // A straight continuation → not violating
        const straight = checkCurvatureConstraint([LL(0, 0), LL(0, 100)], LL(0, 200), 300);
        expect(straight.valid).toBe(true);
        expect(straight.violatesConstraint).toBe(false);
    });

    it('checkCurvatureConstraint flags or adjusts a too-sharp turn', () => {
        // A sharp near-right-angle turn against a large min radius: either flagged or nudged.
        const res = checkCurvatureConstraint([LL(0, 0), LL(0, 20)], LL(20, 20), 3500);
        expect(res.violatesConstraint || res.wasAdjusted).toBe(true);
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

    // Was "uses EXTERNAL corridors only when no local snap wins": the ladder was tier-first, so any
    // local candidate in range beat any placed corridor. Snapping is nearest-first now
    // (road-editor.md decision 4); this keeps the part that still holds — an external corridor
    // snaps when it is what the cursor is near.
    it('snaps to an EXTERNAL corridor the cursor is near', () => {
        const external = [{ points: [px(200, 200), px(300, 200)] }];
        // Cursor near the external corridor, far from all local geometry → an external snap wins.
        const snap = pickSnapTarget(px(201, 201), local(), external, -1, 12);
        expect(snap.source).toBe('external');
        expect(snap.externalIndex).toBe(0);
        // Snapping BEFORE the edge start clamps to the endpoint (projection t < 0).
        const atEnd = pickSnapTarget(px(198, 200), local(), external, -1, 12);
        expect(atEnd.kind).toBe('external-endpoint');
    });

    it('lets a node within half the radius win over a street line passing through it', () => {
        // The drawing's node (0,50) sits on a street running along x=0. A click 2 px along the
        // street is 2 px from both; the node must win so the stretch resumes instead of a new
        // one starting on the street's centre line.
        const street = [{ points: [px(0, -100), px(0, 200)], name: 'Ilica', wayId: '1' }];
        const snap = pickSnapTarget(px(0, 52), [[px(0, 0), px(0, 50)]], [], -1, 12, street);
        expect(snap.source).toBe('local');
        expect(snap.kind).toBe('endpoint');
        // Beyond half the radius the ranking decides as usual: 9 px node (rank 6.3) vs 0 px street.
        const far = pickSnapTarget(px(0, 59), [[px(0, 0), px(0, 50)]], [], -1, 12, street);
        expect(far.source).toBe('street');
    });

    it('lets a near external node beat a farther local vertex (nearest-first, not tier-first)', () => {
        // Local vertex (0,52) is 10 px from the cursor; the applied road's node (2,62) is 2 px away
        // (and its centre line x = 2 is 2 px away too, which the node's preference beats). The old
        // tier-first ladder took the local vertex because it was in range at all.
        const external = [{ points: [px(2, 20), px(2, 62), px(2, 120)] }];
        const snap = pickSnapTarget(px(0, 62), [[px(0, 0), px(0, 52)]], external, -1, 12);
        expect(snap.source).toBe('external');
        expect(snap.kind).toBe('external-node');
        expect(snap.vertexIndex).toBe(1);
        expect(snap.distance).toBe(2);
    });

    it('prefers a vertex within 0.7 of an edge distance, and the edge beyond it', () => {
        expect(VERTEX_SNAP_PREFERENCE).toBe(0.7);
        // Vertex (0,0) of segment A; segment B's edge runs along y = 7.5, so the edge is 7.5 px from
        // a cursor at (0,10) while the vertex is 10 px away: 10 × 0.7 = 7 < 7.5 → the vertex wins.
        const segments = [[px(0, 0), px(-50, 0)], [px(-60, 17.5), px(60, 17.5)]];
        const near = pickSnapTarget(px(0, 10), segments, [], -1, 12);
        expect(near.kind).toBe('endpoint');
        expect(near.segmentIndex).toBe(0);
        expect(near.distance).toBe(10);
        // Move the edge to y = 16.5: now 6.5 px away, and 6.5 < 7 → the edge wins.
        const closer = [[px(0, 0), px(-50, 0)], [px(-60, 16.5), px(60, 16.5)]];
        const edge = pickSnapTarget(px(0, 10), closer, [], -1, 12);
        expect(edge.kind).toBe('edge');
        expect(edge.segmentIndex).toBe(1);
    });

    it('never ranks a vertex outside the radius in, whatever its preference', () => {
        // 15 px × 0.7 = 10.5 would rank under 12, but the radius is a plain pixel distance.
        expect(pickSnapTarget(px(0, 15), [[px(0, 0), px(-50, 0)]], [], -1, 12)).toBeNull();
    });

    it('keeps the earlier candidate on a tie: local before applied', () => {
        // Two vertices exactly 5 px away: this drawing's own and an applied corridor's.
        const snap = pickSnapTarget(px(5, 0), [[px(0, 0), px(0, -50)]], [{ points: [px(10, 0), px(10, 50)] }], -1, 12);
        expect(snap.source).toBe('local');
    });

    it('snaps to an existing street node or its centre line, naming the street', () => {
        const streets = [{ points: [px(100, 300), px(150, 300), px(200, 300)], name: 'Ulica X', wayId: '42' }];
        const node = pickSnapTarget(px(151, 303), [], [], -1, 12, streets);
        expect(node).toMatchObject({ source: 'street', kind: 'street-node', streetIndex: 0, vertexIndex: 1, name: 'Ulica X', wayId: '42' });
        const edge = pickSnapTarget(px(125, 304), [], [], -1, 12, streets);
        expect(edge).toMatchObject({ source: 'street', kind: 'street-edge', streetIndex: 0, insertAfter: 0, name: 'Ulica X' });
        expect(edge.pixel).toEqual(px(125, 300));
    });

    it('lets a nearer street beat a farther applied road, and keeps old five-argument calls working', () => {
        const external = [{ points: [px(0, 0), px(100, 0)] }];
        const streets = [{ points: [px(0, 9), px(100, 9)], name: 'Ulica Y', wayId: '7' }];
        expect(pickSnapTarget(px(50, 7), [], external, -1, 12, streets).source).toBe('street');
        expect(pickSnapTarget(px(50, 7), [], external, -1, 12).source).toBe('external');
    });

    it('snaps to an existing external INTERNAL NODE before its centreline', () => {
        const external = [{ points: [px(200, 200), px(250, 200), px(300, 200)] }];
        const snap = pickSnapTarget(px(253, 204), local(), external, -1, 12);
        expect(snap.kind).toBe('external-node');
        expect(snap.vertexIndex).toBe(1);
        expect(snap.pixel).toEqual(px(250, 200));
    });

    it('returns null when nothing is within the radius', () => {
        expect(pickSnapTarget(px(500, 500), local(), [], -1, 12)).toBeNull();
    });
});
