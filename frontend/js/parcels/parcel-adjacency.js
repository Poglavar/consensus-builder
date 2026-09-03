// Which parcels share a boundary.
//
// Two parcels are neighbours when their outlines RUN ALONG each other for a real length. They are
// not neighbours merely because they store that boundary as the same pair of vertices — and that
// distinction is the whole point of this module.
//
// Block detection used to build adjacency by hashing each vertex pair into an edge key and linking
// parcels that produced the same key. Cadastral data mostly cooperates, so it mostly worked. What it
// cannot survive is a boundary the two sides split differently:
//
//   * a T-junction — A runs V1→V3 while B and C split the same line as V1→V2 and V2→V3;
//   * OUR OWN CUTS — a corridor's remainder is re-emitted by turf.difference with fresh vertices
//     along a boundary its uncut neighbour still stores whole.
//
// Either way the keys differ, the two parcels stop being neighbours, and a flood fill cannot cross.
// Measured on 172 real Šibenik parcels with four applied roads: the edge-key rule missed 3 of 363
// real adjacencies, and every one of them was a cut remainder beside an uncut parcel. A block only
// needs one missing link to lose everything behind it — which is exactly how "select whole block"
// produced a ring with three parcels left out of the middle.
//
// So the test here is geometric: collect every boundary segment, group the ones lying on the same
// infinite line, and add up how far the two parcels actually run together. Same rule measured 0 of
// 363 missed.
//
// Pure: plain numbers in, plain pairs out. Coordinates must be in METRES (HTRS96 here) — the
// tolerances below are lengths, and degrees would make them meaningless.

(function (global) {
    'use strict';

    const DEFAULTS = {
        // A vertex pair shorter than this is noise in the ring, not a boundary.
        minSegmentM: 0.05,
        // Below this the two parcels meet at a corner rather than running together.
        minSharedM: 0.5,
        // Survey noise and float drift: boundaries this close to parallel and this close together
        // are the same boundary. 0.03 rad is ~1.7°.
        angleToleranceRad: 0.03,
        offsetToleranceM: 0.25,
        // Candidate-grid size. The grid is spatial rather than based on a line's absolute normal
        // offset: HTRS coordinates are about five million metres from (0, 0), so even a microscopic
        // angle difference made two edges meeting at the same vertex appear half a metre apart when
        // their independently-rotated offsets were subtracted.
        candidateCellM: 25
    };

    // Keep the real endpoints. Any distance or overlap comparison must be built in a coordinate
    // frame shared by the pair being compared; independently rotating absolute HTRS coordinates is
    // precisely what made adjacency depend on where in Croatia the same shape happened to sit.
    function segmentsOf(parcels, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const segments = [];
        (Array.isArray(parcels) ? parcels : []).forEach(parcel => {
            const id = parcel && parcel.id !== undefined && parcel.id !== null ? String(parcel.id) : '';
            if (!id) return;
            (Array.isArray(parcel.rings) ? parcel.rings : []).forEach(ring => {
                if (!Array.isArray(ring)) return;
                for (let i = 0; i + 1 < ring.length; i += 1) {
                    const p = ring[i];
                    const q = ring[i + 1];
                    if (!Array.isArray(p) || !Array.isArray(q)) continue;
                    const dx = q[0] - p[0];
                    const dy = q[1] - p[1];
                    const length = Math.hypot(dx, dy);
                    if (!(length > opts.minSegmentM)) continue;
                    let theta = Math.atan2(dy, dx);
                    if (theta < 0) theta += Math.PI;
                    if (theta >= Math.PI) theta -= Math.PI;
                    segments.push({
                        index: segments.length,
                        id,
                        theta,
                        p: [p[0], p[1]],
                        q: [q[0], q[1]]
                    });
                }
            });
        });
        return segments;
    }

    // θ wraps: a boundary stored one way round is θ, the other way round is θ ± π, and they are the
    // same direction. Keep this separate from distance: comparing the two segments' independently
    // rotated normal-form offsets is not translation invariant.
    function angleDifference(s1, s2) {
        const dt = Math.abs(s1.theta - s2.theta);
        return Math.min(dt, Math.abs(dt - Math.PI));
    }

    function projectedSegment(segment, anchor, ux, uy, nx, ny) {
        const px = segment.p[0] - anchor[0];
        const py = segment.p[1] - anchor[1];
        const qx = segment.q[0] - anchor[0];
        const qy = segment.q[1] - anchor[1];
        const pa = (ux * px) + (uy * py);
        const qa = (ux * qx) + (uy * qy);
        const pn = (nx * px) + (ny * py);
        const qn = (nx * qx) + (ny * qy);
        return pa <= qa
            ? { lo: pa, hi: qa, nLo: pn, nHi: qn }
            : { lo: qa, hi: pa, nLo: qn, nHi: pn };
    }

    function normalAt(projected, along) {
        const length = projected.hi - projected.lo;
        if (!(length > 0)) return projected.nLo;
        const ratio = Math.max(0, Math.min(1, (along - projected.lo) / length));
        return projected.nLo + ((projected.nHi - projected.nLo) * ratio);
    }

    // Return the part of [lo, hi] on which the two almost-parallel segments stay within the
    // cadastral seam tolerance. Their separation is linear in this common coordinate frame, so the
    // valid interval is bounded by d = -tolerance and d = +tolerance.
    function closeInterval(first, second, lo, hi, tolerance) {
        if (!(hi > lo)) return null;
        const differenceAt = along => normalAt(first, along) - normalAt(second, along);
        const dLo = differenceAt(lo);
        const dHi = differenceAt(hi);
        const candidates = [lo, hi];
        const slope = (dHi - dLo) / (hi - lo);
        if (Math.abs(slope) > 1e-12) {
            [-tolerance, tolerance].forEach(limit => {
                const along = lo + ((limit - dLo) / slope);
                if (along > lo && along < hi) candidates.push(along);
            });
        }
        candidates.sort((a, b) => a - b);
        let validLo = null;
        let validHi = null;
        for (let index = 0; index + 1 < candidates.length; index += 1) {
            const from = candidates[index];
            const to = candidates[index + 1];
            const midpoint = (from + to) / 2;
            if (Math.abs(differenceAt(midpoint)) > tolerance + 1e-9) continue;
            if (validLo === null) validLo = from;
            validHi = to;
        }
        return validLo !== null && validHi > validLo ? [validLo, validHi] : null;
    }

    // Measure a shared stretch in a common, pair-local coordinate frame. This is invariant under
    // translating the whole city and therefore keeps its metre tolerances meaningful in HTRS96.
    function sharedSpan(s1, s2, opts) {
        if (angleDifference(s1, s2) > opts.angleToleranceRad) return null;

        let u1x = Math.cos(s1.theta);
        let u1y = Math.sin(s1.theta);
        let u2x = Math.cos(s2.theta);
        let u2y = Math.sin(s2.theta);
        if ((u1x * u2x) + (u1y * u2y) < 0) {
            u2x *= -1;
            u2y *= -1;
        }
        let ux = u1x + u2x;
        let uy = u1y + u2y;
        const magnitude = Math.hypot(ux, uy);
        if (!(magnitude > 0)) return null;
        ux /= magnitude;
        uy /= magnitude;
        let theta = Math.atan2(uy, ux);
        if (theta < 0) {
            theta += Math.PI;
            ux *= -1;
            uy *= -1;
        } else if (theta >= Math.PI) {
            theta -= Math.PI;
            ux *= -1;
            uy *= -1;
        }
        const nx = -uy;
        const ny = ux;
        const anchor = s1.p;
        const first = projectedSegment(s1, anchor, ux, uy, nx, ny);
        const second = projectedSegment(s2, anchor, ux, uy, nx, ny);
        const overlapLo = Math.max(first.lo, second.lo);
        const overlapHi = Math.min(first.hi, second.hi);
        const close = closeInterval(first, second, overlapLo, overlapHi, opts.offsetToleranceM);
        if (!close) return null;

        const [localLo, localHi] = close;
        const midpoint = (localLo + localHi) / 2;
        const anchorAlong = (ux * anchor[0]) + (uy * anchor[1]);
        const anchorOffset = (nx * anchor[0]) + (ny * anchor[1]);
        return {
            theta,
            offset: anchorOffset + ((normalAt(first, midpoint) + normalAt(second, midpoint)) / 2),
            lo: anchorAlong + localLo,
            hi: anchorAlong + localHi,
            lengthM: localHi - localLo
        };
    }

    /**
     * Parcels that share a boundary.
     *
     * @param {Array<{id: string, rings: Array<Array<[number, number]>>}>} parcels
     *        Every ring of every polygon, in metres — holes included. A parcel whose second polygon
     *        or hole is dropped loses the neighbours it has along it.
     * @param {object} [options] Overrides for DEFAULTS.
     * @returns {Array<{a: string, b: string, sharedM: number, spans: Array<object>}>} unordered
     *          pairs with their metric shared-boundary spans, longest shared boundary first.
     */
    function sharedBoundarySpans(parcels, options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const segments = segmentsOf(parcels, opts);

        // Bucket by ordinary XY bounds so only spatially plausible partners are compared. The old
        // (angle, normal offset, along) index repeated the same origin-sensitive offset mistake as
        // the comparison itself, which meant a correct pair could be discarded before it was even
        // measured. Expanded spatial bounds are translation invariant and still near-linear for
        // cadastral segments.
        const buckets = new Map();
        const fileUnder = (key, segment) => {
            let list = buckets.get(key);
            if (!list) { list = []; buckets.set(key, list); }
            list.push(segment);
        };
        segments.forEach(segment => {
            const padding = Math.max(0, Number(opts.offsetToleranceM) || 0);
            const cellM = Math.max(1, Number(opts.candidateCellM) || DEFAULTS.candidateCellM);
            const minX = Math.floor((Math.min(segment.p[0], segment.q[0]) - padding) / cellM);
            const maxX = Math.floor((Math.max(segment.p[0], segment.q[0]) + padding) / cellM);
            const minY = Math.floor((Math.min(segment.p[1], segment.q[1]) - padding) / cellM);
            const maxY = Math.floor((Math.max(segment.p[1], segment.q[1]) + padding) / cellM);
            for (let x = minX; x <= maxX; x += 1) {
                for (let y = minY; y <= maxY; y += 1) fileUnder(`${x}|${y}`, segment);
            }
        });

        const shared = new Map();
        const counted = new Set();
        const consider = (s1, s2) => {
            if (s1.id === s2.id) return;
            // A segment spanning several cells meets the same partner in each of them; count the
            // pair of segments once, not once per cell.
            const pairKey = s1.index < s2.index
                ? `${s1.index}#${s2.index}`
                : `${s2.index}#${s1.index}`;
            if (counted.has(pairKey)) return;
            counted.add(pairKey);
            const span = sharedSpan(s1, s2, opts);
            if (!span) return;
            const key = s1.id < s2.id ? `${s1.id}~${s2.id}` : `${s2.id}~${s1.id}`;
            let record = shared.get(key);
            if (!record) {
                const [a, b] = s1.id < s2.id ? [s1.id, s2.id] : [s2.id, s1.id];
                record = { a, b, sharedM: 0, spans: [] };
                shared.set(key, record);
            }
            record.sharedM += span.lengthM;
            // Keep the actual shared stretch as well as its length. Parcel adjacency answers the
            // geometric question "do these outlines run together?"; block topology has one extra
            // question: "does that shared stretch run THROUGH live road ground?". Returning metric
            // spans lets that higher layer answer without reimplementing this tolerant/T-junction-
            // safe matching algorithm.
            record.spans.push(span);
        };

        buckets.forEach(list => {
            for (let i = 0; i < list.length; i += 1) {
                for (let j = i + 1; j < list.length; j += 1) consider(list[i], list[j]);
            }
        });

        return Array.from(shared.values())
            .filter(record => record.sharedM >= opts.minSharedM)
            .sort((x, y) => (y.sharedM - x.sharedM) || x.a.localeCompare(y.a));
    }

    function neighborPairs(parcels, options) {
        return sharedBoundarySpans(parcels, options)
            .map(record => ({ a: record.a, b: record.b, sharedM: record.sharedM }));
    }

    const api = { DEFAULTS, neighborPairs, segmentsOf, sharedBoundarySpans };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__parcelAdjacency = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
