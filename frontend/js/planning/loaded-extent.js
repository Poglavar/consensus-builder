// Where the Permitted layers have loaded and where they have not: the layer's cells over the area
// in view as a grid, and the haze image painted from it. The map lays the image over the ground
// and the model view puts it on a ground plane, so both show the same edge of the loaded data.
// Pure: no DOM, no canvas; views.js turns the returned pixels into an image.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningLoadedExtent = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const LOADED = 0, UNLOADED = 1, FAILED = 2;
    // The grid never grows past this many cells a side; a wider range keeps its middle.
    const MAX_SIDE = 96;
    const index = (value, size) => Math.round(value / size);
    // The cell indices of a cell's box, as "x,y".
    function cellKey(bbox, size) { return `${index(bbox[0], size)},${index(bbox[1], size)}`; }
    // The grid over `range` ([west, south, east, north]) plus one ring of cells around it, which is
    // never loaded: beyond the range nothing is, so a renderer may repeat the image's edge outwards.
    // `loaded` and `failed` are cell keys. Null when there is no edge to show: nothing is loaded
    // (the layer draws nothing), or every cell in the range is.
    function mask({ range, size, loaded, failed = [] }) {
        if (!Array.isArray(range) || !range.every(Number.isFinite) || !(size > 0)) throw new TypeError('A mask needs a finite range and a positive cell size.');
        const held = new Set(loaded), broken = new Set(failed);
        if (!held.size) return null;
        let x0 = Math.floor(range[0] / size + 1e-9), y0 = Math.floor(range[1] / size + 1e-9);
        let x1 = Math.max(x0, Math.ceil(range[2] / size - 1e-9) - 1), y1 = Math.max(y0, Math.ceil(range[3] / size - 1e-9) - 1);
        const trim = (low, high) => {
            const over = high - low + 1 - (MAX_SIDE - 2);
            return over > 0 ? [low + Math.floor(over / 2), high - Math.ceil(over / 2)] : [low, high];
        };
        [x0, x1] = trim(x0, x1); [y0, y1] = trim(y0, y1);
        x0--; y0--; x1++; y1++;
        const cols = x1 - x0 + 1, rows = y1 - y0 + 1, cells = new Uint8Array(cols * rows).fill(UNLOADED);
        let open = 0, closed = 0;
        for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
            const key = `${x0 + x},${y0 + y}`;
            if (held.has(key)) { cells[y * cols + x] = LOADED; open++; }
            else { closed++; if (broken.has(key)) cells[y * cols + x] = FAILED; }
        }
        if (!open || !closed) return null;
        return { bounds: [x0 * size, y0 * size, (x1 + 1) * size, (y1 + 1) * size].map(value => Number(value.toFixed(7))),
            x0, y0, cols, rows, cells };
    }
    // Value noise on the cell lattice of the world, so the haze keeps its pattern as the grid moves.
    function lattice(x, y) {
        let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
        h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13;
        return (h >>> 0) / 4294967295;
    }
    const ease = t => t * t * (3 - 2 * t);
    function noise(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y), fx = ease(x - xi), fy = ease(y - yi);
        const top = lattice(xi, yi) + (lattice(xi + 1, yi) - lattice(xi, yi)) * fx;
        const bottom = lattice(xi, yi + 1) + (lattice(xi + 1, yi + 1) - lattice(xi, yi + 1)) * fx;
        return top + (bottom - top) * fy;
    }
    const cloud = (x, y) => (noise(x * 1.7, y * 1.7) * 0.6 + noise(x * 4.3 + 11, y * 4.3 + 7) * 0.4);
    // How far into unloaded ground the haze takes to reach full strength, in cells.
    const FEATHER = 0.75;
    // The haze as straight-alpha RGBA pixels, north at the top, `pxPerCell` pixels to a cell. A loaded
    // cell is clear to its edge; the haze rises with the distance from the nearest loaded cell and is
    // uneven like cloud. A cell that failed to load is hatched as well: it was asked for and is
    // missing, where the rest was never asked for.
    function paint(grid, { color = [255, 255, 255], opacity = 0.4, pxPerCell = 6 } = {}) {
        const { cols, rows, cells, x0, y0 } = grid, width = cols * pxPerCell, height = rows * pxPerCell;
        const data = new Uint8ClampedArray(width * height * 4);
        const at = (x, y) => cells[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
        // 0 on a loaded cell, 1 once FEATHER cells from the nearest one (only neighbours can be nearer).
        const cover = (cx, cy) => {
            const xi = Math.round(cx), yi = Math.round(cy);
            if (at(xi, yi) === LOADED) return 0;
            let nearest = FEATHER;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (at(xi + dx, yi + dy) !== LOADED) continue;
                nearest = Math.min(nearest, Math.hypot(Math.max(0, Math.abs(cx - xi - dx) - 0.5), Math.max(0, Math.abs(cy - yi - dy) - 0.5)));
            }
            return nearest / FEATHER;
        };
        for (let py = 0; py < height; py++) {
            // Cell-centre coordinates: 0 is the middle of the grid's first cell; rows run south to north.
            const cy = (height - py - 0.5) / pxPerCell - 0.5;
            for (let px = 0; px < width; px++) {
                const cx = (px + 0.5) / pxPerCell - 0.5, covered = cover(cx, cy);
                if (!covered) continue;
                const hatch = at(Math.round(cx), Math.round(cy)) === FAILED && (px + py) % pxPerCell < 1.5;
                const alpha = hatch ? Math.min(1, opacity * 2) : opacity * ease(covered) * (0.55 + 0.45 * cloud(x0 + cx, y0 + cy));
                const offset = (py * width + px) * 4, shade = hatch ? 0.55 : 1;
                data[offset] = color[0] * shade; data[offset + 1] = color[1] * shade; data[offset + 2] = color[2] * shade;
                data[offset + 3] = Math.round(alpha * 255);
            }
        }
        return { width, height, data };
    }
    // What the map and the model draw: the cells known to both, and one string that changes exactly when the picture does.
    const signature = grid => grid ? `${grid.x0},${grid.y0},${grid.cols}:${Array.from(grid.cells).join('')}` : '';
    return { LOADED, UNLOADED, FAILED, MAX_SIDE, cellKey, mask, paint, signature };
});
