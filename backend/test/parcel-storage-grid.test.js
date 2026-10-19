// Purpose: lock viewport-to-grid coverage so parcel fetches request only required rectangular cells.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const storageSource = readFileSync(new URL('../../frontend/js/parcels/storage.js', import.meta.url), 'utf8');

function createGrid(transform, { size = 1, datasetBounds } = {}) {
    const window = {
        ParcelsState: { getParcelGridSize: () => size },
        CityConfigManager: datasetBounds ? { getCurrentCityConfig: () => ({ projection: { datasetBounds } }) } : null,
        wgs84ToDataset: transform
    };
    runInNewContext(storageSource, { window, globalThis: window });
    const getCells = (south, west, north, east, extraRadius = 0) => Array.from(window.getRequiredGridCells({
        getSouthWest: () => ({ lat: south, lng: west }),
        getNorthEast: () => ({ lat: north, lng: east })
    }, extraRadius)).sort();
    getCells.window = window;
    return getCells;
}

describe('parcel viewport grid coverage', () => {
    it('fetches a rectangular viewport rather than filling a square around the center', () => {
        const grid = createGrid((lat, lng) => [lng, lat]);

        const wide = grid(0.1, 0.1, 0.9, 4.9);
        expect(wide).toHaveLength(5 * 1);
        expect(wide).toContain('4,0');
        expect(wide).not.toContain('2,1');

        const tall = grid(0.1, 0.1, 4.9, 0.9);
        expect(tall).toHaveLength(1 * 5);
        expect(tall).toContain('0,4');
        expect(tall).not.toContain('1,2');
    });

    it('uses floor-based cells for negative coordinates', () => {
        const grid = createGrid((lat, lng) => [lng, lat]);
        expect(grid(-1.8, -2.8, -0.2, -1.2)).toEqual([
            '-2,-1', '-2,-2', '-3,-1', '-3,-2'
        ]);
    });

    it('does not fetch the neighboring cell when an upper edge is exactly on a grid line', () => {
        const grid = createGrid((lat, lng) => [lng, lat]);
        expect(grid(0, 0, 2, 3)).toEqual([
            '0,0', '0,1',
            '1,0', '1,1',
            '2,0', '2,1'
        ]);
    });

    it('snaps floating-point noise at lower and upper grid boundaries', () => {
        const grid = createGrid((lat, lng) => [lng + 1e-12, lat + 1e-12]);
        expect(grid(0, 0, 1, 1)).toEqual(['0,0']);
    });

    it('applies extraRadius as a symmetric buffer around the rectangular edge range', () => {
        const grid = createGrid((lat, lng) => [lng, lat]);
        const cells = grid(0.1, 0.1, 0.9, 2.9, 1);
        expect(cells).toHaveLength(5 * 3);
        expect(cells).toContain('-1,-1');
        expect(cells).toContain('3,1');
        expect(cells).not.toContain('0,3');
    });

    it('bounds all projected corners and sampled edges for rotated projections', () => {
        // In this rotated affine CRS, the off-diagonal corners extend the northing range
        // beyond the values at SW and NE.
        const grid = createGrid((lat, lng) => [lng + lat, lng - lat]);
        const cells = grid(0, 0, 3, 1);
        expect(cells).toContain('3,-3');
        expect(cells).toContain('0,0');
        expect(cells.length).toBeGreaterThan(4);
    });

    it('samples curved projected edges to avoid missing their extent', () => {
        const grid = createGrid((lat, lng) => [lng, lat + 4 * lng * (1 - lng)]);
        // The top edge has northing 1 at both corners but reaches 2 between them.
        expect(grid(0, 0, 1, 1)).toContain('0,1');
    });

    it('returns no keys for missing or non-finite projected coordinates', () => {
        const grid = createGrid((lat, lng) => (lat > 0.5 ? [Infinity, lng] : [lng, lat]));
        expect(grid(0, 0, 1, 1)).toEqual([]);
        expect(grid(0, 0, Number.NaN, 1)).toEqual([]);
        expect(Array.from(grid.window.getRequiredGridCells({
            getSouthWest: () => ({ lat: null, lng: 0 }),
            getNorthEast: () => ({ lat: 1, lng: 1 })
        }))).toEqual([]);
        const missingProjection = createGrid(() => [null, 0]);
        expect(missingProjection(0, 0, 1, 1)).toEqual([]);
        expect(Array.from(grid.window.getRequiredGridCells({ getSouthWest: () => ({ lat: 0, lng: 0 }) }))).toEqual([]);
    });

    it('preserves the whole-outside dataset bounds shortcut without clipping intersecting coverage', () => {
        const grid = createGrid((lat, lng) => [lng, lat], {
            datasetBounds: { minX: 0, maxX: 2, minY: 0, maxY: 2 }
        });
        expect(grid(3.1, 3.1, 4.9, 4.9)).toEqual([]);
        expect(grid(1, 1, 3, 3)).toEqual([
            '1,1', '1,2', '2,1', '2,2'
        ]);
    });
});
