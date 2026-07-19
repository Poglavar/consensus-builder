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
        intersectTriangleWithVerticalSegment,
        buildSegmentGrid,
        querySegmentGrid,
        boundsOverlap
    };
});
