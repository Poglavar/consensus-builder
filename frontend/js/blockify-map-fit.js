// Whether the urban-rule editor's 2D map can be framed on its block yet — and whether the block it
// was handed is a block at all.
//
// The editor opening on a map of the WHOLE WORLD, with the block an orange speck near the equator,
// has exactly one cause. Measured against Leaflet 1.9, fitting a real 240 m × 900 m block:
//
//     panel 851×240 → zoom 14      panel 851×0 → zoom 19      panel 0×0 → zoom 19
//     bounds spanning the globe → zoom 0
//
// So a panel that has not been laid out does NOT produce the world view — it produces the opposite,
// a fit zoomed all the way in. The world view can only come from BOUNDS that span the world: one
// parcel of the block carrying a coordinate that is not a WGS84 degree, or a null-island (0, 0)
// vertex, which stretches the block's bounds from the Gulf of Guinea to Šibenik.
//
// Both are refused here, for different reasons: an unlaid-out panel because the fit should simply
// wait for the layout (and because a map created against a collapsed panel caches that size and
// Leaflet will not re-measure it until the map has a view — which puts every later click and
// dragged vertex at the wrong latlng), and impossible bounds because zooming to them is how the
// symptom happens.
//
// Pure: numbers in, a verdict out, no Leaflet and no DOM.

(function (global) {
    'use strict';

    // Below this the panel has not been laid out. 40 px is generous — the real failure is 0.
    const MIN_USABLE_PX = 40;
    // A city block is tens to hundreds of metres. Half a degree is ~55 km, so bounds this wide are
    // not a block: some parcel arrived carrying coordinates that are not WGS84 degrees, and fitting
    // to them is what produces a world map. Say so rather than zooming to it.
    const MAX_BLOCK_SPAN_DEG = 0.5;

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    /**
     * @param {object} input
     * @param {number} input.width   the CONTAINER's width in CSS pixels — never the map's own cached
     *                               size, which Leaflet refuses to re-measure until the map has a
     *                               view, and which is therefore stale in exactly the failing case
     * @param {number} input.height  the container's height in CSS pixels
     * @param {{west:number, south:number, east:number, north:number}} input.bounds
     * @returns {{ok: boolean, reason: string|null, spanDeg: number|null}}
     *          `reason` is 'not-laid-out' (try again after layout), 'no-bounds' (nothing to fit) or
     *          'span-too-large' (the geometry is wrong — a retry will not help).
     */
    function fitReadiness(input) {
        const width = input && input.width;
        const height = input && input.height;
        const bounds = input && input.bounds;

        if (!isFiniteNumber(width) || !isFiniteNumber(height) || width < MIN_USABLE_PX || height < MIN_USABLE_PX) {
            return { ok: false, reason: 'not-laid-out', spanDeg: null };
        }
        if (!bounds
            || !isFiniteNumber(bounds.west) || !isFiniteNumber(bounds.east)
            || !isFiniteNumber(bounds.south) || !isFiniteNumber(bounds.north)) {
            return { ok: false, reason: 'no-bounds', spanDeg: null };
        }
        const spanDeg = Math.max(Math.abs(bounds.east - bounds.west), Math.abs(bounds.north - bounds.south));
        if (!(spanDeg >= 0)) return { ok: false, reason: 'no-bounds', spanDeg: null };
        if (spanDeg > MAX_BLOCK_SPAN_DEG) return { ok: false, reason: 'span-too-large', spanDeg };
        return { ok: true, reason: null, spanDeg };
    }

    // A reason worth waiting out: the panel gets its size a frame or two later, but a block whose
    // geometry is wrong will still be wrong next frame.
    function shouldRetry(reason) {
        return reason === 'not-laid-out';
    }

    // Coordinates a parcel on Earth can actually have. A vertex at exactly (0, 0) is null island —
    // never a real parcel, and the single most effective way to stretch a block's bounds across the
    // Atlantic. Anything outside the WGS84 range is a coordinate system mix-up.
    function ringIsPlausible(coords) {
        if (!Array.isArray(coords)) return false;
        if (typeof coords[0] === 'number') {
            const x = coords[0];
            const y = coords[1];
            if (!isFiniteNumber(x) || !isFiniteNumber(y)) return false;
            if (x === 0 && y === 0) return false;
            return Math.abs(x) <= 180 && Math.abs(y) <= 90;
        }
        return coords.length > 0 && coords.every(ringIsPlausible);
    }

    /**
     * Split a block's features into the ones the map can be framed on and the ones it cannot.
     *
     * A block with one broken parcel used to take the whole editor to the world map. Drawing and
     * fitting the rest is strictly better: the editor is usable, and the caller has the rejected
     * ids to report rather than a mystery.
     *
     * @returns {{usable: Array, rejected: Array<{id: string|null, reason: string}>}}
     */
    function usableBlockFeatures(features) {
        const usable = [];
        const rejected = [];
        (Array.isArray(features) ? features : []).forEach((feature, index) => {
            const props = (feature && feature.properties) || {};
            const id = props.parcelId || props.PARCEL_ID || props.id || null;
            const label = id === null || id === undefined ? `#${index}` : String(id);
            const geometry = feature && feature.geometry;
            if (!geometry || !Array.isArray(geometry.coordinates) || !/Polygon$/.test(String(geometry.type || ''))) {
                rejected.push({ id: label, reason: 'no polygon geometry' });
                return;
            }
            if (!ringIsPlausible(geometry.coordinates)) {
                rejected.push({ id: label, reason: 'coordinates are not plausible WGS84 degrees' });
                return;
            }
            usable.push(feature);
        });
        return { usable, rejected };
    }

    const api = { MIN_USABLE_PX, MAX_BLOCK_SPAN_DEG, fitReadiness, shouldRetry, usableBlockFeatures };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__blockifyMapFit = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
