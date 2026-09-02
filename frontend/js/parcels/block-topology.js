// Street-block topology over the live parcel fabric.
//
// Parcel adjacency and block adjacency are deliberately not the same question. Two cadastral
// outlines can appear to share a boundary because of survey tolerance or overlapping cut output,
// while that very stretch is owned by a live road parcel. Treating that pair as connected lets a
// flood fill jump across the street and merge two blocks.
//
// This module is the one topology boundary for every block consumer. It starts with the tolerant,
// T-junction-safe adjacency service and removes only the part of a shared boundary that lies in
// live corridor ground. It knows nothing about proposals, server state, rendering, or caches: its
// caller gives it the current ordinary parcels and the current corridor parcels, all in the same
// metric coordinate system.
(function attachParcelBlockTopology(global) {
    'use strict';

    const adjacency = () => global.__parcelAdjacency
        || (typeof require === 'function' ? require('./parcel-adjacency.js') : null);

    const DEFAULTS = {
        // Subdivide a shared stretch before asking whether it is road ground. A road may cover only
        // part of a long cadastral boundary; the uncovered remainder still connects the parcels.
        // Half-metre samples match adjacency's own minimum meaningful shared length.
        barrierSampleM: 0.5,
        // Boolean clipping can leave two land remainders with a sub-metre seam immediately beside
        // the road that cut them. Exact point-in-polygon containment would let a block flood-fill
        // squeeze through that numerical seam. Treat half a metre around live corridor ground as
        // part of the barrier; a real land connection must have at least that much clearance.
        barrierClearanceM: 0.5,
        barrierIndexCellM: 50
    };

    function pointOnSegment(x, y, a, b, epsilon = 1e-7) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lengthSquared = (dx * dx) + (dy * dy);
        if (lengthSquared <= epsilon * epsilon) {
            return Math.hypot(x - a[0], y - a[1]) <= epsilon;
        }
        const cross = ((x - a[0]) * dy) - ((y - a[1]) * dx);
        if (Math.abs(cross) > epsilon * Math.max(1, Math.hypot(dx, dy))) return false;
        const dot = ((x - a[0]) * dx) + ((y - a[1]) * dy);
        if (dot < -epsilon) return false;
        return dot <= lengthSquared + epsilon;
    }

    function ringContains(ring, x, y) {
        if (!Array.isArray(ring) || ring.length < 3) return { inside: false, boundary: false };
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
            const a = ring[j];
            const b = ring[i];
            if (!Array.isArray(a) || !Array.isArray(b)) continue;
            if (pointOnSegment(x, y, a, b)) return { inside: true, boundary: true };
            const crosses = ((a[1] > y) !== (b[1] > y))
                && (x < ((b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) + a[0]);
            if (crosses) inside = !inside;
        }
        return { inside, boundary: false };
    }

    // `rings` is every ring of every polygon. Even/odd containment handles outer rings, holes and
    // disjoint MultiPolygon members without needing GeoJSON winding conventions.
    function barrierContains(barrier, x, y) {
        let inside = false;
        for (const ring of (barrier && Array.isArray(barrier.rings) ? barrier.rings : [])) {
            const hit = ringContains(ring, x, y);
            if (hit.boundary) return true;
            if (hit.inside) inside = !inside;
        }
        return inside;
    }

    function pointSegmentDistance(x, y, a, b) {
        if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lengthSquared = (dx * dx) + (dy * dy);
        if (!(lengthSquared > 0)) return Math.hypot(x - a[0], y - a[1]);
        const projection = Math.max(0, Math.min(1,
            (((x - a[0]) * dx) + ((y - a[1]) * dy)) / lengthSquared));
        return Math.hypot(
            x - (a[0] + (projection * dx)),
            y - (a[1] + (projection * dy))
        );
    }

    function barrierBoundaryDistance(barrier, x, y) {
        let nearest = Infinity;
        for (const ring of (barrier && Array.isArray(barrier.rings) ? barrier.rings : [])) {
            if (!Array.isArray(ring) || ring.length < 2) continue;
            for (let index = 0; index < ring.length; index += 1) {
                const next = (index + 1) % ring.length;
                nearest = Math.min(nearest, pointSegmentDistance(x, y, ring[index], ring[next]));
            }
        }
        return nearest;
    }

    function boundsOfRings(rings) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        (Array.isArray(rings) ? rings : []).forEach(ring => {
            (Array.isArray(ring) ? ring : []).forEach(point => {
                if (!Array.isArray(point) || point.length < 2) return;
                minX = Math.min(minX, point[0]);
                minY = Math.min(minY, point[1]);
                maxX = Math.max(maxX, point[0]);
                maxY = Math.max(maxY, point[1]);
            });
        });
        return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
    }

    function createBarrierIndex(barriers, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const cellM = Math.max(1, Number(opts.barrierIndexCellM) || DEFAULTS.barrierIndexCellM);
        const requestedClearance = Number(opts.barrierClearanceM);
        const clearanceM = Number.isFinite(requestedClearance)
            ? Math.max(0, requestedClearance)
            : DEFAULTS.barrierClearanceM;
        const cells = new Map();
        const records = [];
        const file = (key, index) => {
            let list = cells.get(key);
            if (!list) { list = []; cells.set(key, list); }
            list.push(index);
        };

        (Array.isArray(barriers) ? barriers : []).forEach(barrier => {
            const rings = barrier && Array.isArray(barrier.rings) ? barrier.rings : [];
            const bounds = boundsOfRings(rings);
            if (!bounds) return;
            const index = records.length;
            records.push({ ...barrier, rings, bounds });
            const x0 = Math.floor((bounds[0] - clearanceM) / cellM);
            const y0 = Math.floor((bounds[1] - clearanceM) / cellM);
            const x1 = Math.floor((bounds[2] + clearanceM) / cellM);
            const y1 = Math.floor((bounds[3] + clearanceM) / cellM);
            for (let x = x0; x <= x1; x += 1) {
                for (let y = y0; y <= y1; y += 1) file(`${x}|${y}`, index);
            }
        });

        function contains(x, y) {
            const candidates = cells.get(`${Math.floor(x / cellM)}|${Math.floor(y / cellM)}`) || [];
            for (const index of candidates) {
                const barrier = records[index];
                const b = barrier.bounds;
                if (x < b[0] - clearanceM || x > b[2] + clearanceM
                    || y < b[1] - clearanceM || y > b[3] + clearanceM) continue;
                if (barrierContains(barrier, x, y)) return true;
                if (clearanceM > 0 && barrierBoundaryDistance(barrier, x, y) <= clearanceM) return true;
            }
            return false;
        }

        return { contains, size: records.length, clearanceM };
    }

    function openLengthOfSpan(span, barriers, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const length = Number(span && span.lengthM) || Math.max(0, (span && span.hi) - (span && span.lo));
        if (!(length > 0)) return 0;
        if (!barriers || !barriers.size) return length;
        const sampleM = Math.max(0.05, Number(opts.barrierSampleM) || DEFAULTS.barrierSampleM);
        const slices = Math.max(1, Math.ceil(length / sampleM));
        const sliceM = length / slices;
        const ux = Math.cos(span.theta);
        const uy = Math.sin(span.theta);
        let openM = 0;
        for (let index = 0; index < slices; index += 1) {
            const along = span.lo + ((index + 0.5) * sliceM);
            const x = (ux * along) - (uy * span.offset);
            const y = (uy * along) + (ux * span.offset);
            if (!barriers.contains(x, y)) openM += sliceM;
        }
        return openM;
    }

    function neighborPairs(parcels, barrierParcels, options) {
        const api = adjacency();
        if (!api || typeof api.sharedBoundarySpans !== 'function') return [];
        const opts = { ...DEFAULTS, ...(options || {}) };
        const barrierIndex = createBarrierIndex(barrierParcels, opts);
        return api.sharedBoundarySpans(parcels, opts)
            .map(pair => {
                const sharedM = pair.spans.reduce(
                    (total, span) => total + openLengthOfSpan(span, barrierIndex, opts),
                    0
                );
                return { a: pair.a, b: pair.b, sharedM };
            })
            .filter(pair => pair.sharedM >= (Number(opts.minSharedM) || api.DEFAULTS.minSharedM))
            .sort((a, b) => (b.sharedM - a.sharedM) || a.a.localeCompare(b.a));
    }

    const api = {
        DEFAULTS,
        barrierBoundaryDistance,
        barrierContains,
        createBarrierIndex,
        neighborPairs,
        openLengthOfSpan,
        ringContains
    };
    global.__parcelBlockTopology = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
