// The haze over ground the Permitted layers have not loaded: which cells are hazed, and that the
// painted image is clear exactly over loaded cells.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const extent = require('../../frontend/js/planning/loaded-extent.js');
const size = 0.0025;
// Cells 30800..30803 east, 17500..17502 north: a 4 x 3 range.
const range = [77.0, 43.75, 77.01, 43.7575];
const key = (x, y) => `${30800 + x},${17500 + y}`;
const alphaAt = (image, grid, x, y, px = 6) => {
    // The middle pixel of cell (x, y) counted from the range's south-west cell; the grid has one ring around it.
    const col = (x + 1) * px + px / 2, row = image.height - (y + 1) * px - px / 2;
    return image.data[(Math.floor(row) * image.width + Math.floor(col)) * 4 + 3];
};

describe('loaded extent of the Permitted layers', () => {
    it('names a cell by the indices of its box', () => {
        expect(extent.cellKey([77.0, 43.75, 77.0025, 43.7525], size)).toBe(key(0, 0));
        expect(extent.cellKey([77.0075, 43.755, 77.01, 43.7575], size)).toBe(key(3, 2));
    });
    it('has no edge to show when nothing is loaded or everything in range is', () => {
        expect(extent.mask({ range, size, loaded: [] })).toBeNull();
        const all = [];
        for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) all.push(key(x, y));
        expect(extent.mask({ range, size, loaded: all })).toBeNull();
        // A cell loaded outside the range does not open it.
        expect(extent.mask({ range, size, loaded: [key(40, 40)] })).toBeNull();
    });
    it('marks loaded, unloaded and failed cells inside a ring that is never loaded', () => {
        const grid = extent.mask({ range, size, loaded: [key(0, 0), key(1, 0), key(-1, 0)], failed: [key(3, 2), key(0, 0)] });
        expect([grid.cols, grid.rows, grid.x0, grid.y0]).toEqual([6, 5, 30799, 17499]);
        expect(grid.bounds).toEqual([76.9975, 43.7475, 77.0125, 43.76]);
        const cell = (x, y) => grid.cells[(y + 1) * grid.cols + x + 1];
        expect([cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 2)]).toEqual([extent.LOADED, extent.LOADED, extent.UNLOADED, extent.FAILED]);
        // The ring cell west of the range stays unloaded though a loaded cell is named there.
        expect(cell(-1, 0)).toBe(extent.UNLOADED);
    });
    it('keeps the middle of a range wider than the grid may be', () => {
        const wide = [77.0, 43.75, 77.0 + size * 300, 43.7525];
        const grid = extent.mask({ range: wide, size, loaded: [key(150, 0)] });
        expect(grid.cols).toBe(extent.MAX_SIDE);
        expect(grid.cells[1 * grid.cols + (30950 - grid.x0)]).toBe(extent.LOADED);
    });
    it('paints a loaded cell clear and the ground beside it hazed, the same picture every time', () => {
        const grid = extent.mask({ range, size, loaded: [key(0, 0), key(1, 0)], failed: [key(3, 2)] });
        const image = extent.paint(grid, { color: [200, 210, 220], opacity: 0.4 });
        expect([image.width, image.height]).toEqual([36, 30]);
        // Every pixel of a loaded cell is clear, to its edge.
        for (let px = 6; px < 18; px++) for (let py = image.height - 12; py < image.height - 6; py++) {
            expect(image.data[(py * image.width + px) * 4 + 3]).toBe(0);
        }
        expect(alphaAt(image, grid, 0, 0)).toBe(0);
        expect(alphaAt(image, grid, 3, 0)).toBeGreaterThan(40);
        expect(alphaAt(image, grid, 0, 2)).toBeLessThanOrEqual(Math.round(0.4 * 255));
        // A failed cell carries hatch lines stronger than any haze.
        let strongest = 0;
        for (let px = 24; px < 30; px++) for (let py = 6; py < 12; py++) strongest = Math.max(strongest, image.data[(py * image.width + px) * 4 + 3]);
        expect(strongest).toBe(Math.round(0.8 * 255));
        expect(Array.from(extent.paint(grid, { color: [200, 210, 220], opacity: 0.4 }).data)).toEqual(Array.from(image.data));
        // The cloud pattern belongs to the world: the same cell looks the same in a grid that starts elsewhere.
        const shifted = extent.mask({ range: [77.0025, 43.75, 77.0125, 43.7575], size, loaded: [key(1, 0)] });
        const again = extent.paint(shifted, { color: [200, 210, 220], opacity: 0.4 });
        expect(alphaAt(again, shifted, 2, 1)).toBe(alphaAt(image, grid, 3, 1));
    });
    it('changes its signature exactly when a cell changes', () => {
        const a = extent.mask({ range, size, loaded: [key(0, 0)] }), b = extent.mask({ range, size, loaded: [key(0, 0)] });
        const c = extent.mask({ range, size, loaded: [key(0, 0), key(1, 1)] });
        expect(extent.signature(a)).toBe(extent.signature(b));
        expect(extent.signature(a)).not.toBe(extent.signature(c));
        expect(extent.signature(null)).toBe('');
    });
});
