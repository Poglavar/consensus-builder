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
            const meterRing = openRing.map(toMeters);
            const n = meterRing.length;
            if (n < 3) return ring;

            const areaSign = signedArea(meterRing) >= 0 ? 1 : -1; // +1 CCW, -1 CW
            const chamferedRing = [];

            for (let i = 0; i < n; i++) {
                const prev = meterRing[(i - 1 + n) % n];
                const curr = meterRing[i];
                const next = meterRing[(i + 1) % n];

                const toPrev = [prev[0] - curr[0], prev[1] - curr[1]];
                const toNext = [next[0] - curr[0], next[1] - curr[1]];
                const lenToPrev = Math.sqrt(toPrev[0] * toPrev[0] + toPrev[1] * toPrev[1]);
                const lenToNext = Math.sqrt(toNext[0] * toNext[0] + toNext[1] * toNext[1]);

                if (lenToPrev < 0.001 || lenToNext < 0.001) {
                    chamferedRing.push(curr);
                    continue;
                }

                const incoming = [curr[0] - prev[0], curr[1] - prev[1]];
                const outgoing = [next[0] - curr[0], next[1] - curr[1]];
                const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
                const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
                const turn = Math.atan2(cross, dot);
                const internal = Math.PI - areaSign * turn;
                const internalDeg = internal * 180 / Math.PI;

                // Same cap as row-house chamfer to avoid destroying small edges
                const effectiveChamfer = Math.min(chamferLengthMeters, lenToPrev * 0.4, lenToNext * 0.4);

                if (!(internalDeg <= maxInternalAngleDeg) || effectiveChamfer < 0.001) {
                    chamferedRing.push(curr);
                    continue;
                }

                const normPrev = [toPrev[0] / lenToPrev, toPrev[1] / lenToPrev];
                const normNext = [toNext[0] / lenToNext, toNext[1] / lenToNext];

                const p1 = [
                    curr[0] + normPrev[0] * effectiveChamfer,
                    curr[1] + normPrev[1] * effectiveChamfer
                ];

                const p2 = [
                    curr[0] + normNext[0] * effectiveChamfer,
                    curr[1] + normNext[1] * effectiveChamfer
                ];

                chamferedRing.push(p1);
                chamferedRing.push(p2);
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
