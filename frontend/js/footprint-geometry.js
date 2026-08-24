// Robust footprint geometry — sanitize / inset / union / chamfer of building-block polygons.
// Pure turf (read from the global): plain GeoJSON features in and out, no DOM, no map. Shared by
// building-blocks.js, row-house.js, single-building.js, parcel-based.js and proposals/geometry.js,
// so it lives in one tested module instead of being a pile of globals in building-blocks.js.

(function (global) {
    'use strict';
    // `turf` resolves to the runtime global (window.turf in the browser; the node test sets
    // global.turf) — captured at call time, not load, so a late turf load still works.
    const GEOM_BUFFER_STEPS = 16;
    const GEOM_EPSILON_M = 0.1; // small clean-up buffer in meters

    // Ensure polygon/multipolygon is simple, closed, proper winding and without duplicate points
    function sanitizePolygonFeature(inputFeature) {
        if (!inputFeature) return null;
        try {
            let feature = inputFeature;
            // Standardize ring winding: outer CCW, inner CW
            try { feature = turf.rewind(feature, { reverse: false }); } catch (_) { }
            // Remove consecutive duplicate coordinates
            try { feature = turf.cleanCoords(feature, { mutate: false }); } catch (_) { }
            // Split self-intersections into simple pieces
            try {
                const unkinked = turf.unkinkPolygon(feature);
                if (unkinked && unkinked.features && unkinked.features.length > 0) {
                    // Merge pieces via tiny buffer dissolve
                    let dissolved = null;
                    for (const f of unkinked.features) {
                        const fbuf = turf.buffer(f, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                        dissolved = dissolved ? (turf.union(dissolved, fbuf) || dissolved) : fbuf;
                    }
                    if (dissolved) {
                        // Remove the cleaning buffer
                        const unbuf = turf.buffer(dissolved, -GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                        if (unbuf) feature = unbuf;
                    }
                }
            } catch (_) { }
            return feature;
        } catch (e) {
            console.warn('sanitizePolygonFeature failed:', e);
            return inputFeature;
        }
    }

    // Robust negative buffer (inset). Performs incremental buffering in small steps to avoid topology collapses
    function robustNegativeBuffer(feature, targetInsetMeters) {
        const step = Math.max(0.5, Math.min(2, targetInsetMeters / 5)); // 0.5–2m steps
        let remaining = targetInsetMeters;
        let current = feature;
        while (remaining > 1e-6) {
            const d = Math.min(step, remaining);
            try {
                const next = turf.buffer(current, -d, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                if (!next || !next.geometry) return null;
                current = next;
                remaining -= d;
            } catch (e) {
                // Try tiny clean-up and retry once
                try {
                    const cleaned = turf.buffer(current, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                    const retried = turf.buffer(cleaned, -(d + GEOM_EPSILON_M), { units: 'meters', steps: GEOM_BUFFER_STEPS });
                    if (!retried || !retried.geometry) return null;
                    current = retried;
                    remaining -= d;
                } catch (_) {
                    return null;
                }
            }
        }
        return current;
    }

    // Union many polygons robustly with clean-up buffers
    function robustUnion(features) {
        if (!features || features.length === 0) return null;
        let acc = null;
        for (const raw of features) {
            const f = sanitizePolygonFeature(raw);
            if (!f) continue;
            try {
                const fb = turf.buffer(f, GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
                acc = acc ? (turf.union(acc, fb) || acc) : fb;
            } catch (e) {
                // As a fallback, skip this piece
                console.warn('robustUnion: skipping one piece due to error', e);
            }
        }
        if (!acc) return null;
        // Remove the dissolve buffer
        try {
            const unbuf = turf.buffer(acc, -GEOM_EPSILON_M, { units: 'meters', steps: GEOM_BUFFER_STEPS });
            if (unbuf) acc = unbuf;
        } catch (_) { }
        return acc;
    }

    // Select the largest-area Polygon from a Polygon or MultiPolygon feature
    function toSingleLargestPolygon(feature) {
        try {
            if (!feature || !feature.geometry) return null;
            if (feature.geometry.type === 'Polygon') return feature;
            if (feature.geometry.type !== 'MultiPolygon') return feature;
            const polys = feature.geometry.coordinates;
            let best = null;
            let bestArea = -Infinity;
            for (const rings of polys) {
                try {
                    const polyFeat = turf.polygon(rings);
                    const area = turf.area(polyFeat);
                    if (area > bestArea) {
                        bestArea = area;
                        best = rings;
                    }
                } catch (_) { }
            }
            if (!best) return null;
            return {
                type: 'Feature',
                properties: feature.properties || {},
                geometry: { type: 'Polygon', coordinates: best }
            };
        } catch (e) {
            console.warn('toSingleLargestPolygon failed:', e);
            return feature;
        }
    }

    // Vertices deviating less than this from the line between their kept neighbours are noise left
    // behind by the ±GEOM_EPSILON_M buffer dance, not geometry.
    const DECHATTER_TOL_M = 0.05;

    // Douglas–Peucker over an open chain of [x, y] points (planar metres).
    function rdpChain(pts, tol) {
        if (!Array.isArray(pts) || pts.length <= 2) return (pts || []).slice();
        const keep = new Array(pts.length).fill(false);
        keep[0] = keep[pts.length - 1] = true;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [s, e] = stack.pop();
            if (e - s < 2) continue;
            const [ax, ay] = pts[s];
            const [bx, by] = pts[e];
            const dx = bx - ax;
            const dy = by - ay;
            const len = Math.hypot(dx, dy);
            let worst = -1;
            let wi = -1;
            for (let i = s + 1; i < e; i++) {
                const d = len > 0
                    ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
                    : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
                if (d > worst) { worst = d; wi = i; }
            }
            if (worst > tol) {
                keep[wi] = true;
                stack.push([s, wi], [wi, e]);
            }
        }
        return pts.filter((_, i) => keep[i]);
    }

    // Douglas–Peucker for a closed ring (open form, no repeated first point): anchor on the vertex
    // farthest from v0 so both chains start and end on real geometry, simplify each, rejoin.
    function dechatterRing(openMeterRing, tol) {
        const n = Array.isArray(openMeterRing) ? openMeterRing.length : 0;
        if (n <= 4) return openMeterRing;
        let k = 1;
        let best = -1;
        for (let i = 1; i < n; i++) {
            const dx = openMeterRing[i][0] - openMeterRing[0][0];
            const dy = openMeterRing[i][1] - openMeterRing[0][1];
            const d = dx * dx + dy * dy;
            if (d > best) { best = d; k = i; }
        }
        const a = rdpChain(openMeterRing.slice(0, k + 1), tol);
        const b = rdpChain(openMeterRing.slice(k).concat([openMeterRing[0]]), tol);
        const out = a.slice(0, -1).concat(b.slice(0, -1));
        return out.length >= 3 ? out : openMeterRing;
    }

    // Chamfer (row-house style) applied selectively to sharp-ish vertices.
    // We chamfer vertices whose *internal* angle is <= maxInternalAngleDeg.
    function applySelectiveChamferToPolygonGeometry(geometry, chamferLengthMeters, maxInternalAngleDeg = 100) {
        if (!geometry || chamferLengthMeters <= 0) return geometry;

        const isValidRing = (ring) => Array.isArray(ring) && ring.length >= 4;
        const ensureRingClosed = (ring) => {
            if (!Array.isArray(ring) || ring.length === 0) return ring;
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (!last || first[0] !== last[0] || first[1] !== last[1]) {
                return ring.concat([[first[0], first[1]]]);
            }
            return ring;
        };

        const signedArea = (coords) => {
            if (!Array.isArray(coords) || coords.length < 3) return 0;
            let sum = 0;
            for (let i = 0; i < coords.length; i++) {
                const a = coords[i];
                const b = coords[(i + 1) % coords.length];
                sum += (a[0] * b[1]) - (b[0] * a[1]);
            }
            return sum / 2;
        };

        const chamferRing = (ring, centroidLngLat) => {
            if (!isValidRing(ring)) return ring;

            const [cLng, cLat] = centroidLngLat;
            const metersPerDegLng = 111320 * Math.cos(cLat * Math.PI / 180);
            const metersPerDegLat = 110540;

            const toMeters = ([lng, lat]) => [
                (lng - cLng) * metersPerDegLng,
                (lat - cLat) * metersPerDegLat
            ];
            const toDegrees = ([x, y]) => [
                x / metersPerDegLng + cLng,
                y / metersPerDegLat + cLat
            ];

            const openRing = ring.slice(0, -1);
            // De-chatter before looking for corners. The buffer/union pipeline leaves collinear
            // micro-vertex trains along straight walls (a 384-vertex ring for an 11-vertex parcel),
            // and the 0.4×edge chamfer cap then measures "edge length" to the first artifact vertex
            // instead of to the wall's real end — a corner with a stray vertex 5 m away got a 2 m
            // nick instead of the requested cut. Douglas–Peucker at 5 cm removes only vertices that
            // deviate less than that from the wall line, so the shape is untouched to the eye and
            // every real bend (and both facets of a split corner) survives for the pass below.
            const meterRing = dechatterRing(openRing.map(toMeters), DECHATTER_TOL_M);
            const n = meterRing.length;
            if (n < 3) return ring;

            const areaSign = signedArea(meterRing) >= 0 ? 1 : -1; // +1 CCW, -1 CW
            const chamferedRing = [];

            const edgeLen = (i) => {
                const a = meterRing[i];
                const b = meterRing[(i + 1) % n];
                return Math.hypot(b[0] - a[0], b[1] - a[1]);
            };
            const turnAt = (i) => {
                const prev = meterRing[(i - 1 + n) % n];
                const curr = meterRing[i];
                const next = meterRing[(i + 1) % n];
                const incoming = [curr[0] - prev[0], curr[1] - prev[1]];
                const outgoing = [next[0] - curr[0], next[1] - curr[1]];
                const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
                const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
                return Math.atan2(cross, dot);
            };
            const turnDegAbs = (i) => Math.abs(turnAt(i)) * 180 / Math.PI;
            // A vertex turning no harder than this is wall, not corner: the leg of a chamfer may
            // run straight past it. Complement of the chamferability threshold, so a vertex is
            // either a corner candidate or traversable, never both.
            const gentleDeg = 180 - maxInternalAngleDeg;

            // How much wall is available for a chamfer leg from `start` in direction dir (±1):
            // walk edge by edge THROUGH gentle bends, stopping at the first real corner or once
            // the wall has cumulatively curved past gentleDeg. Measuring only to the next VERTEX
            // was the bug behind visibly unequal corners on one ring: a 0.5° bend 16 m from one
            // corner capped its cut at 6.6 m while the twin corner 80 m away got the full 10 m.
            const runFrom = (start, dir, needed) => {
                let run = 0;
                let cum = 0;
                let i = start;
                for (let guard = 0; guard < n; guard++) {
                    run += dir > 0 ? edgeLen(i) : edgeLen((i - 1 + n) % n);
                    if (run >= needed) return run;
                    const next = (i + dir + n) % n;
                    const t = turnDegAbs(next);
                    if (t > gentleDeg || cum + t > gentleDeg) return run;
                    cum += t;
                    i = next;
                }
                return run;
            };

            // The point `dist` along the boundary from `start` in direction dir, plus the gentle
            // vertices the leg passes over — the diagonal replaces them.
            const pointAlong = (start, dir, dist) => {
                let remaining = dist;
                let i = start;
                const swallowed = [];
                for (let guard = 0; guard < n; guard++) {
                    const j = (i + dir + n) % n;
                    const a = meterRing[i];
                    const b = meterRing[j];
                    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                    if (remaining <= len && len > 0) {
                        const t = remaining / len;
                        return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], swallowed };
                    }
                    remaining -= len;
                    swallowed.push(j);
                    i = j;
                }
                return { point: [meterRing[start][0], meterRing[start][1]], swallowed: [] };
            };

            const consumed = new Array(n).fill(false);
            const cuts = new Map(); // corner entry index → [p1, p2]

            // Plan one corner cut spanning ring vertices first..last (equal for a single-vertex
            // corner). Legs are capped at 0.4× the available wall on each side, so two cuts on one
            // wall can never overlap, and a genuinely short edge (a notch step) is never consumed.
            const planCut = (first, last, members) => {
                const needed = chamferLengthMeters / 0.4;
                const runPrev = runFrom(first, -1, needed);
                const runNext = runFrom(last, 1, needed);
                const eff = Math.min(chamferLengthMeters, runPrev * 0.4, runNext * 0.4);
                if (eff < 0.001) return;
                const back = pointAlong(first, -1, eff);
                const fwd = pointAlong(last, 1, eff);
                members.forEach(v => { consumed[v] = true; });
                back.swallowed.forEach(v => { consumed[v] = true; });
                fwd.swallowed.forEach(v => { consumed[v] = true; });
                cuts.set(first, [back.point, fwd.point]);
            };

            const planVertex = (i) => {
                const internalDeg = 180 - areaSign * turnAt(i) * 180 / Math.PI;
                if (internalDeg <= maxInternalAngleDeg) planCut(i, i, [i]);
            };

            // A corner does not always arrive as one vertex: buffering, simplify and clipping leave
            // some corners as a CLUSTER of 2–3 vertices a few decimetres apart. Per-vertex chamfering
            // caps each cut at 0.4× the tiny glue edge, so exactly those corners came out looking
            // uncut ("chamfered 2 of 4"). Group vertices joined by glue edges (< glueMax) into
            // chains; a short chain whose cumulative turn still reads as one chamferable corner is
            // cut as ONE corner, anchored on the walls either side of it. Chains that turn too
            // little (a gentle curved front), too much (a spike, a U-tip) or span too far (a wide
            // rounded arc) fall back to the per-vertex behaviour unchanged.
            const glueMax = Math.min(chamferLengthMeters, 2.5);
            const isGlue = [];
            let glueCount = 0;
            for (let i = 0; i < n; i++) {
                isGlue[i] = edgeLen(i) < glueMax;
                if (isGlue[i]) glueCount++;
            }

            if (glueCount === 0 || glueCount === n) {
                // No clusters at all, or the whole ring is one (a tiny/densely digitised ring
                // where "cluster" has no meaning) — plain per-vertex pass.
                for (let i = 0; i < n; i++) planVertex(i);
            } else {
                const starts = [];
                for (let i = 0; i < n; i++) {
                    if (!isGlue[(i - 1 + n) % n]) starts.push(i);
                }
                starts.forEach(start => {
                    const chain = [start];
                    while (isGlue[chain[chain.length - 1]]) chain.push((chain[chain.length - 1] + 1) % n);
                    if (chain.length === 1) { planVertex(start); return; }

                    let totalTurn = 0;
                    let span = 0;
                    chain.forEach((v, k) => {
                        totalTurn += turnAt(v);
                        if (k < chain.length - 1) span += edgeLen(v);
                    });
                    const internalDeg = 180 - areaSign * totalTurn * 180 / Math.PI;
                    const collapse = internalDeg > 0 && internalDeg <= maxInternalAngleDeg
                        && span <= 2 * glueMax;
                    if (collapse) planCut(chain[0], chain[chain.length - 1], chain);
                    else chain.forEach(v => planVertex(v));
                });
            }

            for (let i = 0; i < n; i++) {
                const cut = cuts.get(i);
                if (cut) {
                    chamferedRing.push(cut[0]);
                    chamferedRing.push(cut[1]);
                    continue;
                }
                if (!consumed[i]) chamferedRing.push(meterRing[i]);
            }

            const degreesRing = chamferedRing.map(toDegrees);
            return ensureRingClosed(degreesRing);
        };

        const chamferPolygon = (rings) => {
            if (!Array.isArray(rings) || rings.length === 0) return rings;
            let centroidLngLat = null;
            try {
                const poly = turf.polygon(rings);
                const c = turf.centroid(poly);
                centroidLngLat = c && c.geometry && Array.isArray(c.geometry.coordinates) ? c.geometry.coordinates : null;
            } catch (_) { }
            if (!centroidLngLat) {
                try {
                    const p = rings[0] && rings[0][0] ? rings[0][0] : null;
                    centroidLngLat = p ? [p[0], p[1]] : [0, 0];
                } catch (_) { centroidLngLat = [0, 0]; }
            }
            return rings.map(ring => chamferRing(ensureRingClosed(ring), centroidLngLat));
        };

        if (geometry.type === 'Polygon') {
            return {
                type: 'Polygon',
                coordinates: chamferPolygon(geometry.coordinates)
            };
        }

        if (geometry.type === 'MultiPolygon') {
            return {
                type: 'MultiPolygon',
                coordinates: geometry.coordinates.map(polyRings => chamferPolygon(polyRings))
            };
        }

        return geometry;
    }

    function applySelectiveChamferToFeature(feature, chamferLengthMeters, maxInternalAngleDeg = 100) {
        if (!feature || !feature.geometry || chamferLengthMeters <= 0) return feature;
        const nextGeom = applySelectiveChamferToPolygonGeometry(feature.geometry, chamferLengthMeters, maxInternalAngleDeg);
        if (!nextGeom) return feature;
        const nextFeature = {
            type: 'Feature',
            properties: feature.properties ? { ...feature.properties } : {},
            geometry: nextGeom
        };
        try { return turf.rewind(nextFeature, { reverse: false }); } catch (_) { return nextFeature; }
    }

    // Compute minimum edge length (meters) for a polygon outer ring
    function computeMinEdgeLengthMeters(coords) {
        let minLen = Infinity;
        let minPair = null;
        if (!coords || coords.length < 2) return { minLen, minPair };
        for (let i = 0; i < coords.length - 1; i++) {
            const p1 = coords[i];
            const p2 = coords[i + 1];
            try {
                const d = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
                if (d < minLen) {
                    minLen = d;
                    minPair = [p1, p2];
                }
            } catch (_) { }
        }
        return { minLen, minPair };
    }

    // Incrementally inset a polygon by applying multiple small negative buffers
    function incrementalInsetPolygon(startFeature, targetInsetMeters, minEdgeMeters) {
        const result = {
            feature: null,
            achievedInset: 0,
            reason: 'ok', // ok | min_edge | invalid
            minEdgePair: null,
            minEdgeValue: null
        };
        if (!startFeature || targetInsetMeters <= 0) {
            result.feature = startFeature;
            return result;
        }

        const step = Math.max(0.25, Math.min(1.0, targetInsetMeters / 10));
        let remaining = targetInsetMeters;
        let current = toSingleLargestPolygon(startFeature) || startFeature;
        let lastValid = current;

        while (remaining > 1e-6) {
            const d = Math.min(step, remaining);
            let candidate = robustNegativeBuffer(current, d);
            candidate = toSingleLargestPolygon(candidate) || candidate;
            if (!candidate || !candidate.geometry || candidate.geometry.type !== 'Polygon') {
                result.reason = 'invalid';
                break;
            }
            const outer = candidate.geometry.coordinates[0];
            if (minEdgeMeters > 0) {
                const { minLen, minPair } = computeMinEdgeLengthMeters(outer);
                if (isFinite(minLen) && minLen < minEdgeMeters) {
                    result.reason = 'min_edge';
                    result.minEdgePair = minPair;
                    result.minEdgeValue = minLen;
                    break;
                }
            }
            // Accept this step
            lastValid = candidate;
            current = candidate;
            result.achievedInset += d;
            remaining -= d;
        }

        result.feature = lastValid;
        return result;
    }

    const api = {
            sanitizePolygonFeature,
            robustNegativeBuffer,
            robustUnion,
            toSingleLargestPolygon,
            applySelectiveChamferToPolygonGeometry,
            applySelectiveChamferToFeature,
            computeMinEdgeLengthMeters,
            incrementalInsetPolygon
    };

    if (typeof window !== 'undefined') {
        window.sanitizePolygonFeature = sanitizePolygonFeature;
        window.robustNegativeBuffer = robustNegativeBuffer;
        window.robustUnion = robustUnion;
        window.toSingleLargestPolygon = toSingleLargestPolygon;
        window.applySelectiveChamferToPolygonGeometry = applySelectiveChamferToPolygonGeometry;
        window.applySelectiveChamferToFeature = applySelectiveChamferToFeature;
        window.computeMinEdgeLengthMeters = computeMinEdgeLengthMeters;
        window.incrementalInsetPolygon = incrementalInsetPolygon;
        window.FootprintGeometry = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
