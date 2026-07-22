// Tells a genuine town square (a compact plaza) apart from a mere paved strip, so the square editor
// can nudge "this is not a square, it's a paved surface!" when the drawn boundary is a long thin
// ribbon rather than a plaza. Uses the Polsby–Popper compactness ratio (4π·area / perimeter²), which
// is 1 for a circle, ~0.785 for a perfect square and tends to 0 for a thin strip — rotation-
// invariant and unit-free. Pure turf read from the runtime global; plain GeoJSON in, verdict out.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SquareShape = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Below this compactness the shape reads as paving, not a plaza. A ~4:1 rectangle sits at ~0.50,
    // so 0.5 flags anything longer/thinner than that while leaving squares and rounded plazas alone.
    const DEFAULT_MIN_COMPACTNESS = 0.5;

    function getTurf() {
        return (typeof turf !== 'undefined') ? turf : (typeof window !== 'undefined' ? window.turf : null);
    }

    function outerRing(geometry) {
        const geom = (geometry && geometry.type === 'Feature') ? geometry.geometry : geometry;
        if (!geom || !geom.coordinates) return null;
        if (geom.type === 'Polygon') return geom.coordinates[0] || null;
        if (geom.type === 'MultiPolygon') {
            // Score the largest part; a paved surface is usually one blob anyway.
            let best = null;
            let bestLen = -1;
            (geom.coordinates || []).forEach(poly => {
                const ring = poly && poly[0];
                if (Array.isArray(ring) && ring.length > bestLen) { best = ring; bestLen = ring.length; }
            });
            return best;
        }
        return null;
    }

    function perimeterMeters(ring, t) {
        let total = 0;
        for (let i = 1; i < ring.length; i++) {
            total += t.distance(t.point(ring[i - 1]), t.point(ring[i]), { units: 'meters' });
        }
        return total;
    }

    // Returns { compactness, isSquareLike } or null when the geometry can't be assessed. Never throws;
    // an unassessable shape is treated as square-like (no warning) so the check can only ever advise.
    function assessSquareShape(geometry, options = {}) {
        const t = getTurf();
        const ring = outerRing(geometry);
        if (!t || !ring || ring.length < 4) return null;

        let area;
        let perimeter;
        try {
            const feature = (geometry.type === 'Feature') ? geometry : t.feature(geometry);
            area = t.area(feature);
            perimeter = perimeterMeters(ring, t);
        } catch (_) {
            return null;
        }
        if (!(area > 0) || !(perimeter > 0)) return null;

        const compactness = (4 * Math.PI * area) / (perimeter * perimeter);
        const minCompactness = Number.isFinite(options.minCompactness) ? options.minCompactness : DEFAULT_MIN_COMPACTNESS;
        return { compactness, isSquareLike: compactness >= minCompactness };
    }

    return { assessSquareShape, DEFAULT_MIN_COMPACTNESS };
});
