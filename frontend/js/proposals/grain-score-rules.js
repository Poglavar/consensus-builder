// Pure rules for the Institut za zrnatost plan score.
//
// This file deliberately knows nothing about Leaflet or the DOM. The browser game and the node
// tests use the same parcel measurement and scoring arithmetic, so a pretty card cannot quietly
// disagree with the methodology it describes.
(function (global) {
    'use strict';

    const EARTH_RADIUS_M = 6378137;
    const FINE_GRAIN_LIMIT_M = 10;
    const HAPPY_SCORE = 60;
    const ROOSTER_PECK = Object.freeze({ angleDeg: -35, dropPx: 7 });

    // SVG beak tip (28,79) in a 180×220 drawing, tilted about the body's 44%/76% pivot.
    // Position the contact pose, including mirroring, rather than the bird's bounding-box centre.
    function roosterPose({ target, width, height, facing = 1 }) {
        const angle = ROOSTER_PECK.angleDeg * Math.PI / 180;
        const pivot = { x: width * 0.44, y: height * 0.76 };
        const dx = width * 28 / 180 - pivot.x;
        const dy = height * 79 / 220 - pivot.y + ROOSTER_PECK.dropPx;
        const beak = {
            x: pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle),
            y: pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle)
        };
        return { x: target.x - (facing < 0 ? width - beak.x : beak.x), y: target.y - beak.y };
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function numeric(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return finite(number) ? number : null;
    }

    // Measure the supplied snapshot, never look a parcel up again in a changing live fabric.
    // Cadastral features are the explicit fallback for a resulting parcel the fabric has not
    // materialized.
    function measureParcelRows(resultingIds, materializedFeatures, cadastralFeatures = []) {
        const byId = new Map();
        [...cadastralFeatures, ...materializedFeatures].filter(Boolean).forEach(feature => {
            const id = feature.properties?.parcelId ?? feature.properties?.id;
            if (id != null) byId.set(String(id), feature);
        });
        return resultingIds.map(value => {
            const id = String(value);
            const feature = byId.get(id) || null;
            const dimensions = feature && parcelDimensionsMeters(feature);
            return { id, feature, ...(dimensions || { widthMeters: null, depthMeters: null }) };
        });
    }

    function coordinatesFromGeometry(input) {
        const geometry = input && input.type === 'Feature' ? input.geometry : input;
        if (!geometry || !Array.isArray(geometry.coordinates)) return [];
        if (geometry.type === 'Polygon') {
            return geometry.coordinates.flatMap(ring => Array.isArray(ring) ? ring : []);
        }
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.flatMap(polygon => (
                Array.isArray(polygon)
                    ? polygon.flatMap(ring => Array.isArray(ring) ? ring : [])
                    : []
            ));
        }
        return [];
    }

    function convexHull(points) {
        const sorted = [...points].sort((left, right) => (
            left[0] === right[0] ? left[1] - right[1] : left[0] - right[0]
        ));
        if (sorted.length <= 2) return sorted;
        const cross = (origin, a, b) => (
            (a[0] - origin[0]) * (b[1] - origin[1])
            - (a[1] - origin[1]) * (b[0] - origin[0])
        );
        const lower = [];
        sorted.forEach(point => {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
                lower.pop();
            }
            lower.push(point);
        });
        const upper = [];
        for (let i = sorted.length - 1; i >= 0; i -= 1) {
            const point = sorted[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
                upper.pop();
            }
            upper.push(point);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    // The threshold must not depend on whether north happens to point along the parcel. Project the
    // small lon/lat footprint to local metres, then test the bounding box at every polygon-edge
    // angle. A minimum-area rectangle is aligned with an edge of the convex hull. Building that hull
    // first matters for concave cadastral parcels, where a hull edge can bridge several boundary edges.
    function parcelDimensionsMeters(input) {
        const raw = coordinatesFromGeometry(input)
            .filter(point => Array.isArray(point) && numeric(point[0]) !== null && numeric(point[1]) !== null)
            .map(point => [numeric(point[0]), numeric(point[1])]);
        if (raw.length < 3) return null;

        const unique = [];
        const seen = new Set();
        raw.forEach(([lon, lat]) => {
            const key = `${lon.toFixed(12)},${lat.toFixed(12)}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push([lon, lat]);
            }
        });
        if (unique.length < 3) return null;

        const lat0 = unique.reduce((sum, point) => sum + point[1], 0) / unique.length;
        const cosLat = Math.cos((lat0 * Math.PI) / 180);
        const points = unique.map(([lon, lat]) => [
            EARTH_RADIUS_M * (lon * Math.PI / 180) * cosLat,
            EARTH_RADIUS_M * (lat * Math.PI / 180)
        ]);
        const hull = convexHull(points);
        if (hull.length < 3) return null;

        let best = null;
        for (let i = 0; i < hull.length; i += 1) {
            const current = hull[i];
            const next = hull[(i + 1) % hull.length];
            const dx = next[0] - current[0];
            const dy = next[1] - current[1];
            if (Math.hypot(dx, dy) < 1e-6) continue;
            const angle = Math.atan2(dy, dx);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            let minAlong = Infinity;
            let maxAlong = -Infinity;
            let minAcross = Infinity;
            let maxAcross = -Infinity;

            points.forEach(([x, y]) => {
                const along = x * cos + y * sin;
                const across = -x * sin + y * cos;
                minAlong = Math.min(minAlong, along);
                maxAlong = Math.max(maxAlong, along);
                minAcross = Math.min(minAcross, across);
                maxAcross = Math.max(maxAcross, across);
            });

            const a = Math.max(0, maxAlong - minAlong);
            const b = Math.max(0, maxAcross - minAcross);
            const area = a * b;
            if (!best || area < best.area) best = { a, b, area };
        }

        if (!best || !finite(best.a) || !finite(best.b)) return null;
        return {
            widthMeters: Math.min(best.a, best.b),
            depthMeters: Math.max(best.a, best.b)
        };
    }

    function isFineGrainParcel(parcel) {
        const width = numeric(parcel && parcel.widthMeters);
        const depth = numeric(parcel && (parcel.depthMeters ?? parcel.heightMeters));
        return width !== null && depth !== null
            && width < FINE_GRAIN_LIMIT_M
            && depth < FINE_GRAIN_LIMIT_M;
    }

    function startingParcelIds(fabric) {
        const produced = new Set((fabric && fabric.produced || []).map(String));
        const starting = new Set([
            ...(fabric && fabric.consumed || []),
            ...(fabric && fabric.builtOn || [])
        ].map(String));
        produced.forEach(id => starting.delete(id));
        return [...starting];
    }

    function scoreParcelCount(beforeCount, afterCount) {
        if (!Number.isInteger(beforeCount) || beforeCount < 0) {
            throw new TypeError('beforeCount must be a non-negative integer');
        }
        if (!Number.isInteger(afterCount) || afterCount < 0) {
            throw new TypeError('afterCount must be a non-negative integer');
        }
        const delta = afterCount - beforeCount;
        if (delta > 0) return { score: 100, delta, direction: 'increase' };
        if (delta < 0) return { score: 0, delta, direction: 'decrease' };
        return { score: 50, delta, direction: 'unchanged' };
    }

    function verdictKey(score) {
        if (!finite(score)) return 'unavailable';
        if (score >= 80) return 'fine';
        if (score >= HAPPY_SCORE) return 'good';
        if (score >= 40) return 'mixed';
        return 'coarse';
    }

    // Grain is a binding metric: a plan that binds no cadastral parcel (every proposal on open
    // ground) has no starting or resulting parcels to score. Every figure is null, not 0 — a count
    // score of 50 for "0 → 0, unchanged" would read like a measured result.
    function noParcelsScore() {
        return {
            totalScore: null,
            verdict: verdictKey(null),
            parcelCount: null,
            noParcels: true,
            fineGrain: { score: null, eaten: null, measured: null, total: null, missing: null, eatenParcelIds: [] }
        };
    }

    function scorePlan({ beforeParcelCount, afterParcelCount, parcels, bound }) {
        if (!Array.isArray(parcels)) throw new TypeError('parcels must be an array');
        if (bound === false || (beforeParcelCount === 0 && afterParcelCount === 0)) return noParcelsScore();
        const measured = parcels.filter(parcel => (
            numeric(parcel && parcel.widthMeters) !== null
            && numeric(parcel && (parcel.depthMeters ?? parcel.heightMeters)) !== null
        ));
        const eatenParcelIds = measured.filter(isFineGrainParcel).map(parcel => String(parcel.id));
        const fineScore = measured.length
            ? Math.round((eatenParcelIds.length / measured.length) * 100)
            : null;
        const parcelCount = scoreParcelCount(beforeParcelCount, afterParcelCount);
        const totalScore = fineScore === null ? null : Math.round((parcelCount.score + fineScore) / 2);

        return {
            totalScore,
            verdict: verdictKey(totalScore),
            parcelCount,
            fineGrain: {
                score: fineScore,
                eaten: eatenParcelIds.length,
                measured: measured.length,
                total: afterParcelCount,
                missing: Math.max(0, afterParcelCount - measured.length),
                eatenParcelIds
            }
        };
    }

    const api = {
        FINE_GRAIN_LIMIT_M,
        HAPPY_SCORE,
        ROOSTER_PECK,
        roosterPose,
        measureParcelRows,
        parcelDimensionsMeters,
        isFineGrainParcel,
        startingParcelIds,
        scoreParcelCount,
        scorePlan,
        verdictKey
    };

    if (typeof window !== 'undefined') window.GrainScoreRules = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
