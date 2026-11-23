// The Permitted cells that failed to load after their retry: which cells are marked, and that the
// painted hatch covers exactly those cells.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const failedCells = require('../../frontend/js/planning/failed-cells.js');
const size = 0.0025;
const key = (x, y) => `${30800 + x},${17500 + y}`;
// The alpha values of cell (x, y) of a grid, counted from the grid's south-west cell.
const cellAlphas = (image, x, y, px = 32) => {
    const values = [];
    for (let row = image.height - (y + 1) * px; row < image.height - y * px; row++) {
        for (let col = x * px; col < (x + 1) * px; col++) values.push(image.data[(row * image.width + col) * 4 + 3]);
    }
    return values;
};

describe('failed Permitted cells', () => {
    it('names a cell by the indices of its box', () => {
        expect(failedCells.cellKey([77.0, 43.75, 77.0025, 43.7525], size)).toBe(key(0, 0));
        expect(failedCells.cellKey([77.0075, 43.755, 77.01, 43.7575], size)).toBe(key(3, 2));
    });
    it('marks nothing when no cell failed', () => {
        expect(failedCells.grid([], size)).toBeNull();
        expect(failedCells.signature(null)).toBe('');
    });
    it('spans just the failed cells and marks only them', () => {
        const grid = failedCells.grid([key(0, 0), key(2, 1), key(2, 1)], size);
        expect([grid.cols, grid.rows, grid.x0, grid.y0]).toEqual([3, 2, 30800, 17500]);
        expect(grid.bounds).toEqual([77.0, 43.75, 77.0075, 43.755]);
        expect(Array.from(grid.cells)).toEqual([1, 0, 0, 0, 0, 1]);
    });
    it('keeps the middle of a spread wider than the grid may be', () => {
        const grid = failedCells.grid([key(0, 0), key(100, 0), key(50, 0)], size);
        expect(grid.cols).toBe(failedCells.MAX_SIDE);
        expect(grid.cells[30850 - grid.x0]).toBe(1);
    });
    it('hatches a failed cell and leaves every other cell clear, the same picture every time', () => {
        const grid = failedCells.grid([key(0, 0), key(1, 1)], size);
        const style = { color: [10, 20, 30], opacity: 0.8, pxPerCell: 32, period: 8, line: 2 };
        const image = failedCells.paint(grid, style);
        expect([image.width, image.height]).toEqual([64, 64]);
        const hatched = cellAlphas(image, 0, 0);
        expect(Math.max(...hatched)).toBe(Math.round(0.8 * 255));
        expect(hatched.filter(Boolean).length / hatched.length).toBeCloseTo(2 / 8, 1);
        expect(Math.max(...cellAlphas(image, 1, 1))).toBe(Math.round(0.8 * 255));
        expect(Math.max(...cellAlphas(image, 1, 0))).toBe(0);
        expect(Math.max(...cellAlphas(image, 0, 1))).toBe(0);
        expect(Array.from(failedCells.paint(grid, style).data)).toEqual(Array.from(image.data));
    });
    it('changes its signature exactly when a cell changes', () => {
        const a = failedCells.grid([key(0, 0)], size), b = failedCells.grid([key(0, 0)], size);
        const c = failedCells.grid([key(0, 0), key(1, 1)], size);
        expect(failedCells.signature(a)).toBe(failedCells.signature(b));
        expect(failedCells.signature(a)).not.toBe(failedCells.signature(c));
    });
});
