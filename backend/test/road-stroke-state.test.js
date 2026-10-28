// Unit tests for frontend/js/road-stroke-state.js — the road-drawing state transitions: undo, the
// pen lift, double-click detection, and the obstacles recorded per edge and applied at Finish.
// The headline is the index-alignment invariant: segments.length === segmentIds.length must survive
// ANY sequence of push/undo/lift, because a per-segment cross-section override is keyed by its id.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyPenLift, applyRoadUndo } = require('../../frontend/js/road-stroke-state.js');

const pt = (lat, lng) => ({ lat, lng });

describe('applyRoadUndo', () => {
    it('pops the last vertex of the active segment', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1), pt(0, 2)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true
        };
        const r = applyRoadUndo(state);
        expect(r.undone).toBe(true);
        expect(state.segments[0]).toHaveLength(2);
        expect(r.removedEdges).toEqual([[pt(0, 1), pt(0, 2)]]);
        expect(state.segments.length).toBe(state.segmentIds.length);
    });

    it('drops the segment (and its id) when the undo empties it', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1)], [pt(5, 5)]],
            segmentIds: ['a', 'b'],
            activeIndex: 1, hasStarted: true
        };
        // A stray first click (pt(5,5)) must be undoable: the stub goes, its id with it, pen up.
        const r = applyRoadUndo(state);
        expect(r.undone).toBe(true);
        expect(r.removedEdges).toEqual([]);
        expect(state.segments).toEqual([[pt(0, 0), pt(0, 1)]]);
        expect(state.segmentIds).toEqual(['a']);
        expect(r.hasStarted).toBe(false);
        expect(r.activeIndex).toBe(-1);
    });

    it('undoes the only point of a fresh drawing, leaving it empty', () => {
        const state = { segments: [[pt(1, 1)]], segmentIds: ['a'], activeIndex: 0, hasStarted: true };
        const r = applyRoadUndo(state);
        expect(r.undone).toBe(true);
        expect(state.segments).toEqual([]);
        expect(state.segmentIds).toEqual([]);
        expect(r.hasStarted).toBe(false);
        // …and a further undo is a no-op.
        expect(applyRoadUndo({ segments: state.segments, segmentIds: state.segmentIds, activeIndex: -1, hasStarted: false }).undone).toBe(false);
    });

    it('empties a 2-point active segment down to nothing and removes it in lockstep', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true
        };
        const r = applyRoadUndo(state); // pops (0,1) → [pt(0,0)] length 1, not empty yet
        expect(state.segments[0]).toHaveLength(1);
        expect(r.hasStarted).toBe(true);
        expect(state.segments.length).toBe(state.segmentIds.length);
    });

    it('resumes the last segment when the pen is up', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1), pt(0, 2)]],
            segmentIds: ['a'],
            activeIndex: -1, hasStarted: false
        };
        const r = applyRoadUndo(state);
        expect(r.undone).toBe(true);
        expect(r.hasStarted).toBe(true);
        expect(r.activeIndex).toBe(0);
        expect(state.segments[0]).toHaveLength(2); // resumed then popped one
    });

    it('is a no-op with nothing to undo', () => {
        expect(applyRoadUndo({ segments: [], segmentIds: [], activeIndex: -1, hasStarted: false }).undone).toBe(false);
        expect(applyRoadUndo({ segments: [[]], segmentIds: ['a'], activeIndex: -1, hasStarted: false }).undone).toBe(false);
    });
});

// Escape used to CANCEL the stroke (applyStrokeCancel popped it back to where the pen went down,
// with no undo) while the status said the segments stayed. Decision 5 of road-editor.md: Escape
// lifts the pen and keeps what was placed. applyStrokeCancel and its tests are gone with it.
describe('applyPenLift', () => {
    it('keeps every point the stroke placed and keeps segments and ids aligned', () => {
        const state = {
            segments: [[pt(5, 5), pt(5, 6)], [pt(0, 0), pt(0, 1), pt(0, 2), pt(0, 3)]],
            segmentIds: ['a', 'b'],
            activeIndex: 1, hasStarted: true
        };
        const r = applyPenLift(state);
        expect(r.lifted).toBe(true);
        expect(r.dropped).toBe(false);
        expect(state.segments[1]).toEqual([pt(0, 0), pt(0, 1), pt(0, 2), pt(0, 3)]); // nothing popped
        expect(state.segmentIds).toEqual(['a', 'b']);
        expect(r.removedEdges).toEqual([]);
        expect(r.hasStarted).toBe(false);
        expect(r.activeIndex).toBe(-1);
        expect(state.segments.length).toBe(state.segmentIds.length);
    });

    it('drops a one-point stroke (a lone click is no line) together with its id', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1)], [pt(9, 9)]],
            segmentIds: ['keep', 'stub'],
            activeIndex: 1, hasStarted: true
        };
        const r = applyPenLift(state);
        expect(r.lifted).toBe(true);
        expect(r.dropped).toBe(true);
        expect(state.segments).toEqual([[pt(0, 0), pt(0, 1)]]);
        expect(state.segmentIds).toEqual(['keep']);
        expect(r.hasStarted).toBe(false);
    });

    it('is a no-op when the pen is already up', () => {
        const state = { segments: [[pt(0, 0), pt(0, 1)]], segmentIds: ['a'], activeIndex: -1, hasStarted: false };
        const r = applyPenLift(state);
        expect(r.lifted).toBe(false);
        expect(state.segments).toHaveLength(1);
    });

    it('lets Undo after a lift pop the last point of the last segment', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1), pt(0, 2)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true
        };
        const lifted = applyPenLift(state);
        const undo = applyRoadUndo({ ...state, activeIndex: lifted.activeIndex, hasStarted: lifted.hasStarted });
        expect(undo.undone).toBe(true);
        expect(undo.removedEdges).toEqual([[pt(0, 1), pt(0, 2)]]);
        expect(state.segments).toEqual([[pt(0, 0), pt(0, 1)]]);
        expect(state.segmentIds).toEqual(['a']);
    });
});

describe('the index-alignment invariant survives any push/undo/lift sequence', () => {
    // Deterministic pseudo-random (Date.now/Math.random are unavailable in the harness anyway).
    function makeRng(seed) {
        let s = seed >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
    }

    it('never lets segments.length diverge from segmentIds.length', () => {
        for (let seed = 1; seed <= 25; seed++) {
            const rng = makeRng(seed);
            const state = { segments: [], segmentIds: [], activeIndex: -1, hasStarted: false };
            let nextId = 0;

            for (let step = 0; step < 60; step++) {
                const roll = rng();
                if (roll < 0.5) {
                    // push a point: start a new segment or extend the active one
                    if (!state.hasStarted) {
                        state.segments.push([pt(rng(), rng())]);
                        state.segmentIds.push('id-' + (nextId++));
                        state.activeIndex = state.segments.length - 1;
                        state.hasStarted = true;
                    } else {
                        state.segments[state.activeIndex].push(pt(rng(), rng()));
                    }
                } else if (roll < 0.78) {
                    const r = applyRoadUndo(state);
                    state.activeIndex = r.activeIndex;
                    state.hasStarted = r.hasStarted;
                } else {
                    const r = applyPenLift(state);
                    state.activeIndex = r.activeIndex;
                    state.hasStarted = r.hasStarted;
                }

                // THE invariant, checked after every operation.
                expect(state.segments.length).toBe(state.segmentIds.length);
                // activeIndex, when set, points at a real segment.
                if (state.activeIndex >= 0) {
                    expect(state.activeIndex).toBeLessThan(state.segments.length);
                }
            }
        }
    });
});

// A click on the stroke's own last vertex added a zero-length edge; a stroke made only of one has no
// direction, so no cross-section ("[road-drawing] no strips for a drawn segment").
describe('isRepeatedStrokeVertex', () => {
    const { isRepeatedStrokeVertex, MIN_STROKE_EDGE_M } = require('../../frontend/js/road-stroke-state.js');

    it('treats the same point (a double-click, a snap back onto it) as no new edge', () => {
        const a = pt(45.79184481788899, 15.917049050331117);
        expect(isRepeatedStrokeVertex(a, { ...a })).toBe(true);
        expect(isRepeatedStrokeVertex(a, pt(a.lat + 1e-8, a.lng))).toBe(true); // ~1 mm
        expect(MIN_STROKE_EDGE_M).toBe(0.01);
    });

    it('lets any real edge through, and does not guess on missing input', () => {
        const a = pt(45.79184481788899, 15.917049050331117);
        expect(isRepeatedStrokeVertex(a, pt(a.lat + 1e-6, a.lng))).toBe(false); // ~11 cm
        expect(isRepeatedStrokeVertex(a, pt(a.lat, a.lng + 2e-7))).toBe(false); // ~1.6 cm at 45.8°
        expect(isRepeatedStrokeVertex(null, a)).toBe(false);
        expect(isRepeatedStrokeVertex(a, { lat: null, lng: a.lng })).toBe(false);
    });
});

// A double-click finishes the road; its second click must add nothing, even a pixel away from the
// first (a jittery hand), which isRepeatedStrokeVertex's 1 cm would let through as a tiny edge.
describe('isDoubleClickFollowUp', () => {
    const { isDoubleClickFollowUp, DOUBLE_TAP_MS } = require('../../frontend/js/road-stroke-state.js');

    it('takes the browser click count for a mouse or a pen', () => {
        expect(isDoubleClickFollowUp({ detail: 2, pointerType: 'mouse' }, 0, 50)).toBe(true);
        expect(isDoubleClickFollowUp({ detail: 3, pointerType: 'pen' }, 0, 50)).toBe(true);
        // A first click, however soon after an earlier one, is a click.
        expect(isDoubleClickFollowUp({ detail: 1, pointerType: 'mouse' }, 0, 50)).toBe(false);
    });

    it('counts two touch taps within the double-tap window, as Leaflet simulates the dblclick', () => {
        expect(DOUBLE_TAP_MS).toBe(200);
        expect(isDoubleClickFollowUp({ detail: 1, pointerType: 'touch' }, 1000, 1150)).toBe(true);
        expect(isDoubleClickFollowUp({ detail: 1, pointerType: 'touch' }, 1000, 1300)).toBe(false);
        expect(isDoubleClickFollowUp({ detail: 1, pointerType: 'touch' }, -Infinity, 1000)).toBe(false);
        // A source that says it fires no touch events is a mouse, whatever the pointer type says.
        expect(isDoubleClickFollowUp({ detail: 1, sourceCapabilities: { firesTouchEvents: false } }, 1000, 1100)).toBe(false);
    });

    it('treats no event, or a keyboard click (detail 0), as an ordinary click', () => {
        expect(isDoubleClickFollowUp(null, 0, 10)).toBe(false);
        expect(isDoubleClickFollowUp({ detail: 0, pointerType: 'touch' }, 0, 10)).toBe(false);
    });
});

describe('obstacles recorded per edge, decided once at Finish', () => {
    const stroke = require('../../frontend/js/road-stroke-state.js');
    const turf = require('@turf/turf');
    const tunnel = require('../../frontend/js/corridor-tunnel.js');
    const grade = require('../../frontend/js/corridor-grade-separation.js');
    const keyOf = tunnel.corridorTunnelEdgeKey;

    // An east–west edge of ~155 m near Zagreb, and a 40 × 11 m building across its middle.
    const A = pt(45.8, 15.97);
    const B = pt(45.8, 15.972);
    const building = {
        id: 'b1',
        feature: turf.polygon([[[15.9705, 45.79995], [15.971, 45.79995], [15.971, 45.80005], [15.9705, 45.80005], [15.9705, 45.79995]]])
    };
    const entry = (from, to, extra = {}) => ({
        key: keyOf(from, to), from: { ...from }, to: { ...to },
        buildings: [], plots: { plots: [], blocked: [] }, structures: [], crossings: [], markers: [],
        ...extra
    });
    const deps = (overrides = {}) => ({
        edgeKeyOf: keyOf,
        widthOf: () => 7.5,
        clipEdgeThroughBuildings: (from, to, hits, width) => tunnel.clipCorridorEdgeThroughBuildings(from, to, hits, width, turf),
        makeTunnelRecord: tunnel.makeBuildingTunnelRecord,
        buildGradeSeparationRecords: grade.buildGradeSeparationRecords,
        refreshGradeSeparationEdgeKeys: grade.refreshGradeSeparationEdgeKeys,
        ...overrides
    });
    const liveKeys = segment => segment.slice(1).map((point, index) => keyOf(segment[index], point));

    it('keeps only the conflicts of edges the drawing still has', () => {
        const C = pt(45.801, 15.972);
        const conflicts = new Map([
            [keyOf(A, B), entry(A, B, { buildings: [building] })],
            [keyOf(B, C), entry(B, C, { buildings: [{ id: 'b2' }] })]
        ]);
        // Undo took the edge B→C.
        const kept = stroke.retainLiveEdgeConflicts([[A, B]], conflicts, keyOf);
        expect([...kept.keys()]).toEqual([keyOf(A, B)]);
        // A reversed segment still has the edge: keys have no direction.
        expect(stroke.retainLiveEdgeConflicts([[B, A]], conflicts, keyOf).size).toBe(1);
    });

    it('merges the whole drawing into one list per kind, each obstacle once', () => {
        const C = pt(45.801, 15.972);
        const crossing = { proposalId: 'r1', point: pt(45.8, 15.971), t: 0.5, title: 'Main', width: 10 };
        const conflicts = new Map([
            [keyOf(A, B), entry(A, B, {
                buildings: [building],
                plots: { plots: [{ proposalId: 'sub', title: 'Sub', kind: 'subdivision', count: 2, areaM2: 100 }], blocked: [] },
                structures: [{ id: 'park-1', kind: 'park' }],
                crossings: [crossing]
            })],
            [keyOf(B, C), entry(B, C, {
                buildings: [building, { id: 'b2' }],
                plots: { plots: [{ proposalId: 'sub', title: 'Sub', kind: 'subdivision', count: 1, areaM2: 40 }], blocked: [] },
                structures: [{ id: 'park-1', kind: 'park' }, { id: 'lake-1', kind: 'lake' }],
                crossings: [{ ...crossing }]
            })]
        ]);
        const merged = stroke.mergeEdgeConflicts(conflicts);
        expect(merged.buildings.map(hit => hit.id)).toEqual(['b1', 'b2']);
        expect(merged.structures.map(hit => hit.id)).toEqual(['park-1', 'lake-1']);
        expect(merged.crossings).toHaveLength(1);
        expect(merged.plots.plots).toEqual([{ proposalId: 'sub', title: 'Sub', kind: 'subdivision', count: 3, areaM2: 140 }]);
        expect(stroke.summarizeEdgeConflicts(conflicts)).toEqual({
            buildings: 2, plots: 1, parks: 1, squares: 0, lakes: 1, crossings: 1, total: 6
        });
        expect(stroke.edgeConflictCount(entry(A, B))).toBe(0);
    });

    it('a tunnel answer inserts the facade portals into the edge and records the inside span', () => {
        const segments = [[{ ...A }, { ...B }]];
        const conflicts = new Map([[keyOf(A, B), entry(A, B, { buildings: [building] })]]);
        const result = stroke.applyRoadConflictAnswers(
            { segments, segmentIds: ['s1'], conflicts },
            { buildings: 'tunnel', crossings: null },
            deps()
        );
        const segment = segments[0];
        expect(result.insertedPoints).toBe(2);
        expect(segment).toHaveLength(4);
        expect(segment[0]).toEqual(A);
        expect(segment[3]).toEqual(B);
        // The portals sit at the building's facades widened by half the road (3.75 m each side).
        expect(segment[1].lng).toBeGreaterThan(15.9704);
        expect(segment[1].lng).toBeLessThan(15.9705);
        expect(segment[2].lng).toBeGreaterThan(15.971);
        expect(segment[2].lng).toBeLessThan(15.9711);
        expect(result.tunnels).toHaveLength(1);
        expect(result.tunnels[0]).toMatchObject({ kind: 'building', segmentId: 's1', buildingIds: ['b1'] });
        // The record names a live edge: the inside one, between the portals.
        expect(result.tunnels[0].edgeKey).toBe(keyOf(segment[1], segment[2]));
        expect(liveKeys(segment)).toContain(result.tunnels[0].edgeKey);
    });

    it('a cancelled review (no answers) leaves the segments untouched', () => {
        const segments = [[{ ...A }, { ...B }]];
        const before = JSON.parse(JSON.stringify(segments));
        const conflicts = new Map([[keyOf(A, B), entry(A, B, { buildings: [building] })]]);
        const result = stroke.applyRoadConflictAnswers({ segments, segmentIds: ['s1'], conflicts }, null, deps());
        expect(segments).toEqual(before);
        expect(result).toEqual({ tunnels: [], gradeSeparations: [], surfaceBuildingIds: [], insertedPoints: 0 });
    });

    it('a surface answer inserts nothing and names the buildings kept on top', () => {
        const segments = [[{ ...A }, { ...B }]];
        const conflicts = new Map([[keyOf(A, B), entry(A, B, { buildings: [building] })]]);
        const result = stroke.applyRoadConflictAnswers(
            { segments, segmentIds: ['s1'], conflicts },
            { buildings: 'surface', crossings: null },
            deps()
        );
        expect(segments[0]).toHaveLength(2);
        expect(result.surfaceBuildingIds).toEqual(['b1']);
        expect(result.tunnels).toEqual([]);
    });

    it('an underpass inserts the ramp ends around the crossing and keys the record to live edges', () => {
        const segments = [[{ ...A }, { ...B }]];
        const crossingPoint = pt(45.8, 15.971);
        const hit = { proposalId: 'r1', point: crossingPoint, t: 0.5, title: 'Main', width: 10 };
        const conflicts = new Map([[keyOf(A, B), entry(A, B, { crossings: [hit] })]]);
        const footprint = { type: 'Polygon', coordinates: [] };
        const result = stroke.applyRoadConflictAnswers(
            { segments, segmentIds: ['s1'], conflicts },
            { buildings: null, crossings: 'underpass' },
            deps({ gradeSeparationFootprint: () => footprint })
        );
        const segment = segments[0];
        expect(result.insertedPoints).toBe(2);
        expect(result.gradeSeparations).toHaveLength(1);
        const record = result.gradeSeparations[0];
        expect(record).toMatchObject({ mode: 'underpass', segmentId: 's1', footprint });
        expect(segment[1]).toEqual(record.from);
        expect(segment[2]).toEqual(record.to);
        expect(record.from.lng).toBeLessThan(crossingPoint.lng);
        expect(record.to.lng).toBeGreaterThan(crossingPoint.lng);
        expect(record.edgeKeys).toEqual([keyOf(record.from, record.to)]);
        expect(liveKeys(segment)).toContain(record.edgeKeys[0]);
    });

    it('turns a crossing to the live direction of an edge reversed since it was drawn', () => {
        // Drawn A→B with the crossing a quarter of the way from A; the segment was later resumed
        // from its first vertex, which reverses it in place to B→A.
        const crossingPoint = pt(45.8, 15.9705);
        const hit = { proposalId: 'r1', point: crossingPoint, t: 0.25, title: 'Main', width: 10 };
        const segments = [[{ ...B }, { ...A }]];
        const conflicts = new Map([[keyOf(A, B), entry(A, B, { crossings: [hit] })]]);
        const result = stroke.applyRoadConflictAnswers(
            { segments, segmentIds: ['s1'], conflicts },
            { buildings: null, crossings: 'overpass' },
            deps()
        );
        const record = result.gradeSeparations[0];
        // The ramps straddle the real crossing, not the point a quarter of the way from B.
        const lngs = [record.from.lng, record.to.lng].sort();
        expect(lngs[0]).toBeLessThan(crossingPoint.lng);
        expect(lngs[1]).toBeGreaterThan(crossingPoint.lng);
        expect(record.edgeKeys).toHaveLength(1);
        expect(liveKeys(segments[0])).toContain(record.edgeKeys[0]);
    });

    it('skips a conflict whose edge is gone', () => {
        const C = pt(45.801, 15.972);
        const segments = [[{ ...A }, { ...B }]];
        const conflicts = new Map([[keyOf(B, C), entry(B, C, { buildings: [building] })]]);
        const result = stroke.applyRoadConflictAnswers(
            { segments, segmentIds: ['s1'], conflicts },
            { buildings: 'tunnel', crossings: null },
            deps()
        );
        expect(segments[0]).toHaveLength(2);
        expect(result.tunnels).toEqual([]);
    });
});
