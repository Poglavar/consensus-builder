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

    const MAX_BLOCK_PARCELS = 100;

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
        barrierIndexCellM: 50,
        // Grid for barrier boundary edges: the clearance test only measures edges in a point's cell.
        barrierEdgeCellM: 5
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

    // Even/odd crossing count over every ring of a barrier, without the on-boundary test: the
    // index below answers "on or near the boundary" from its edge grid first.
    function crossesOddly(barrier, x, y) {
        let inside = false;
        for (const ring of barrier.rings) {
            if (!Array.isArray(ring) || ring.length < 3) continue;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
                const a = ring[j];
                const b = ring[i];
                if (!Array.isArray(a) || !Array.isArray(b)) continue;
                if (((a[1] > y) !== (b[1] > y))
                    && (x < ((b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) + a[0])) inside = !inside;
            }
        }
        return inside;
    }

    function createBarrierIndex(barriers, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const cellM = Math.max(1, Number(opts.barrierIndexCellM) || DEFAULTS.barrierIndexCellM);
        const edgeCellM = Math.max(0.5, Number(opts.barrierEdgeCellM) || DEFAULTS.barrierEdgeCellM);
        const requestedClearance = Number(opts.barrierClearanceM);
        const clearanceM = Number.isFinite(requestedClearance)
            ? Math.max(0, requestedClearance)
            : DEFAULTS.barrierClearanceM;
        // A point exactly on a barrier boundary is inside it, even with no clearance.
        const nearM = Math.max(clearanceM, 1e-7);
        const cells = new Map();
        const edgeCells = new Map();
        const records = [];
        const file = (map, key, value) => {
            let list = map.get(key);
            if (!list) { list = []; map.set(key, list); }
            list.push(value);
        };

        function add(barrier) {
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
                for (let y = y0; y <= y1; y += 1) file(cells, `${x}|${y}`, index);
            }
            // Every boundary edge, filed in the fine cells within clearance of it, so a sample
            // point measures its distance to the few edges near it instead of to every edge of
            // every road around the block (most of a widened Detect block's time went there).
            rings.forEach(ring => {
                if (!Array.isArray(ring) || ring.length < 2) return;
                for (let i = 0; i < ring.length; i += 1) {
                    const a = ring[i];
                    const b = ring[(i + 1) % ring.length];
                    if (!Array.isArray(a) || !Array.isArray(b)) continue;
                    const ex0 = Math.floor((Math.min(a[0], b[0]) - nearM) / edgeCellM);
                    const ey0 = Math.floor((Math.min(a[1], b[1]) - nearM) / edgeCellM);
                    const ex1 = Math.floor((Math.max(a[0], b[0]) + nearM) / edgeCellM);
                    const ey1 = Math.floor((Math.max(a[1], b[1]) + nearM) / edgeCellM);
                    for (let x = ex0; x <= ex1; x += 1) {
                        for (let y = ey0; y <= ey1; y += 1) file(edgeCells, `${x}|${y}`, [a, b]);
                    }
                }
            });
        }
        (Array.isArray(barriers) ? barriers : []).forEach(add);

        // Inside a barrier, on its boundary, or within clearance of it.
        function contains(x, y) {
            const edges = edgeCells.get(`${Math.floor(x / edgeCellM)}|${Math.floor(y / edgeCellM)}`) || [];
            for (const [a, b] of edges) {
                if (pointSegmentDistance(x, y, a, b) <= nearM) return true;
            }
            const candidates = cells.get(`${Math.floor(x / cellM)}|${Math.floor(y / cellM)}`) || [];
            for (const index of candidates) {
                const barrier = records[index];
                const b = barrier.bounds;
                if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
                if (crossesOddly(barrier, x, y)) return true;
            }
            return false;
        }

        // `add` grows the index in place: a flood fill meets the same roads around many members.
        return { contains, add, get size() { return records.length; }, clearanceM };
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
        // Either the corridor parcels themselves or an index already built over them.
        const barrierIndex = barrierParcels && typeof barrierParcels.contains === 'function'
            ? barrierParcels
            : createBarrierIndex(barrierParcels, opts);
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

    // Block neighbours of ONE parcel at a time, for a flood fill growing a block out of a seed.
    //
    // `nearby(id)` returns { parcel, parcels, barriers }: that parcel, the ordinary parcels around
    // it and the live corridor parcels around it, all in one metric frame. The work then follows
    // the block rather than the ground loaded around it. Detect block used to compute every pair in
    // its whole search area before flooding — after three widenings of the search that was ~80,000
    // central-Zagreb parcels, over a minute of main thread, for a block of a few dozen.
    // Answers are cached per parcel id.
    function createNeighborGraph(nearby, options) {
        const cache = new Map();
        // A pair is measured once: the second parcel of a pair reuses the first one's answer and
        // leaves the first out of its own comparison. Both find each other through `nearby`,
        // because "within the search pad of the other's bounds" is symmetric.
        const measured = new Map(); // id -> Map(neighbourId -> sharedM), for parcels already done
        // One barrier index for the whole fill, grown as members bring new roads into view: the same
        // road bounds many members, and rebuilding its edge grid for each was a third of the work.
        const barrierIndex = createBarrierIndex([], options);
        const indexedBarriers = new Set();
        function neighborsOf(parcelId) {
            const id = String(parcelId);
            if (cache.has(id)) return cache.get(id);
            const around = nearby(id) || {};
            const parcel = around.parcel;
            const neighbours = [];
            if (parcel && Array.isArray(parcel.rings) && parcel.rings.length) {
                const others = [];
                (Array.isArray(around.parcels) ? around.parcels : []).forEach(entry => {
                    const otherId = entry ? String(entry.id) : '';
                    if (!otherId || otherId === id) return;
                    const known = measured.get(otherId);
                    if (!known) { others.push(entry); return; }
                    if (known.has(id)) neighbours.push({ id: otherId, sharedM: known.get(id) });
                });
                (Array.isArray(around.barriers) ? around.barriers : []).forEach(barrier => {
                    const barrierId = barrier ? String(barrier.id) : '';
                    if (!barrierId || indexedBarriers.has(barrierId)) return;
                    indexedBarriers.add(barrierId);
                    barrierIndex.add(barrier);
                });
                neighborPairs([{ ...parcel, id }, ...others], barrierIndex, { ...(options || {}), focusId: id })
                    .forEach(pair => neighbours.push({ id: pair.a === id ? pair.b : pair.a, sharedM: pair.sharedM }));
                neighbours.sort((x, y) => (y.sharedM - x.sharedM) || x.id.localeCompare(y.id));
            }
            measured.set(id, new Map(neighbours.map(entry => [entry.id, entry.sharedM])));
            cache.set(id, neighbours);
            return neighbours;
        }
        return { neighborsOf };
    }

    // A uniform grid over entries' bounding boxes ([minX, minY, maxX, maxY], any units), answering
    // "which entries' boxes intersect this box" without scanning them all. A block flood fill asks
    // that for every member; a linear scan of ~25,000 loaded parcels cost about 1 ms per member.
    function createBoundsIndex(entries, cellSize) {
        const size = Number(cellSize);
        if (!(size > 0)) throw new Error('createBoundsIndex: cellSize must be a positive number');
        const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && Array.isArray(entry.bounds)
            && entry.bounds.length >= 4 && entry.bounds.every(Number.isFinite));
        const cells = new Map();
        list.forEach((entry, index) => {
            const [x0, y0, x1, y1] = entry.bounds;
            for (let x = Math.floor(x0 / size); x <= Math.floor(x1 / size); x += 1) {
                for (let y = Math.floor(y0 / size); y <= Math.floor(y1 / size); y += 1) {
                    const key = `${x}|${y}`;
                    let bucket = cells.get(key);
                    if (!bucket) { bucket = []; cells.set(key, bucket); }
                    bucket.push(index);
                }
            }
        });
        function query(box) {
            const seen = new Set();
            const found = [];
            for (let x = Math.floor(box[0] / size); x <= Math.floor(box[2] / size); x += 1) {
                for (let y = Math.floor(box[1] / size); y <= Math.floor(box[3] / size); y += 1) {
                    for (const index of cells.get(`${x}|${y}`) || []) {
                        if (seen.has(index)) continue;
                        seen.add(index);
                        const b = list[index].bounds;
                        if (b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]) found.push(list[index]);
                    }
                }
            }
            return found;
        }
        return { query, size: list.length };
    }

    // Breadth-first block growth from `seedId`. Every member must satisfy `isInside(id)` (in the
    // app: lies wholly inside ground that is loaded); the first one that does not makes the block
    // invalid and stops the fill, because a block with a member running out of known ground is
    // not known to be complete. Stop before admitting a 101st distinct parcel: missing road
    // barriers must not turn one block detection into a walk across a whole city.
    function growBlock({ seedId, neighborsOf, isInside }) {
        const seed = String(seedId);
        const result = { ids: [], isValid: true, invalidId: null, invalidReason: null };
        if (!isInside(seed)) {
            return { ...result, isValid: false, invalidId: seed, invalidReason: 'start_not_fully_visible' };
        }
        const queued = new Set([seed]);
        const queue = [seed];
        for (let head = 0; head < queue.length; head += 1) {
            const id = queue[head];
            result.ids.push(id);
            for (const neighbour of neighborsOf(id)) {
                const neighbourId = String(neighbour);
                if (queued.has(neighbourId)) continue;
                if (queued.size >= MAX_BLOCK_PARCELS) {
                    return { ...result, isValid: false, invalidId: neighbourId, invalidReason: 'parcel_limit_exceeded' };
                }
                if (!isInside(neighbourId)) {
                    return { ...result, isValid: false, invalidId: neighbourId, invalidReason: 'not_fully_visible' };
                }
                queued.add(neighbourId);
                queue.push(neighbourId);
            }
        }
        return result;
    }

    const api = {
        MAX_BLOCK_PARCELS,
        DEFAULTS,
        barrierBoundaryDistance,
        barrierContains,
        createBarrierIndex,
        createBoundsIndex,
        createNeighborGraph,
        growBlock,
        neighborPairs,
        openLengthOfSpan,
        ringContains
    };
    global.__parcelBlockTopology = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
