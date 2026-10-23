// Validate model bounds without a browser, canvas, or graphics context.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { dimensionsFromBounds, projectedFootprint, MAX_FOOTPRINT_TRIANGLES } = require('../../frontend/js/building-model-geometry.js');
const turf = require('../../frontend/vendor/turf-6.5.0/turf.min.js');

const soup = triangles => new Float64Array(triangles.flat(2));
const union = (a, b) => turf.union(a, b);
const planarRingArea = ring => Math.abs(ring.slice(0, -1).reduce((sum, point, index) => {
    const next = ring[index + 1];
    return sum + point[0] * next[1] - next[0] * point[1];
}, 0)) / 2;
const planarPolygonArea = feature => feature.geometry.coordinates.reduce((area, ring, index) =>
    area + (index === 0 ? 1 : -1) * planarRingArea(ring), 0);

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

describe('projected model footprint', () => {
    it('unions triangles into an L-shaped concave Polygon', () => {
        const triangles = soup([
            [[0,0],[4,0],[4,2]], [[0,0],[4,2],[0,2]],
            [[0,2],[2,2],[2,4]], [[0,2],[2,4],[0,4]]
        ]);
        const result = projectedFootprint(triangles, union);
        expect(result.geometry.type).toBe('Polygon');
        expect(result.geometry.coordinates).toHaveLength(1);
        expect(result.geometry.coordinates[0].length).toBeGreaterThan(5);
        expect(planarPolygonArea(result)).toBeCloseTo(12, 5);
    });

    it('preserves a courtyard as an interior ring', () => {
        const triangles = soup([
            [[0,0],[4,0],[4,1]], [[0,0],[4,1],[0,1]],
            [[0,3],[4,3],[4,4]], [[0,3],[4,4],[0,4]],
            [[0,1],[1,1],[1,3]], [[0,1],[1,3],[0,3]],
            [[3,1],[4,1],[4,3]], [[3,1],[4,3],[3,3]]
        ]);
        const result = projectedFootprint(triangles, union);
        expect(result.geometry.type).toBe('Polygon');
        expect(result.geometry.coordinates).toHaveLength(2);
        expect(planarPolygonArea(result)).toBeCloseTo(12, 5);
    });

    it('deduplicates triangle order and winding and ignores zero-area triangles', () => {
        const triangles = soup([
            [[0,0],[2,0],[0,2]], [[0,2],[2,0],[0,0]],
            [[0,0],[1,1],[2,2]]
        ]);
        const calls = [];
        const result = projectedFootprint(triangles, (a, b) => { calls.push([a, b]); return union(a, b); });
        expect(calls).toHaveLength(0);
        expect(result.geometry.type).toBe('Polygon');
        expect(planarPolygonArea(result)).toBeCloseTo(2, 5);
    });

    it('rejects empty, invalid and disconnected output with explicit error codes', () => {
        expect(() => projectedFootprint(new Float64Array(), union)).toThrow(expect.objectContaining({ code: 'empty' }));
        expect(() => projectedFootprint(soup([[[0,0],[1,0],[NaN,1]]]), union))
            .toThrow(expect.objectContaining({ code: 'empty' }));
        expect(() => projectedFootprint(soup([
            [[0,0],[1,0],[0,1]], [[4,0],[5,0],[4,1]]
        ]), union)).toThrow(expect.objectContaining({ code: 'disconnected' }));
    });

    it('labels a thrown Turf union as an outline failure', () => {
        expect(() => projectedFootprint(soup([
            [[0,0],[1,0],[0,1]], [[1,0],[1,1],[0,1]]
        ]), () => { throw new Error('union failed'); }))
            .toThrow(expect.objectContaining({ code: 'outline' }));
    });

    it('has an explicit triangle-work budget', () => {
        expect(MAX_FOOTPRINT_TRIANGLES).toBe(250000);
        const tooMany = new Float64Array((MAX_FOOTPRINT_TRIANGLES + 1) * 6);
        expect(() => projectedFootprint(tooMany, union)).toThrow(expect.objectContaining({ code: 'complex' }));
    });
});
