// Rasterization helpers: stamp polygon fills and line corridors onto the
// grid's typed arrays. Coordinates are EPSG:3765 (meters), matching lib/grid.
export function stampPolygon(grid, ring, apply) {
    // Scanline fill over cell centers for one polygon ring (no holes —
    // prototype-grade; OSM holes in landuse/water are rare enough here).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const c0 = Math.max(0, grid.colOf(minX)), c1 = Math.min(grid.cols - 1, grid.colOf(maxX));
    const r0 = Math.max(0, grid.rowOf(minY)), r1 = Math.min(grid.rows - 1, grid.rowOf(maxY));
    for (let row = r0; row <= r1; row++) {
        const py = grid.ymin + (row + 0.5) * grid.cell;
        // Collect x-crossings of the ring with this scanline.
        const xs = [];
        for (let k = 0; k < ring.length - 1; k++) {
            const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
            if ((y1 <= py && y2 > py) || (y2 <= py && y1 > py)) {
                xs.push(x1 + (py - y1) / (y2 - y1) * (x2 - x1));
            }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const ca = Math.max(c0, grid.colOf(xs[k])), cb = Math.min(c1, grid.colOf(xs[k + 1]));
            for (let col = ca; col <= cb; col++) apply(grid.idx(col, row));
        }
    }
}

export function stampLine(grid, coords, radius, apply) {
    // Mark every cell whose center is within `radius` of the polyline.
    const rCells = Math.ceil(radius / grid.cell) + 1;
    const seen = new Set();
    for (let k = 0; k < coords.length - 1; k++) {
        const [x1, y1] = coords[k], [x2, y2] = coords[k + 1];
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(segLen / grid.cell));
        for (let s = 0; s <= steps; s++) {
            const px = x1 + (x2 - x1) * s / steps, py = y1 + (y2 - y1) * s / steps;
            const col = grid.colOf(px), row = grid.rowOf(py);
            for (let dr = -rCells; dr <= rCells; dr++) {
                for (let dc = -rCells; dc <= rCells; dc++) {
                    const c = col + dc, r = row + dr;
                    if (!grid.inBounds(c, r)) continue;
                    const idx = grid.idx(c, r);
                    if (seen.has(idx)) continue;
                    const [cx, cy] = grid.centerOf(idx);
                    if (distToSegment(cx, cy, x1, y1, x2, y2) <= radius) {
                        seen.add(idx);
                        apply(idx);
                    }
                }
            }
        }
    }
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
