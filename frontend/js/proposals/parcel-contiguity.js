// A parcel is one connected piece of ground. A cut that yields two disconnected areas yields two
// parcels, never one parcel in two places: a non-contiguous parcel cannot be owned, transferred,
// built on or reasoned about as a unit, and it breaks every "which parcel is under this point"
// answer. Enforced where parcels are minted, so no path can create one.
// Pure: GeoJSON in, GeoJSON out. Holes are NOT a split — a polygon with a hole is still one piece.
(function (global) {
    'use strict';

    function geometryOf(feature) {
        if (!feature) return null;
        return feature.type === 'Feature' ? feature.geometry : feature;
    }

    // How many disconnected pieces this geometry has. 0 when it is not a polygon at all.
    function partCount(feature) {
        const geometry = geometryOf(feature);
        if (!geometry) return 0;
        if (geometry.type === 'Polygon') return 1;
        if (geometry.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates.length : 0;
        return 0;
    }

    function isContiguous(feature) {
        return partCount(feature) === 1;
    }

    // One feature per connected piece, properties carried across (the caller re-stamps identity,
    // so ids are NOT copied — leaving two parcels sharing one id is exactly the bug this prevents).
    // `opts.areaOf` (optional) drops pieces below `opts.minAreaM2`: cutting throws off slivers of a
    // few cm² that are not parcels by any sane reading, and they would each take an id.
    function explodeToContiguousParts(feature, opts) {
        const options = opts || {};
        const geometry = geometryOf(feature);
        const count = partCount(feature);
        if (count === 0) return [];
        if (count === 1) return [feature];

        const source = feature.type === 'Feature' ? feature : { type: 'Feature', properties: {}, geometry };
        const minArea = Number.isFinite(options.minAreaM2) ? options.minAreaM2 : 0;
        const areaOf = typeof options.areaOf === 'function' ? options.areaOf : null;

        const parts = [];
        geometry.coordinates.forEach(rings => {
            const part = {
                type: 'Feature',
                properties: Object.assign({}, source.properties || {}),
                geometry: { type: 'Polygon', coordinates: rings }
            };
            // Identity belongs to the mint step that runs after this; carrying the parent's id
            // would hand the same name to several parcels.
            delete part.properties.parcelId;
            delete part.properties.parcel_id;
            delete part.properties.id;
            delete part.properties.BROJ_CESTICE;
            delete part.properties.syntheticIndex;
            if (minArea > 0 && areaOf) {
                let area = 0;
                try { area = areaOf(part) || 0; } catch (_) { area = 0; }
                if (area < minArea) return;
            }
            parts.push(part);
        });
        // Everything was sub-threshold: keep the largest piece rather than mint nothing at all.
        if (!parts.length && areaOf) {
            let best = null;
            let bestArea = -1;
            geometry.coordinates.forEach(rings => {
                const part = {
                    type: 'Feature',
                    properties: Object.assign({}, source.properties || {}),
                    geometry: { type: 'Polygon', coordinates: rings }
                };
                let area = 0;
                try { area = areaOf(part) || 0; } catch (_) { area = 0; }
                if (area > bestArea) { bestArea = area; best = part; }
            });
            return best ? [best] : [];
        }
        return parts;
    }

    // Expand a list of about-to-be-minted child features so every entry is one connected piece.
    function explodeAll(features, opts) {
        const list = Array.isArray(features) ? features : [];
        const out = [];
        list.forEach(feature => {
            if (!feature) return;
            if (partCount(feature) <= 1) { out.push(feature); return; }
            explodeToContiguousParts(feature, opts).forEach(part => out.push(part));
        });
        return out;
    }

    const api = { partCount, isContiguous, explodeToContiguousParts, explodeAll };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__parcelContiguity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
