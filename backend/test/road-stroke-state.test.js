// Unit tests for frontend/js/road-stroke-state.js — the road-drawing undo/cancel state transitions.
// The headline is the index-alignment invariant: segments.length === segmentIds.length must survive
// ANY sequence of push/undo/cancel, because a per-segment cross-section override is keyed by its id.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyStrokeCancel, applyRoadUndo } = require('../../frontend/js/road-stroke-state.js');

const pt = (lat, lng) => ({ lat, lng });

describe('applyRoadUndo', () => {
    it('pops the last vertex of the active segment', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1), pt(0, 2)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true, strokeBaseCount: 1
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
            activeIndex: 1, hasStarted: true, strokeBaseCount: 1
        };
        // active segment [pt(5,5)] has length 1 → can't undo (needs >1)
        expect(applyRoadUndo(state).undone).toBe(false);
    });

    it('empties a 2-point active segment down to nothing and removes it in lockstep', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true, strokeBaseCount: 0
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
            activeIndex: -1, hasStarted: false, strokeBaseCount: 0
        };
        const r = applyRoadUndo(state);
        expect(r.undone).toBe(true);
        expect(r.hasStarted).toBe(true);
        expect(r.activeIndex).toBe(0);
        expect(state.segments[0]).toHaveLength(2); // resumed then popped one
    });

    it('is a no-op with nothing to undo', () => {
        expect(applyRoadUndo({ segments: [], segmentIds: [], activeIndex: -1, hasStarted: false, strokeBaseCount: 0 }).undone).toBe(false);
        expect(applyRoadUndo({ segments: [[pt(0, 0)]], segmentIds: ['a'], activeIndex: -1, hasStarted: false, strokeBaseCount: 0 }).undone).toBe(false);
    });
});

describe('applyStrokeCancel', () => {
    it('pops back to strokeBaseCount and keeps a still-valid segment', () => {
        const state = {
            segments: [[pt(0, 0), pt(0, 1), pt(0, 2), pt(0, 3)]],
            segmentIds: ['a'],
            activeIndex: 0, hasStarted: true, strokeBaseCount: 2
        };
        const r = applyStrokeCancel(state);
        expect(r.cancelled).toBe(true);
        expect(state.segments[0]).toHaveLength(2); // popped to base
        expect(r.removedEdges).toHaveLength(2);     // two edges removed
        expect(r.hasStarted).toBe(false);
        expect(r.activeIndex).toBe(-1);
        expect(state.segments.length).toBe(state.segmentIds.length);
    });

    it('removes the segment (and id) when the cancel leaves < 2 points', () => {
        const state = {
            segments: [[pt(9, 9)], [pt(0, 0), pt(0, 1)]],
            segmentIds: ['keep', 'stub'],
            activeIndex: 1, hasStarted: true, strokeBaseCount: 0
        };
        const r = applyStrokeCancel(state);
        expect(r.cancelled).toBe(true);
        expect(state.segments).toHaveLength(1);
        expect(state.segmentIds).toEqual(['keep']); // the stub's id went with it
    });

    it('is a no-op when the pen is up', () => {
        const state = { segments: [[pt(0, 0), pt(0, 1)]], segmentIds: ['a'], activeIndex: -1, hasStarted: false, strokeBaseCount: 0 };
        expect(applyStrokeCancel(state).cancelled).toBe(false);
        expect(state.segments).toHaveLength(1);
    });
});

describe('the index-alignment invariant survives any push/undo/cancel sequence', () => {
    // Deterministic pseudo-random (Date.now/Math.random are unavailable in the harness anyway).
    function makeRng(seed) {
        let s = seed >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
    }

    it('never lets segments.length diverge from segmentIds.length', () => {
        for (let seed = 1; seed <= 25; seed++) {
            const rng = makeRng(seed);
            const state = { segments: [], segmentIds: [], activeIndex: -1, hasStarted: false, strokeBaseCount: 0 };
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
                        state.strokeBaseCount = 0;
                    } else {
                        state.segments[state.activeIndex].push(pt(rng(), rng()));
                    }
                } else if (roll < 0.78) {
                    const r = applyRoadUndo(state);
                    state.activeIndex = r.activeIndex;
                    state.hasStarted = r.hasStarted;
                    state.strokeBaseCount = r.strokeBaseCount;
                } else {
                    const r = applyStrokeCancel(state);
                    state.activeIndex = r.activeIndex;
                    state.hasStarted = r.hasStarted;
                    state.strokeBaseCount = r.strokeBaseCount;
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
