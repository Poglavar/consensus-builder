// Locks the rules that let the lane topology manager load evidence on map movement instead of on a
// button press: refuse spans the backend rejects, reuse a covering load, pad so small pans are free.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyViewport = require('../../frontend/js/lane-topology-viewport.js');

const { MAX_SPAN_DEG, planViewportLoad, padBbox, bboxContains, bboxSpan } = LaneTopologyViewport;

// ~1.1 km across, a typical working viewport in the manager.
const VIEWPORT = [15.95, 45.79, 15.96, 45.8];

describe('planViewportLoad', () => {
    it('loads on first sight of a viewport and asks for a padded bbox around it', () => {
        const plan = planViewportLoad({ viewport: VIEWPORT, loaded: null });
        expect(plan.action).toBe('load');
        expect(plan.reason).toBe('first');
        expect(bboxContains(plan.bbox, VIEWPORT)).toBe(true);
        expect(plan.bbox).not.toEqual(VIEWPORT);
    });

    it('refuses a viewport wider than the backend bbox limit instead of requesting a 400', () => {
        const plan = planViewportLoad({
            viewport: [15.9, 45.79, 15.9 + MAX_SPAN_DEG + 0.001, 45.8],
            loaded: null
        });
        expect(plan.action).toBe('skip');
        expect(plan.reason).toBe('too-large');
        expect(plan.bbox).toBeNull();
    });

    it('refuses a viewport taller than the backend bbox limit', () => {
        const plan = planViewportLoad({
            viewport: [15.95, 45.7, 15.96, 45.7 + MAX_SPAN_DEG + 0.001],
            loaded: null
        });
        expect(plan.action).toBe('skip');
        expect(plan.reason).toBe('too-large');
    });

    // Exactly at the limit is decided by float noise (15.9 + 0.08 is 15.980000000000002), and the
    // backend makes the same comparison on the same rounded numbers, so the two always agree.
    // What matters is that a viewport just under the limit still loads, and unpadded.
    it('accepts a viewport a hair under the limit and keeps the padded span legal', () => {
        const span = MAX_SPAN_DEG - 0.000001;
        const viewport = [15.9, 45.75, Number((15.9 + span).toFixed(7)), Number((45.75 + span).toFixed(7))];
        const plan = planViewportLoad({ viewport, loaded: null });
        expect(plan.action).toBe('load');
        expect(bboxContains(plan.bbox, viewport)).toBe(true);
        bboxSpan(plan.bbox).forEach(padded => expect(padded).toBeLessThanOrEqual(MAX_SPAN_DEG + 1e-9));
    });

    it('skips a zoom-in, because the loaded evidence already covers it', () => {
        const loaded = padBbox(VIEWPORT);
        const plan = planViewportLoad({ viewport: [15.953, 45.793, 15.957, 45.797], loaded });
        expect(plan.action).toBe('skip');
        expect(plan.reason).toBe('covered');
        expect(plan.bbox).toEqual(loaded);
    });

    it('skips a pan smaller than the padding', () => {
        const loaded = padBbox(VIEWPORT);
        const plan = planViewportLoad({ viewport: [15.951, 45.791, 15.961, 45.801], loaded });
        expect(plan.action).toBe('skip');
        expect(plan.reason).toBe('covered');
    });

    it('reloads once a pan leaves the padded area', () => {
        const loaded = padBbox(VIEWPORT);
        const viewport = [15.952, 45.792, 15.962, 45.802];
        expect(bboxContains(loaded, viewport)).toBe(false);
        const plan = planViewportLoad({ viewport, loaded });
        expect(plan.action).toBe('load');
        expect(plan.reason).toBe('moved');
        expect(bboxContains(plan.bbox, viewport)).toBe(true);
    });

    it('reloads a covered viewport when the reload button forces it', () => {
        const loaded = padBbox(VIEWPORT);
        const plan = planViewportLoad({ viewport: VIEWPORT, loaded, force: true });
        expect(plan.action).toBe('load');
    });

    it('never pads past the backend limit', () => {
        const nearMax = MAX_SPAN_DEG - 0.002;
        const viewport = [15.9, 45.75, 15.9 + nearMax, 45.75 + nearMax];
        const plan = planViewportLoad({ viewport, loaded: null });
        expect(plan.action).toBe('load');
        bboxSpan(plan.bbox).forEach(span => {
            expect(span).toBeLessThanOrEqual(MAX_SPAN_DEG + 1e-9);
            expect(span).toBeGreaterThan(nearMax);
        });
        expect(bboxContains(plan.bbox, viewport)).toBe(true);
    });

    it('skips a degenerate or missing viewport', () => {
        expect(planViewportLoad({ viewport: null }).reason).toBe('invalid');
        expect(planViewportLoad({ viewport: [15.96, 45.8, 15.95, 45.79] }).reason).toBe('invalid');
        expect(planViewportLoad({ viewport: [15.95, 45.79, Number.NaN, 45.8] }).reason).toBe('invalid');
    });
});

describe('padBbox', () => {
    it('grows a bbox symmetrically by a quarter of its own size', () => {
        expect(padBbox([15.95, 45.79, 15.96, 45.8])).toEqual([15.94875, 45.78875, 15.96125, 45.80125]);
    });

    it('clamps to the world edges', () => {
        const padded = padBbox([-179.99, -89.99, -179.98, -89.98]);
        expect(padded[0]).toBeGreaterThanOrEqual(-180);
        expect(padded[1]).toBeGreaterThanOrEqual(-90);
    });
});
