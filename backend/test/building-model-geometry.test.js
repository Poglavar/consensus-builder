// Validate model bounds without a browser, canvas, or graphics context.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { dimensionsFromBounds } = require('../../frontend/js/building-model-geometry.js');

describe('imported building dimensions', () => {
    it('uses X/Z for the footprint and Y for height, regardless of model origin', () => {
        expect(dimensionsFromBounds({ min: { x: -8, y: 50, z: -10 }, max: { x: 8, y: 62, z: 10 } }))
            .toEqual({ width: 16, length: 20, height: 12 });
    });

    it('preserves the placement minimum of one metre and rounds to tenths', () => {
        expect(dimensionsFromBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 0.3, y: 12.34, z: 20.26 } }))
            .toEqual({ width: 1, length: 20.3, height: 12.3 });
    });

    it.each([NaN, Infinity, -Infinity])('rejects nonfinite coordinates (%s)', value => {
        expect(dimensionsFromBounds({ min: { x: value, y: 0, z: 0 }, max: { x: 8, y: 12, z: 10 } })).toBeNull();
    });

    it('rejects empty bounds and overflowing dimensions', () => {
        expect(dimensionsFromBounds({ min: { x: 9, y: 0, z: 0 }, max: { x: 8, y: 12, z: 10 } })).toBeNull();
        expect(dimensionsFromBounds({ min: { x: -1e308, y: 0, z: 0 }, max: { x: 1e308, y: 12, z: 10 } })).toBeNull();
    });
});
