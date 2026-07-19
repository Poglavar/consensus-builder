// Unit tests for extracting a smooth bare-ground grid from Google photogrammetry surface hits.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    selectTopSurfaceHeight,
    cleanGroundGrid,
    sampleBilinear,
    coversBounds
} = require('../../frontend/js/photoreal-ground.js');

function slopedGrid(nx, ny) {
    return Float32Array.from({ length: nx * ny }, (_, index) => {
        const x = index % nx;
        const y = Math.floor(index / nx);
        return -2 + x * 0.35 + y * 0.15;
    });
}

describe('photoreal ground extraction', () => {
    it('keeps the top ray hit instead of the rejected lowest mesh hit', () => {
        expect(selectTopSurfaceHeight([18, 17.7, 0.2, -14], 1500)).toBe(18);
        expect(selectTopSurfaceHeight([2400, 3.5, -20], 1500)).toBe(3.5);
        expect(selectTopSurfaceHeight([2400, -1800], 1500)).toBeNull();
    });

    it('preserves an uncontaminated sloped terrain plane', () => {
        const nx = 9, ny = 9;
        const terrain = slopedGrid(nx, ny);
        expect(Array.from(cleanGroundGrid(terrain, nx, ny))).toEqual(Array.from(terrain));

        const tinyPlane = Float32Array.from([0, 0.5, 0.25, 0.75]);
        expect(Array.from(cleanGroundGrid(tinyPlane, 2, 2))).toEqual(Array.from(tinyPlane));
    });

    it('removes roof and canopy elevations while retaining the underlying slope', () => {
        const nx = 9, ny = 9;
        const terrain = slopedGrid(nx, ny);
        const surface = new Float32Array(terrain);
        for (let y = 3; y <= 5; y++) {
            for (let x = 3; x <= 5; x++) surface[y * nx + x] += 12;
        }
        surface[2 * nx + 7] += 8;

        const cleaned = cleanGroundGrid(surface, nx, ny);
        const roofCenter = 4 * nx + 4;
        expect(surface[roofCenter] - terrain[roofCenter]).toBeGreaterThan(10);
        expect(cleaned[roofCenter]).toBeCloseTo(terrain[roofCenter], 0);
        expect(Math.abs(cleaned[2 * nx + 7] - terrain[2 * nx + 7])).toBeLessThan(0.5);
    });

    it('fills a compact NoData hole but leaves an entirely missing region missing', () => {
        const nx = 7, ny = 7;
        const terrain = slopedGrid(nx, ny);
        terrain[3 * nx + 3] = NaN;
        const cleaned = cleanGroundGrid(terrain, nx, ny);
        expect(cleaned[3 * nx + 3]).toBeCloseTo(-0.5, 5);

        const missing = new Float32Array(nx * ny);
        missing.fill(NaN);
        expect(Array.from(cleanGroundGrid(missing, nx, ny)).every(Number.isNaN)).toBe(true);
    });
});

describe('photoreal ground-grid sampling', () => {
    it('renormalises bilinear weights around NoData instead of equally averaging valid corners', () => {
        const grid = {
            minX: 0,
            minY: 0,
            dx: 1,
            dy: 1,
            nx: 2,
            ny: 2,
            z: Float32Array.from([0, 10, 20, NaN])
        };
        expect(sampleBilinear(grid, 0.75, 0.25)).toBeCloseTo(8.461538, 6);
        expect(sampleBilinear(grid, -0.01, 0.25)).toBeNull();
    });

    it('detects when an edited proposal outgrows the cached terrain extent', () => {
        const grid = { minX: -10, minY: -20, dx: 5, dy: 10, nx: 5, ny: 5, z: new Float32Array(25) };
        expect(coversBounds(grid, { minX: -10, minY: -20, maxX: 10, maxY: 20 })).toBe(true);
        expect(coversBounds(grid, { minX: -10, minY: -20, maxX: 10.1, maxY: 20 })).toBe(false);
    });
});
