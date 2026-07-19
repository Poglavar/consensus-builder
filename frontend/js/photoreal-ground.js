// Builds a bare-ground estimate from the noisy top-surface grid sampled from Google 3D Tiles.
// Pure grid math keeps canopy removal and NoData interpolation testable without Three.js or a browser.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__photorealGround = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_OPENING_RADIUS_CELLS = 2;
    const DEFAULT_OBSTACLE_MIN_HEIGHT_M = 1.5;
    const DEFAULT_GAP_FILL_PASSES = 2;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function median(values) {
        if (!values.length) return NaN;
        const sorted = values.slice().sort(function (a, b) { return a - b; });
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    // Three's down-ray hits arrive top-to-bottom. Keep the first plausible surface and let the
    // spatial grid remove roofs/canopy; choosing the last/lowest hit admits mesh undersides and
    // overlapping coarse tiles, which was the rejected min-hit experiment.
    function selectTopSurfaceHeight(heights, maxAbsHeight) {
        const limit = Number.isFinite(Number(maxAbsHeight)) ? Math.abs(Number(maxAbsHeight)) : Infinity;
        for (let i = 0; i < (heights || []).length; i++) {
            const value = heights[i];
            if (finite(value) && Math.abs(value) <= limit) return value;
        }
        return null;
    }

    function finiteNeighbourValues(values, nx, ny, x, y, radiusX, radiusY) {
        const out = [];
        const ry = Number.isFinite(radiusY) ? radiusY : radiusX;
        const minX = Math.max(0, x - radiusX), maxX = Math.min(nx - 1, x + radiusX);
        const minY = Math.max(0, y - ry), maxY = Math.min(ny - 1, y + ry);
        for (let yy = minY; yy <= maxY; yy++) {
            for (let xx = minX; xx <= maxX; xx++) {
                const value = values[yy * nx + xx];
                if (finite(value)) out.push(value);
            }
        }
        return out;
    }

    function copyFiniteGrid(values, size) {
        const out = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            const value = values && values[i];
            out[i] = finite(value) ? value : NaN;
        }
        return out;
    }

    // Fill only compact sampling holes. Repeating a 3x3 median twice bridges at most a two-cell
    // gap; a genuinely unstreamed region stays NoData instead of inventing a large flat plateau.
    function fillSmallGaps(values, nx, ny, passes) {
        let current = copyFiniteGrid(values, nx * ny);
        const count = Math.max(0, Math.floor(Number(passes)) || 0);
        for (let pass = 0; pass < count; pass++) {
            const next = new Float32Array(current);
            let changed = false;
            for (let y = 0; y < ny; y++) {
                for (let x = 0; x < nx; x++) {
                    const index = y * nx + x;
                    if (finite(current[index])) continue;
                    const neighbours = finiteNeighbourValues(current, nx, ny, x, y, 1);
                    if (neighbours.length < 3) continue;
                    next[index] = median(neighbours);
                    changed = true;
                }
            }
            current = next;
            if (!changed) break;
        }
        return current;
    }

    function rankFilter(values, nx, ny, radiusX, radiusY, chooseLower) {
        const out = new Float32Array(nx * ny);
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                const neighbours = finiteNeighbourValues(values, nx, ny, x, y, radiusX, radiusY);
                if (!neighbours.length) {
                    out[y * nx + x] = NaN;
                    continue;
                }
                out[y * nx + x] = chooseLower
                    ? Math.min.apply(null, neighbours)
                    : Math.max.apply(null, neighbours);
            }
        }
        return out;
    }

    function medianFilterInterior(values, nx, ny) {
        const out = new Float32Array(values);
        for (let y = 1; y < ny - 1; y++) {
            for (let x = 1; x < nx - 1; x++) {
                const neighbours = finiteNeighbourValues(values, nx, ny, x, y, 1);
                if (neighbours.length >= 5) out[y * nx + x] = median(neighbours);
            }
        }
        return out;
    }

    // Google photogrammetry is a digital-surface model: a down-ray sees roofs and canopy first.
    // A grayscale morphological opening removes positive features smaller than the neighbourhood
    // while preserving an ordinary sloped plane. We only adopt the opened value where the raw
    // surface stands materially above it, then use a 3x3 median to suppress residual mesh noise.
    function cleanGroundGrid(values, nx, ny, options) {
        const width = Math.max(0, Math.floor(Number(nx)) || 0);
        const height = Math.max(0, Math.floor(Number(ny)) || 0);
        if (!width || !height) return new Float32Array(0);
        const opts = options || {};
        const requestedOpeningRadius = Number.isFinite(Number(opts.openingRadiusCells))
            ? Math.max(0, Math.floor(Number(opts.openingRadiusCells)))
            : DEFAULT_OPENING_RADIUS_CELLS;
        const obstacleMinHeight = Number.isFinite(Number(opts.obstacleMinHeightM))
            ? Math.max(0, Number(opts.obstacleMinHeightM))
            : DEFAULT_OBSTACLE_MIN_HEIGHT_M;
        const gapFillPasses = Number.isFinite(Number(opts.gapFillPasses))
            ? Math.max(0, Math.floor(Number(opts.gapFillPasses)))
            : DEFAULT_GAP_FILL_PASSES;

        const filled = fillSmallGaps(values, width, height, gapFillPasses);
        const openingRadiusX = Math.min(requestedOpeningRadius, Math.floor((width - 1) / 2));
        const openingRadiusY = Math.min(requestedOpeningRadius, Math.floor((height - 1) / 2));
        if (!openingRadiusX && !openingRadiusY) return medianFilterInterior(filled, width, height);
        const eroded = rankFilter(filled, width, height, openingRadiusX, openingRadiusY, true);
        const opened = rankFilter(eroded, width, height, openingRadiusX, openingRadiusY, false);
        const deobstructed = new Float32Array(filled);
        for (let i = 0; i < deobstructed.length; i++) {
            const surfaceZ = filled[i], openedZ = opened[i];
            if (finite(surfaceZ) && finite(openedZ) && surfaceZ - openedZ >= obstacleMinHeight) {
                deobstructed[i] = openedZ;
            }
        }
        return medianFilterInterior(deobstructed, width, height);
    }

    // Bilinear interpolation with NoData-aware weight renormalisation. A missing corner does not
    // receive the same weight as a nearby valid corner, and an all-missing neighbourhood is null.
    function sampleBilinear(grid, x, y) {
        if (!grid || !grid.z || grid.nx < 1 || grid.ny < 1 || !(grid.dx > 0) || !(grid.dy > 0)) return null;
        const fx = (x - grid.minX) / grid.dx, fy = (y - grid.minY) / grid.dy;
        if (fx < 0 || fy < 0 || fx > grid.nx - 1 || fy > grid.ny - 1) return null;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, grid.nx - 1), y1 = Math.min(y0 + 1, grid.ny - 1);
        const tx = fx - x0, ty = fy - y0;
        const samples = [
            [grid.z[y0 * grid.nx + x0], (1 - tx) * (1 - ty)],
            [grid.z[y0 * grid.nx + x1], tx * (1 - ty)],
            [grid.z[y1 * grid.nx + x0], (1 - tx) * ty],
            [grid.z[y1 * grid.nx + x1], tx * ty]
        ];
        let weighted = 0, totalWeight = 0;
        samples.forEach(function (sample) {
            const value = sample[0], weight = sample[1];
            if (!finite(value) || !(weight > 0)) return;
            weighted += value * weight;
            totalWeight += weight;
        });
        return totalWeight > 0 ? weighted / totalWeight : null;
    }

    function coversBounds(grid, bounds, epsilon) {
        if (!grid || !bounds || !(grid.dx > 0) || !(grid.dy > 0)) return false;
        const tolerance = Number.isFinite(Number(epsilon)) ? Math.max(0, Number(epsilon)) : 1e-6;
        const maxX = grid.minX + grid.dx * (grid.nx - 1);
        const maxY = grid.minY + grid.dy * (grid.ny - 1);
        return bounds.minX >= grid.minX - tolerance
            && bounds.minY >= grid.minY - tolerance
            && bounds.maxX <= maxX + tolerance
            && bounds.maxY <= maxY + tolerance;
    }

    return {
        selectTopSurfaceHeight: selectTopSurfaceHeight,
        cleanGroundGrid: cleanGroundGrid,
        sampleBilinear: sampleBilinear,
        coversBounds: coversBounds
    };
});
