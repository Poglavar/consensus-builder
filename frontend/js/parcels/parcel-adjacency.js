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
        // Only segments in the same stretch of a line are compared, so two parcels at opposite ends
        // of a long straight street are never mistaken for neighbours.
        alongCellM: 25
    };

    // A segment as (line, extent): the line in normal form (θ, d) with θ in [0, π), and the extent
    // as the two endpoints projected onto the line's direction. Splitting a boundary changes the
    // extent and leaves the line alone, which is what makes this immune to how it was split.
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
                    const ux = Math.cos(theta);
                    const uy = Math.sin(theta);
                    const a = ux * p[0] + uy * p[1];
                    const b = ux * q[0] + uy * q[1];
                    segments.push({
                        index: segments.length,
                        id,
                        theta,
                        offset: -uy * p[0] + ux * p[1],
                        lo: Math.min(a, b),
                        hi: Math.max(a, b)
                    });
                }
            });
        });
        return segments;
    }

    // θ wraps: a boundary stored one way round is θ, the other way round is θ ± π, and they are the
    // same line.
    function sameLine(s1, s2, opts) {
        const dt = Math.abs(s1.theta - s2.theta);
        if (dt > opts.angleToleranceRad && Math.abs(dt - Math.PI) > opts.angleToleranceRad) return false;
        return Math.abs(s1.offset - s2.offset) <= opts.offsetToleranceM;
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

        // Bucket by (line, stretch of that line) so only plausible partners are ever compared. A
        // segment longer than a cell is filed in every cell it spans.
        const buckets = new Map();
        const fileUnder = (key, segment) => {
            let list = buckets.get(key);
            if (!list) { list = []; buckets.set(key, list); }
            list.push(segment);
        };
        segments.forEach(segment => {
            const t = Math.round(segment.theta / opts.angleToleranceRad);
            const d = Math.round(segment.offset / opts.offsetToleranceM);
            const from = Math.floor(segment.lo / opts.alongCellM);
            const to = Math.floor(segment.hi / opts.alongCellM);
            for (let cell = from; cell <= to; cell += 1) fileUnder(`${t}|${d}|${cell}`, segment);
        });

        const shared = new Map();
        const counted = new Set();
        const consider = (s1, s2) => {
            if (s1.id === s2.id) return;
            if (!sameLine(s1, s2, opts)) return;
            const overlap = Math.min(s1.hi, s2.hi) - Math.max(s1.lo, s2.lo);
            if (!(overlap > 0)) return;
            // A segment spanning several cells meets the same partner in each of them; count the
            // pair of segments once, not once per cell.
            const pairKey = s1.index < s2.index
                ? `${s1.index}#${s2.index}`
                : `${s2.index}#${s1.index}`;
            if (counted.has(pairKey)) return;
            counted.add(pairKey);
            const key = s1.id < s2.id ? `${s1.id}~${s2.id}` : `${s2.id}~${s1.id}`;
            let record = shared.get(key);
            if (!record) {
                const [a, b] = s1.id < s2.id ? [s1.id, s2.id] : [s2.id, s1.id];
                record = { a, b, sharedM: 0, spans: [] };
                shared.set(key, record);
            }
            record.sharedM += overlap;
            // Keep the actual shared stretch as well as its length. Parcel adjacency answers the
            // geometric question "do these outlines run together?"; block topology has one extra
            // question: "does that shared stretch run THROUGH live road ground?". Returning metric
            // spans lets that higher layer answer without reimplementing this tolerant/T-junction-
            // safe matching algorithm.
            record.spans.push({
                theta: s1.theta,
                offset: (s1.offset + s2.offset) / 2,
                lo: Math.max(s1.lo, s2.lo),
                hi: Math.min(s1.hi, s2.hi),
                lengthM: overlap
            });
        };

        buckets.forEach((list, key) => {
            for (let i = 0; i < list.length; i += 1) {
                for (let j = i + 1; j < list.length; j += 1) consider(list[i], list[j]);
            }
            // Neighbouring buckets, forward only, so each unordered pair of buckets is visited once.
            const [t, d, cell] = key.split('|').map(Number);
            for (let dt = -1; dt <= 1; dt += 1) {
                for (let dd = -1; dd <= 1; dd += 1) {
                    for (let dc = -1; dc <= 1; dc += 1) {
                        if (dt === 0 && dd === 0 && dc === 0) continue;
                        if (!(dt > 0 || (dt === 0 && (dd > 0 || (dd === 0 && dc > 0))))) continue;
                        const other = buckets.get(`${t + dt}|${d + dd}|${cell + dc}`);
                        if (!other) continue;
                        list.forEach(s1 => other.forEach(s2 => consider(s1, s2)));
                    }
                }
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
