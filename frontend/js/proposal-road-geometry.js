// Parcel-geometry helpers (ring closure, merging, area, hashing) extracted verbatim from
// proposal-manager.js. Still browser globals (classic script, no IIFE); other files call these by
// bare name. Corridor construction lives in corridor-footprint.js (projections.md §3).

function _extractPolygonsWithHolesFromGeometry(geometry) {
    if (!geometry || !geometry.type) return [];
    if (geometry.type === 'Polygon') {
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        return coords.length ? [{ outer: coords[0] || [], holes: coords.slice(1) }] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const polys = [];
        (geometry.coordinates || []).forEach(poly => {
            if (Array.isArray(poly) && poly.length) {
                polys.push({ outer: poly[0] || [], holes: poly.slice(1) });
            }
        });
        return polys;
    }
    return [];
}

function _ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        const newCoords = [...coords];
        newCoords.push([...first]);
        return newCoords;
    }
    return coords;
}

// _buildOffsetRoadPolygon was a dead, diverged copy of road-drawing.js's (also dead) offset
// builder — removed. The footprint comes from _createRectangularRoadSegment + union.

function _ensureClosedRing(ring = []) {
    if (!Array.isArray(ring)) return null;
    const filtered = ring
        .map(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return null;
            const lng = Number(pair[0]);
            const lat = Number(pair[1]);
            return (Number.isFinite(lng) && Number.isFinite(lat)) ? [lng, lat] : null;
        })
        .filter(Boolean);
    if (filtered.length < 3) return null;

    const first = filtered[0];
    const last = filtered[filtered.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        filtered.push([first[0], first[1]]);
    }

    return filtered.length >= 4 ? filtered : null;
}

function _mergeParcelGeometries(features = []) {
    if (!Array.isArray(features) || typeof turf === 'undefined') return null;

    const normalizePolygon = (rings) => {
        if (!Array.isArray(rings)) return null;
        const normalized = rings.map(_ensureClosedRing).filter(Boolean);
        return normalized.length ? normalized : null;
    };

    const polygons = [];
    features.forEach(feature => {
        const geometry = feature?.geometry;
        if (!geometry) return;
        if (geometry.type === 'Polygon') {
            const normalized = normalizePolygon(geometry.coordinates);
            if (normalized) polygons.push(normalized);
        } else if (geometry.type === 'MultiPolygon') {
            (geometry.coordinates || []).forEach(poly => {
                const normalized = normalizePolygon(poly);
                if (normalized) polygons.push(normalized);
            });
        }
    });

    if (!polygons.length) return null;

    let merged;
    try {
        merged = turf.polygon(polygons[0]);
    } catch (err) {
        console.warn('[_mergeParcelGeometries] Failed to initialise polygon', err);
        return null;
    }

    for (let i = 1; i < polygons.length; i++) {
        try {
            merged = turf.union(merged, turf.polygon(polygons[i]));
        } catch (err) {
            console.warn('[_mergeParcelGeometries] Failed to union polygons', err);
            return null;
        }
    }

    return merged?.geometry || null;
}

function _calculateGeoJsonArea(geometry) {
    if (!geometry || typeof turf === 'undefined') return 0;
    try {
        const area = turf.area(geometry);
        return Number.isFinite(area) ? area : 0;
    } catch (_) {
        return 0;
    }
}

function _geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}
