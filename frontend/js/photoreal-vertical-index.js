// Straight-down height queries against a triangle mesh. Photo mode samples the Google surface only
// with vertical rays, thousands per rebuild; three's Raycaster tests every triangle of every tile
// for each one. This bins the triangles of one mesh, in world coordinates, on an XY grid once, so a
// query tests only the few triangles of its cell. Pure: no DOM, no THREE.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__photorealVerticalIndex = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // positions: flat world xyz (Float32Array or array); index: triangle vertex indices or null
    // for a non-indexed mesh. About `trianglesPerCell` triangles share a cell on average.
    function buildVerticalIndex(positions, index, options) {
        options = options || {};
        const trianglesPerCell = options.trianglesPerCell > 0 ? options.trianglesPerCell : 4;
        const maxCellsPerAxis = options.maxCellsPerAxis > 0 ? options.maxCellsPerAxis : 256;
        const triangleCount = Math.floor((index ? index.length : positions.length / 3) / 3);
        const vertex = index
            ? function (t, k) { return index[t * 3 + k]; }
            : function (t, k) { return t * 3 + k; };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (!triangleCount || !(maxX >= minX) || !(maxY >= minY)) return null;
        const width = Math.max(maxX - minX, 1e-6), height = Math.max(maxY - minY, 1e-6);
        const cells = Math.max(1, triangleCount / trianglesPerCell);
        const nx = Math.max(1, Math.min(maxCellsPerAxis, Math.round(Math.sqrt(cells * width / height))));
        const ny = Math.max(1, Math.min(maxCellsPerAxis, Math.round(cells / nx)));
        const sx = nx / width, sy = ny / height;
        const cellOf = function (value, min, scale, n) {
            const c = Math.floor((value - min) * scale);
            return c < 0 ? 0 : (c >= n ? n - 1 : c);
        };
        // Two passes: count the cells each triangle's XY box covers, then fill (compressed rows).
        const starts = new Int32Array(nx * ny + 1);
        const ranges = new Int32Array(triangleCount * 4);
        for (let t = 0; t < triangleCount; t++) {
            const a = vertex(t, 0) * 3, b = vertex(t, 1) * 3, c = vertex(t, 2) * 3;
            const x0 = Math.min(positions[a], positions[b], positions[c]);
            const x1 = Math.max(positions[a], positions[b], positions[c]);
            const y0 = Math.min(positions[a + 1], positions[b + 1], positions[c + 1]);
            const y1 = Math.max(positions[a + 1], positions[b + 1], positions[c + 1]);
            const cx0 = cellOf(x0, minX, sx, nx), cx1 = cellOf(x1, minX, sx, nx);
            const cy0 = cellOf(y0, minY, sy, ny), cy1 = cellOf(y1, minY, sy, ny);
            ranges[t * 4] = cx0; ranges[t * 4 + 1] = cx1; ranges[t * 4 + 2] = cy0; ranges[t * 4 + 3] = cy1;
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) starts[cy * nx + cx + 1] += 1;
        }
        for (let i = 1; i < starts.length; i++) starts[i] += starts[i - 1];
        const fill = starts.slice(0, nx * ny);
        const triangles = new Int32Array(starts[nx * ny]);
        for (let t = 0; t < triangleCount; t++) {
            for (let cy = ranges[t * 4 + 2]; cy <= ranges[t * 4 + 3]; cy++) {
                for (let cx = ranges[t * 4]; cx <= ranges[t * 4 + 1]; cx++) triangles[fill[cy * nx + cx]++] = t;
            }
        }
        return { positions, index, minX, minY, maxX, maxY, nx, ny, sx, sy, starts, triangles };
    }

    // Push the z of every triangle above or below (x, y) onto `out`; edges count as inside, so a
    // point on a shared edge is never lost between two triangles.
    function verticalHeightsAt(grid, x, y, out) {
        out = out || [];
        if (!grid || x < grid.minX || x > grid.maxX || y < grid.minY || y > grid.maxY) return out;
        const cx = Math.min(grid.nx - 1, Math.floor((x - grid.minX) * grid.sx));
        const cy = Math.min(grid.ny - 1, Math.floor((y - grid.minY) * grid.sy));
        const cell = cy * grid.nx + cx;
        const p = grid.positions, index = grid.index;
        for (let k = grid.starts[cell]; k < grid.starts[cell + 1]; k++) {
            const t = grid.triangles[k];
            const a = (index ? index[t * 3] : t * 3) * 3;
            const b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3;
            const c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
            const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], qx = p[c], qy = p[c + 1];
            const det = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
            if (Math.abs(det) < 1e-12) continue; // seen edge-on from above
            const u = ((by - qy) * (x - qx) + (qx - bx) * (y - qy)) / det;
            const v = ((qy - ay) * (x - qx) + (ax - qx) * (y - qy)) / det;
            const w = 1 - u - v;
            const eps = -1e-9;
            if (u < eps || v < eps || w < eps) continue;
            out.push(u * p[a + 2] + v * p[b + 2] + w * p[c + 2]);
        }
        return out;
    }

    return { buildVerticalIndex, verticalHeightsAt };
});
