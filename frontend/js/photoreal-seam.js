// Pure geometry helpers for capping shader-clipped photoreal tile surfaces at proposal boundaries.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__photorealSeam = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function pointAlong(a, b, t) {
        return [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t
        ];
    }

    function weightsAlong(a, b, t) {
        return [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t
        ];
    }

    function squaredDistance(a, b) {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        return dx * dx + dy * dy + dz * dz;
    }

    function triangleDoubleArea(a, b, c) {
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cross = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]
        ];
        return Math.hypot(cross[0], cross[1], cross[2]);
    }

    function finitePoint(point) {
        return Array.isArray(point) && point.length >= 3
            && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
    }

    // A nearest-filtered top-down mask owns a square texel around each sample. At an arbitrary
    // road angle its boundary can therefore miss by half the texel diagonal. Civil geometry must
    // own that complete uncertainty band plus a small guard; keeping the calculation in one pure
    // helper prevents the vector buffer, source-textured collar and tests from drifting apart.
    function maskEdgeContract(windowHalfM, resolution, mercatorScale, guardSceneM) {
        const half = Number(windowHalfM);
        const size = Number(resolution);
        const scale = Number(mercatorScale);
        const guard = Number.isFinite(Number(guardSceneM))
            ? Math.max(0, Number(guardSceneM)) : 0.1;
        if (!(half > 0) || !(size > 0) || !(scale > 0)) return null;
        const texelSceneM = (2 * half) / size;
        const halfDiagonalSceneM = Math.SQRT1_2 * texelSceneM;
        const ownershipSceneM = halfDiagonalSceneM + guard;
        return {
            texelSceneM,
            halfDiagonalSceneM,
            guardSceneM: guard,
            ownershipSceneM,
            bufferTrueM: ownershipSceneM / scale,
            retainedOverlapSceneM: ownershipSceneM,
            inwardWidthSceneM: ownershipSceneM
        };
    }

    function nonDegenerateQuad(vertices, epsilon) {
        return Array.isArray(vertices) && vertices.length === 4 && vertices.every(finitePoint)
            && (triangleDoubleArea(vertices[0], vertices[1], vertices[2]) > epsilon
                || triangleDoubleArea(vertices[0], vertices[2], vertices[3]) > epsilon);
    }

    // Turn one exact triangle/cut-boundary intersection into two complementary fascias:
    //
    //  * a vertical wall from a roof/canopy hit down to the replacement surface; and
    //  * a short flange across the clip plane, which remains non-degenerate when the source hit is
    //    itself vertical (a facade or trunk). The old down-only extrusion collapsed to a line for
    //    precisely those vertical hits, leaving the photogrammetry shell visibly hollow.
    //
    // `segment.inward` points into the discarded footprint. `bottomAt` returns the local formation
    // support elevation and may return null; the fixed depth is only the NoData fallback.
    function buildSeamFasciaQuads(hit, segment, options) {
        options = options || {};
        if (!hit || !finitePoint(hit.start && hit.start.position)
            || !finitePoint(hit.end && hit.end.position) || !segment) return [];
        const start = hit.start.position;
        const end = hit.end.position;
        const epsilon = Number.isFinite(options.epsilon) && options.epsilon > 0 ? options.epsilon : 1e-7;
        const fallbackDepth = Number.isFinite(options.fallbackDepth) && options.fallbackDepth > 0
            ? options.fallbackDepth : 4;
        const supportAt = typeof options.bottomAt === 'function' ? options.bottomAt : null;
        const supportZ = function (point) {
            let value = supportAt ? supportAt(point[0], point[1]) : null;
            if (!Number.isFinite(value)) value = point[2] - fallbackDepth;
            // A fascia is a downward closure. Uphill ground/content is handled by the continuous
            // terrain curtain, and must not turn a roof wall inside-out.
            return Math.min(point[2] - epsilon, value);
        };
        const quads = [];
        const down = [
            start.slice(),
            [start[0], start[1], supportZ(start)],
            [end[0], end[1], supportZ(end)],
            end.slice()
        ];
        if (nonDegenerateQuad(down, epsilon)) quads.push({ kind: 'down', vertices: down });

        const dx = Number(segment.b && segment.b[0]) - Number(segment.a && segment.a[0]);
        const dy = Number(segment.b && segment.b[1]) - Number(segment.a && segment.a[1]);
        const length = Math.hypot(dx, dy);
        if (length > epsilon) {
            const inferred = [-dy / length, dx / length];
            const supplied = segment.inward;
            const inward = Array.isArray(supplied) && Number.isFinite(supplied[0]) && Number.isFinite(supplied[1])
                ? supplied : inferred;
            const retainedOverlap = Number.isFinite(options.retainedOverlapM)
                ? Math.max(0, options.retainedOverlapM) : 0.05;
            const inwardWidth = Number.isFinite(options.inwardWidthM)
                ? Math.max(epsilon, options.inwardWidthM) : 1;
            const shifted = function (point, distance) {
                return [point[0] + inward[0] * distance, point[1] + inward[1] * distance, point[2]];
            };
            // The retained vertices reproduce the source triangle at the cut rim. On the paved
            // side, however, a roof/curb/camber hit must not extend over the replacement deck.
            // Clamp only those inward vertices just below the local formation surface; the down
            // fascia still preserves the full vertical source intersection at the exact boundary.
            const inwardTopOffset = Number.isFinite(options.inwardTopOffsetM)
                ? options.inwardTopOffsetM : 0;
            const inwardPoint = function (point) {
                const shiftedPoint = shifted(point, inwardWidth);
                if (!supportAt) return shiftedPoint;
                const support = supportAt(shiftedPoint[0], shiftedPoint[1]);
                if (Number.isFinite(support)) {
                    shiftedPoint[2] = Math.min(shiftedPoint[2], support + inwardTopOffset);
                }
                return shiftedPoint;
            };
            const retainedTopOffset = Number.isFinite(options.retainedTopOffsetM)
                ? options.retainedTopOffsetM : null;
            const retainedPoint = function (point) {
                const shiftedPoint = shifted(point, -retainedOverlap);
                if (!supportAt || retainedTopOffset === null) return shiftedPoint;
                const support = supportAt(shiftedPoint[0], shiftedPoint[1]);
                if (Number.isFinite(support)) {
                    shiftedPoint[2] = Math.min(shiftedPoint[2], support + retainedTopOffset);
                }
                return shiftedPoint;
            };
            const across = [
                retainedPoint(start),
                inwardPoint(start),
                inwardPoint(end),
                retainedPoint(end)
            ];
            if (nonDegenerateQuad(across, epsilon)) quads.push({ kind: 'across', vertices: across });
        }
        return quads;
    }

    // Build one neutral, depth-tested wall around an authored road's exterior boundary. Unlike a
    // source-textured per-triangle fascia, this curtain cannot duplicate isolated canopy/roof
    // triangles as floating shards. It is emitted only where a trusted formation exists and the
    // original visible Google surface is materially higher than that formation.
    function buildClearanceCurtainPositions(ringXY, supportAt, visibleAt, options) {
        options = options || {};
        if (!Array.isArray(ringXY) || ringXY.length < 2
            || typeof supportAt !== 'function' || typeof visibleAt !== 'function') {
            return { positions: [], segmentCount: 0 };
        }
        const bottomOffsetM = Number.isFinite(options.bottomOffsetM)
            ? options.bottomOffsetM : 0.03;
        const minimumClearanceM = Number.isFinite(options.minimumClearanceM)
            ? Math.max(0, options.minimumClearanceM) : 0.5;
        const topMarginM = Number.isFinite(options.topMarginM)
            ? Math.max(0, options.topMarginM) : 0.1;
        const maximumHeightM = Number.isFinite(options.maximumHeightM)
            ? Math.max(0, options.maximumHeightM) : 30;
        const epsilon = Number.isFinite(options.epsilon) && options.epsilon > 0
            ? options.epsilon : 1e-6;
        const sample = function (point) {
            if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
                return null;
            }
            const support = supportAt(point[0], point[1]);
            if (!Number.isFinite(support)) return null;
            const bottom = support + bottomOffsetM;
            const visible = visibleAt(point[0], point[1]);
            const top = Number.isFinite(visible) && visible > bottom + minimumClearanceM
                ? Math.min(visible + topMarginM, bottom + maximumHeightM) : bottom;
            return { x: point[0], y: point[1], bottom, top };
        };
        const positions = [];
        let segmentCount = 0;
        for (let index = 1; index < ringXY.length; index++) {
            const a = sample(ringXY[index - 1]);
            const b = sample(ringXY[index]);
            if (!a || !b || (a.top <= a.bottom + epsilon && b.top <= b.bottom + epsilon)) continue;
            positions.push(
                a.x, a.y, a.top, a.x, a.y, a.bottom, b.x, b.y, b.bottom,
                a.x, a.y, a.top, b.x, b.y, b.bottom, b.x, b.y, b.top
            );
            segmentCount += 1;
        }
        return { positions, segmentCount };
    }

    function addUniqueIntersection(out, position, barycentric, epsilon) {
        const epsilonSq = epsilon * epsilon;
        for (let i = 0; i < out.length; i++) {
            if (squaredDistance(out[i].position, position) <= epsilonSq) return;
        }
        out.push({ position, barycentric });
    }

    function interpolateIntersection(a, b, t) {
        return {
            position: pointAlong(a.position, b.position, t),
            barycentric: weightsAlong(a.barycentric, b.barycentric, t)
        };
    }

    // Intersect one 3D triangle with the vertical plane through a finite XY boundary segment.
    // Returned barycentric weights let the renderer interpolate source UVs at the exact cut edge.
    function intersectTriangleWithVerticalSegment(triangle, segment, epsilon) {
        epsilon = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 1e-7;
        if (!Array.isArray(triangle) || triangle.length !== 3 || !segment) return null;
        const a = segment.a;
        const b = segment.b;
        if (!a || !b) return null;
        const edgeX = b[0] - a[0];
        const edgeY = b[1] - a[1];
        const edgeLengthSq = edgeX * edgeX + edgeY * edgeY;
        if (!(edgeLengthSq > epsilon * epsilon)) return null;
        const edgeLength = Math.sqrt(edgeLengthSq);

        const distances = triangle.map(function (point) {
            return (edgeX * (point[1] - a[1]) - edgeY * (point[0] - a[0])) / edgeLength;
        });
        if (distances.every(function (distance) { return Math.abs(distance) <= epsilon; })) {
            // A triangle lying in the clipping plane has no unique cut edge to cap.
            return null;
        }

        const basis = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        const planeHits = [];
        for (let i = 0; i < 3; i++) {
            const j = (i + 1) % 3;
            const di = distances[i];
            const dj = distances[j];
            if (Math.abs(di) <= epsilon) {
                addUniqueIntersection(planeHits, triangle[i].slice(), basis[i].slice(), epsilon);
            }
            if ((di < -epsilon && dj > epsilon) || (di > epsilon && dj < -epsilon)) {
                const t = di / (di - dj);
                addUniqueIntersection(
                    planeHits,
                    pointAlong(triangle[i], triangle[j], t),
                    weightsAlong(basis[i], basis[j], t),
                    epsilon
                );
            }
        }
        if (planeHits.length < 2) return null;

        // Numerical vertex-on-plane cases can yield three points. The actual plane/triangle
        // intersection is the farthest pair.
        let start = planeHits[0];
        let end = planeHits[1];
        let farthestSq = squaredDistance(start.position, end.position);
        for (let i = 0; i < planeHits.length; i++) {
            for (let j = i + 1; j < planeHits.length; j++) {
                const distanceSq = squaredDistance(planeHits[i].position, planeHits[j].position);
                if (distanceSq > farthestSq) {
                    start = planeHits[i];
                    end = planeHits[j];
                    farthestSq = distanceSq;
                }
            }
        }
        if (farthestSq <= epsilon * epsilon) return null;

        const segmentParameter = function (point) {
            return ((point[0] - a[0]) * edgeX + (point[1] - a[1]) * edgeY) / edgeLengthSq;
        };
        const s0 = segmentParameter(start.position);
        const s1 = segmentParameter(end.position);
        const ds = s1 - s0;
        let low = 0;
        let high = 1;
        if (Math.abs(ds) <= epsilon) {
            if (s0 < -epsilon || s0 > 1 + epsilon) return null;
        } else {
            const atStart = (0 - s0) / ds;
            const atEnd = (1 - s0) / ds;
            low = Math.max(0, Math.min(atStart, atEnd));
            high = Math.min(1, Math.max(atStart, atEnd));
            if (high - low <= epsilon) return null;
        }

        const clippedStart = low === 0 ? start : interpolateIntersection(start, end, low);
        const clippedEnd = high === 1 ? end : interpolateIntersection(start, end, high);
        if (squaredDistance(clippedStart.position, clippedEnd.position) <= epsilon * epsilon) return null;
        return { start: clippedStart, end: clippedEnd };
    }

    function segmentBounds(segment) {
        return {
            minX: Math.min(segment.a[0], segment.b[0]),
            minY: Math.min(segment.a[1], segment.b[1]),
            maxX: Math.max(segment.a[0], segment.b[0]),
            maxY: Math.max(segment.a[1], segment.b[1])
        };
    }

    function boundsOverlap(a, b) {
        return !!a && !!b
            && a.minX <= b.maxX && a.maxX >= b.minX
            && a.minY <= b.maxY && a.maxY >= b.minY;
    }

    // Return an explicitly closed ring whose every edge is no longer than `maxSpacing` scene
    // units. Cut fascias and curtain walls then sample the same dense road formation as the deck,
    // instead of linearly bridging the sparse vertices of a long buffered polygon edge.
    function densifyClosedRing(ring, maxSpacing) {
        const source = Array.isArray(ring) ? ring.filter(function (point) {
            return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
        }).map(function (point) { return [point[0], point[1]]; }) : [];
        if (source.length < 2) return source;
        const spacing = Number.isFinite(maxSpacing) && maxSpacing > 0 ? maxSpacing : Infinity;
        const first = source[0];
        const last = source[source.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) source.push(first.slice());

        const dense = [source[0].slice()];
        for (let i = 1; i < source.length; i++) {
            const a = source[i - 1];
            const b = source[i];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const intervals = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
            for (let step = 1; step <= intervals; step++) {
                const t = step / intervals;
                dense.push([a[0] + dx * t, a[1] + dy * t]);
            }
        }
        return dense;
    }

    function buildSegmentGrid(segments, cellSize) {
        const safeSegments = Array.isArray(segments) ? segments.filter(function (segment) {
            return segment && segment.a && segment.b;
        }) : [];
        cellSize = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 16;
        const cells = new Map();
        let bounds = null;
        safeSegments.forEach(function (segment, index) {
            const box = segmentBounds(segment);
            segment.bounds = box;
            if (!bounds) bounds = { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
            else {
                bounds.minX = Math.min(bounds.minX, box.minX);
                bounds.minY = Math.min(bounds.minY, box.minY);
                bounds.maxX = Math.max(bounds.maxX, box.maxX);
                bounds.maxY = Math.max(bounds.maxY, box.maxY);
            }
            const minCellX = Math.floor(box.minX / cellSize);
            const maxCellX = Math.floor(box.maxX / cellSize);
            const minCellY = Math.floor(box.minY / cellSize);
            const maxCellY = Math.floor(box.maxY / cellSize);
            for (let y = minCellY; y <= maxCellY; y++) {
                for (let x = minCellX; x <= maxCellX; x++) {
                    const key = x + ',' + y;
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(index);
                }
            }
        });
        return { segments: safeSegments, cells, cellSize, bounds };
    }

    function querySegmentGrid(grid, bounds) {
        if (!grid || !grid.bounds || !boundsOverlap(grid.bounds, bounds)) return [];
        const minCellX = Math.floor(bounds.minX / grid.cellSize);
        const maxCellX = Math.floor(bounds.maxX / grid.cellSize);
        const minCellY = Math.floor(bounds.minY / grid.cellSize);
        const maxCellY = Math.floor(bounds.maxY / grid.cellSize);
        const indices = new Set();
        for (let y = minCellY; y <= maxCellY; y++) {
            for (let x = minCellX; x <= maxCellX; x++) {
                const cell = grid.cells.get(x + ',' + y);
                if (cell) cell.forEach(function (index) { indices.add(index); });
            }
        }
        return Array.from(indices).map(function (index) { return grid.segments[index]; }).filter(function (segment) {
            return boundsOverlap(segment.bounds, bounds);
        });
    }

    return {
        maskEdgeContract,
        intersectTriangleWithVerticalSegment,
        buildSeamFasciaQuads,
        buildClearanceCurtainPositions,
        triangleDoubleArea,
        densifyClosedRing,
        buildSegmentGrid,
        querySegmentGrid,
        boundsOverlap
    };
});
