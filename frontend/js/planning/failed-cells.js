// The Permitted cells that could not be loaded, even after their retry: a grid over just those cells
// and the hatch image painted from it. The map lays the image over the ground and the model view puts
// it on a ground plane, so both mark the same cells. Ground that is loading or loaded is not marked.
// Pure: no DOM, no canvas; views.js turns the returned pixels into an image.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningFailedCells = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    // The grid never grows past this many cells a side; a wider spread keeps its middle.
    const MAX_SIDE = 64;
    const index = (value, size) => Math.round(value / size);
    // The cell indices of a cell's box, as "x,y".
    function cellKey(bbox, size) { return `${index(bbox[0], size)},${index(bbox[1], size)}`; }
    // The grid over the failed cells' extent, `failed` being cell keys. Null when none failed.
    function grid(failed, size) {
        if (!(size > 0)) throw new TypeError('A failed-cell grid needs a positive cell size.');
        const cells = [...new Set(failed)].map(key => key.split(',').map(Number)).filter(cell => cell.length === 2 && cell.every(Number.isInteger));
        if (!cells.length) return null;
        const span = axis => {
            const values = cells.map(cell => cell[axis]).sort((a, b) => a - b);
            let low = values[0], high = values[values.length - 1];
            const over = high - low + 1 - MAX_SIDE;
            if (over > 0) { low += Math.floor(over / 2); high -= Math.ceil(over / 2); }
            return [low, high];
        };
        const [x0, x1] = span(0), [y0, y1] = span(1), cols = x1 - x0 + 1, rows = y1 - y0 + 1;
        const marked = new Uint8Array(cols * rows);
        for (const [x, y] of cells) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) marked[(y - y0) * cols + x - x0] = 1;
        return { bounds: [x0 * size, y0 * size, (x1 + 1) * size, (y1 + 1) * size].map(value => Number(value.toFixed(7))),
            x0, y0, cols, rows, cells: marked };
    }
    // The hatch as straight-alpha RGBA pixels, north at the top, `pxPerCell` pixels to a cell:
    // diagonal lines `period` pixels apart over a failed cell, clear everywhere else.
    function paint(hatchGrid, { color = [76, 81, 89], opacity = 0.8, pxPerCell = 64, period = 12, line = 2 } = {}) {
        const { cols, rows, cells } = hatchGrid, width = cols * pxPerCell, height = rows * pxPerCell;
        const data = new Uint8ClampedArray(width * height * 4), alpha = Math.round(opacity * 255);
        for (let py = 0; py < height; py++) {
            const row = rows - 1 - Math.floor(py / pxPerCell);
            for (let px = 0; px < width; px++) {
                if (!cells[row * cols + Math.floor(px / pxPerCell)] || (px + py) % period >= line) continue;
                const offset = (py * width + px) * 4;
                data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = alpha;
            }
        }
        return { width, height, data };
    }
    // One string that changes exactly when the marked cells do.
    const signature = hatchGrid => hatchGrid ? `${hatchGrid.x0},${hatchGrid.y0},${hatchGrid.cols}:${Array.from(hatchGrid.cells).join('')}` : '';
    return { MAX_SIDE, cellKey, grid, paint, signature };
});
