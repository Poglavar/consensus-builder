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

    // A proposed road normally has a useful visible Google surface under its centreline. When that
    // ray lands on a car, canopy or roof, two agreeing samples beyond the corridor edges can safely
    // pull it down. Higher side hits never lift a valid centreline onto adjacent buildings, and
    // disagreeing sides are not averaged into fictional terrain.
    function selectRoadSurfaceHeight(center, left, right, options) {
        const opts = options || {};
        const sideAgreementM = finite(Number(opts.sideAgreementM))
            ? Math.max(0, Number(opts.sideAgreementM)) : 1.5;
        const centerHighThresholdM = finite(Number(opts.centerHighThresholdM))
            ? Math.max(0, Number(opts.centerHighThresholdM)) : 1.5;
        const hasCenter = finite(center);
        const hasLeft = finite(left);
        const hasRight = finite(right);

        let selected = null;
        if (hasCenter) {
            if (hasLeft && hasRight && Math.abs(left - right) <= sideAgreementM
                && center - Math.max(left, right) >= centerHighThresholdM) {
                selected = (left + right) / 2;
            } else {
                selected = center;
            }
        } else if (hasLeft && hasRight) {
            selected = Math.abs(left - right) <= sideAgreementM ? (left + right) / 2 : null;
        } else if (hasLeft) {
            selected = left;
        } else if (hasRight) {
            selected = right;
        }

        // When all three probes lie on one plausible transverse plane, lift the level formation to
        // the predicted high semantic edge. A unilateral roof/tree fails the centre≈side-mean test
        // and leaves the established centre/obstacle selector unchanged.
        const halfWidth = finite(Number(opts.halfWidth)) ? Math.max(0, Number(opts.halfWidth)) : 0;
        const probeDistance = finite(Number(opts.probeDistance))
            ? Math.max(0, Number(opts.probeDistance)) : 0;
        const planeToleranceM = finite(Number(opts.planeToleranceM))
            ? Math.max(0, Number(opts.planeToleranceM)) : 0.35;
        const maximumCrossSlope = finite(Number(opts.maximumCrossSlope))
            ? Math.max(0, Number(opts.maximumCrossSlope)) : 0.18;
        let expectedLeftEdge = selected;
        let expectedRightEdge = selected;
        if (finite(selected) && hasCenter && hasLeft && hasRight
            && halfWidth > 0 && probeDistance > halfWidth) {
            const sideMean = (left + right) / 2;
            const crossSlope = (left - right) / (2 * probeDistance);
            if (Math.abs(center - sideMean) <= planeToleranceM
                && Math.abs(crossSlope) <= maximumCrossSlope) {
                expectedLeftEdge = center + crossSlope * halfWidth;
                expectedRightEdge = center - crossSlope * halfWidth;
                selected = Math.max(selected, expectedLeftEdge, expectedRightEdge);
            }
        }
        // Direct semantic-edge probes capture the sub-metre Google triangulation that can otherwise
        // poke through a flat sidewalk. Accept only hits close to the plausible cross-section plane;
        // parked cars, trunks and facades remain outliers and do not lift the whole road.
        const edgeToleranceM = finite(Number(opts.edgeToleranceM))
            ? Math.max(0, Number(opts.edgeToleranceM)) : 0.45;
        [
            [opts.edgeLeft == null ? null : Number(opts.edgeLeft), expectedLeftEdge],
            [opts.edgeRight == null ? null : Number(opts.edgeRight), expectedRightEdge]
        ].forEach(function (pair) {
            const edge = pair[0];
            const expected = pair[1];
            if (finite(edge) && finite(expected) && Math.abs(edge - expected) <= edgeToleranceM) {
                selected = Math.max(selected, edge);
            }
        });
        return selected;
    }

    // The road mask is an RGBA8 texture. Its alpha channel carries the local formation height,
    // normalised over an adaptive range so ordinary city roads quantise to centimetres rather than
    // metres. Zero remains in-range for legacy/fallback flat roads.
    function roadFloorEncodingRange(values, options) {
        const opts = options || {};
        const paddingM = finite(Number(opts.paddingM)) ? Math.max(0, Number(opts.paddingM)) : 4;
        const minimumRangeM = finite(Number(opts.minimumRangeM))
            ? Math.max(1e-9, Number(opts.minimumRangeM)) : 8;
        const heights = [0];
        (values || []).forEach(function (value) { if (finite(value)) heights.push(value); });
        const low = Math.min.apply(null, heights);
        const high = Math.max.apply(null, heights);
        const min = low - paddingM;
        const range = Math.max(minimumRangeM, high - low + paddingM * 2);
        return { min: min, range: range, max: min + range, quantizationM: range / 255 };
    }

    function encodeRoadFloor(height, encoding) {
        if (!finite(height) || !encoding || !finite(encoding.min) || !(encoding.range > 0)) return 0;
        return Math.max(0, Math.min(1, (height - encoding.min) / encoding.range));
    }

    function decodeRoadFloor(encoded, encoding) {
        if (!finite(encoded) || !encoding || !finite(encoding.min) || !(encoding.range > 0)) return null;
        return encoding.min + Math.max(0, Math.min(1, encoded)) * encoding.range;
    }

    // Alpha is stored in an RGBA8 render target, so a decoded road height can round upward by half
    // a quantisation step. Keep the worst-case retained Google fragment below the opaque foundation
    // by a fixed safety margin; unusually large elevation ranges become more conservative rather
    // than silently letting source triangles poke through the replacement surface.
    function quantizationSafeRoadCutOffset(encoding, options) {
        const opts = options || {};
        const targetOffsetM = finite(Number(opts.targetOffsetM)) ? Number(opts.targetOffsetM) : 0.02;
        const coverTopOffsetM = finite(Number(opts.coverTopOffsetM))
            ? Number(opts.coverTopOffsetM) : 0.04;
        const safetyMarginM = finite(Number(opts.safetyMarginM))
            ? Math.max(0, Number(opts.safetyMarginM)) : 0.01;
        const quantizationM = encoding && finite(Number(encoding.quantizationM))
            ? Math.max(0, Number(encoding.quantizationM)) : Infinity;
        if (!finite(quantizationM)) return null;
        return Math.min(targetOffsetM,
            coverTopOffsetM - safetyMarginM - quantizationM / 2);
    }

    // Cut patches are produced for every applied road, but photoreal proposal/parcel isolation
    // must paint only the same roads as the vector mask entries. A stale patch with no matching
    // deck or seam would otherwise leave an unsupported hole in the Google shell.
    function filterRoadFloorPatches(patches, isolationFilter) {
        const list = Array.isArray(patches) ? patches : [];
        if (isolationFilter === '__parcel__') return [];
        if (!isolationFilter) return list.slice();
        return list.filter(function (patch) {
            return String(patch && patch.proposalId) === String(isolationFilter);
        });
    }

    function roadPatchKey(patch) {
        if (!patch || patch._replacementKey == null) return null;
        const key = String(patch._replacementKey);
        return key ? key : null;
    }

    // A road cut is safe only when the same terrain-profile segment also produced its opaque solid
    // envelope. Pair the two families before either is published; unmatched envelopes are harmless,
    // while unmatched masks are deliberately suppressed to keep the Google shell closed.
    function pairRoadReplacementPatches(maskPatches, envelopePatches) {
        const masks = Array.isArray(maskPatches) ? maskPatches : [];
        const envelopes = Array.isArray(envelopePatches) ? envelopePatches : [];
        const counts = function (patches) {
            const out = new Map();
            patches.forEach(function (patch) {
                const key = roadPatchKey(patch);
                if (key) out.set(key, (out.get(key) || 0) + 1);
            });
            return out;
        };
        const maskCounts = counts(masks);
        const envelopeCounts = counts(envelopes);
        const uniquelyPaired = new Set();
        maskCounts.forEach(function (count, key) {
            if (count === 1 && envelopeCounts.get(key) === 1) uniquelyPaired.add(key);
        });
        return {
            masks: masks.filter(function (patch) {
                return uniquelyPaired.has(roadPatchKey(patch));
            }),
            envelopes: envelopes.filter(function (patch) {
                return uniquelyPaired.has(roadPatchKey(patch));
            })
        };
    }

    // Tile LOD can advance in several distinct bursts. Track source revisions separately from
    // applied refits so a later fine-mesh burst can supersede an earlier coarse "quiet" period,
    // while an explicit pass budget prevents camera-driven tile churn from rebuilding forever.
    function createTerrainRefreshTracker(maxRefreshes) {
        const requested = Number(maxRefreshes);
        return {
            revision: 0,
            appliedRevision: 0,
            refreshes: 0,
            maxRefreshes: Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 3,
            lastReason: null
        };
    }

    function noteTerrainSourceChange(tracker, reason) {
        if (!tracker || !(tracker.maxRefreshes > 0)) return null;
        tracker.revision += 1;
        tracker.lastReason = reason == null ? 'tile-source-change' : String(reason);
        return tracker.revision;
    }

    function claimTerrainRefresh(tracker) {
        if (!tracker || tracker.refreshes >= tracker.maxRefreshes
            || tracker.revision <= tracker.appliedRevision) return null;
        tracker.refreshes += 1;
        tracker.appliedRevision = tracker.revision;
        return {
            revision: tracker.appliedRevision,
            refresh: tracker.refreshes,
            maxRefreshes: tracker.maxRefreshes,
            reason: tracker.lastReason
        };
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
        selectRoadSurfaceHeight: selectRoadSurfaceHeight,
        roadFloorEncodingRange: roadFloorEncodingRange,
        encodeRoadFloor: encodeRoadFloor,
        decodeRoadFloor: decodeRoadFloor,
        quantizationSafeRoadCutOffset: quantizationSafeRoadCutOffset,
        filterRoadFloorPatches: filterRoadFloorPatches,
        pairRoadReplacementPatches: pairRoadReplacementPatches,
        createTerrainRefreshTracker: createTerrainRefreshTracker,
        noteTerrainSourceChange: noteTerrainSourceChange,
        claimTerrainRefresh: claimTerrainRefresh,
        cleanGroundGrid: cleanGroundGrid,
        sampleBilinear: sampleBilinear,
        coversBounds: coversBounds
    };
});
