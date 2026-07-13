// Unit tests for the elevated-rail resampler (the viaduct geometry itself needs THREE).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resampleXY } = require('../../frontend/js/elevated-rail-3d.js');

describe('resampleXY', () => {
    it('samples a straight line every spacing and keeps both endpoints', () => {
        const samples = resampleXY([[0, 0], [100, 0]], 30);
        expect(samples[0]).toEqual({ x: 0, y: 0 });
        expect(samples[samples.length - 1]).toEqual({ x: 100, y: 0 });
        expect(samples.map(s => Math.round(s.x))).toEqual([0, 30, 60, 90, 100]);
    });

    it('carries arc length across vertices of a bent polyline', () => {
        const samples = resampleXY([[0, 0], [20, 0], [20, 40]], 30);
        // 60 m total: samples at 0, 30 (10 m up the second leg) and the endpoint.
        expect(samples).toHaveLength(3);
        expect(samples[1].x).toBeCloseTo(20, 6);
        expect(samples[1].y).toBeCloseTo(10, 6);
        expect(samples[2]).toEqual({ x: 20, y: 40 });
    });

    it('returns nothing for degenerate input', () => {
        expect(resampleXY([[5, 5]], 30)).toEqual([]);
        expect(resampleXY([], 30)).toEqual([]);
    });
});
