// Road-polygon and geometry math helpers extracted verbatim from proposal-manager.js.
// Still browser globals (classic script, no IIFE); other files call these by bare name.

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

function _getParcelOuterRingsLngLat(feature) {
    const rings = [];
    try {
        const geom = feature.geometry;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = _ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = _ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        }
    } catch (_) { }
    return rings;
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

function _polygonHasSelfIntersection(latLngPolygon) {
    if (!Array.isArray(latLngPolygon) || latLngPolygon.length < 4) return false;

    // Planar self-intersection check on the ring edges (more reliable than Turf validity heuristics).
    const pts = [];
    const EPS = 1e-6;

    for (const p of latLngPolygon) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lng)) continue;
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (!Array.isArray(xy) || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
            const next = { x: xy[0], y: xy[1] };
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.hypot(next.x - prev.x, next.y - prev.y) < EPS) {
                    continue;
                }
            }
            pts.push(next);
        } catch (_) {
            return false;
        }
    }

    if (pts.length < 4) return false;

    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > EPS) {
        pts.push({ x: first.x, y: first.y });
    }

    const segCount = pts.length - 1;
    if (segCount < 3) return false;

    const orient = (a, b, c) => {
        const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(val) < 1e-9) return 0;
        return val > 0 ? 1 : 2;
    };

    const onSegment = (a, b, c) => {
        return b.x <= Math.max(a.x, c.x) + 1e-9 && b.x + 1e-9 >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + 1e-9 && b.y + 1e-9 >= Math.min(a.y, c.y);
    };

    const segmentsIntersect = (p1, q1, p2, q2) => {
        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        return false;
    };

    for (let i = 0; i < segCount; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = i + 1; j < segCount; j++) {
            if (j === i + 1) continue;
            if (i === 0 && j === segCount - 1) continue;
            const c = pts[j];
            const d = pts[j + 1];
            if (segmentsIntersect(a, b, c, d)) return true;
        }
    }

    return false;
}

function _isValidPolygonLatLngs(latLngs) {
    if (!Array.isArray(latLngs) || latLngs.length === 0) return false;
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    if (isLatLng(latLngs[0])) {
        return latLngs.length >= 3;
    }
    if (Array.isArray(latLngs[0]) && latLngs[0].length && isLatLng(latLngs[0][0])) {
        return latLngs[0].length >= 3;
    }
    if (Array.isArray(latLngs[0]) && Array.isArray(latLngs[0][0]) && latLngs[0][0].length && isLatLng(latLngs[0][0][0])) {
        return latLngs.some(poly => Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0]) && poly[0].length >= 3);
    }
    return false;
}

function _polylineHasSelfIntersection(latLngPoints) {
    if (!Array.isArray(latLngPoints) || latLngPoints.length < 4) return false;

    const pts = [];
    const EPS = 1e-9;
    for (const p of latLngPoints) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return false;
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (!Array.isArray(xy) || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) return false;
            const next = { x: xy[0], y: xy[1] };
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.hypot(next.x - prev.x, next.y - prev.y) < EPS) continue;
            }
            pts.push(next);
        } catch (_) {
            return false;
        }
    }

    if (pts.length < 4) return false;

    const orient = (a, b, c) => {
        const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(val) < EPS) return 0;
        return val > 0 ? 1 : 2;
    };

    const onSegment = (a, b, c) => {
        return b.x <= Math.max(a.x, c.x) + EPS && b.x + EPS >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + EPS && b.y + EPS >= Math.min(a.y, c.y);
    };

    const segmentsIntersect = (p1, q1, p2, q2) => {
        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        return false;
    };

    // Segment i is pts[i] -> pts[i+1]
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = i + 2; j < pts.length - 1; j++) {
            // Skip adjacent segments
            if (j === i + 1) continue;
            const c = pts[j];
            const d = pts[j + 1];
            if (segmentsIntersect(a, b, c, d)) return true;
        }
    }

    return false;
}

function _calculateRoadPolygonFromBuffer(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        return null;
    }

    if (typeof turf === 'undefined' || !turf || typeof turf.lineString !== 'function' || typeof turf.buffer !== 'function') {
        return null;
    }

    try {
        const lineCoords = points.map(p => [p.lng, p.lat]);
        const centerline = turf.lineString(lineCoords);
        const halfWidth = width / 2;

        const buffered = turf.buffer(centerline, halfWidth, {
            units: 'meters',
            steps: 16
        });

        if (!buffered || !buffered.geometry) return null;

        let coords;
        if (buffered.geometry.type === 'Polygon') {
            coords = buffered.geometry.coordinates[0];
        } else if (buffered.geometry.type === 'MultiPolygon') {
            let maxArea = 0;
            let largestCoords = null;
            for (const poly of buffered.geometry.coordinates) {
                try {
                    const polyFeature = turf.polygon([poly[0]]);
                    const area = turf.area(polyFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly[0];
                    }
                } catch (_) { }
            }
            coords = largestCoords;
        } else {
            return null;
        }

        if (!coords || coords.length < 4) return null;
        return coords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.warn('Failed to calculate road polygon from buffer', error);
        return null;
    }
}

function _calculateRoadPolygon(points, width) {
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    // Normalize into an array of centerline segments so we can support multi-segment roads.
    const segments = [];
    if (Array.isArray(points)) {
        if (points.length && isLatLng(points[0])) {
            segments.push(points);
        } else if (points.length && Array.isArray(points[0])) {
            points.forEach(seg => {
                if (Array.isArray(seg) && seg.length >= 2 && isLatLng(seg[0])) {
                    segments.push(seg);
                }
            });
        }
    }

    if (!segments.length || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: Array.isArray(points) ? points.length : undefined, width });
        return null;
    }

    let combined = null;
    for (const segment of segments) {
        if (!Array.isArray(segment) || segment.length < 2) continue;
        const poly = _calculateRoadPolygonRectangular(segment, width);
        if (!poly) continue;
        combined = combined ? (_combineRoadPolygons(combined, poly) || combined) : poly;
    }

    return combined;
}

function _calculateRoadPolygonRectangular(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygonRectangular:', { pointsLength: points?.length, width });
        return null;
    }

    if (points.length === 2) {
        return _createRectangularRoadSegment(points[0], points[1], width);
    }

    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = _createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            combinedPolygon = _combineRoadPolygons(combinedPolygon, segment);
        }

        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }

        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = _createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = _combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

// _buildOffsetRoadPolygon was a dead, diverged copy of road-drawing.js's (also dead) offset
// builder — removed. The footprint comes from _createRectangularRoadSegment + union.

// _createRectangularRoadSegment was a second, DIVERGED copy of road-drawing.js's function. Both are
// now the shared, deterministic one in frontend/js/corridor-geometry.js. Keep the thin alias so the
// two call sites below are unchanged.
function _createRectangularRoadSegment(point1, point2, width) {
    return window.createRectangularRoadSegment(point1, point2, width);
}

function _createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!_isValidPoint(p0) || !_isValidPoint(pj) || !_isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]];
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]];

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0;

    const halfWidth = width / 2;

    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    // Bevel join patch (matches road-drawing.js behavior):
    // Use an interior anchor so only the bevel edge pA->pB can remain on the outer boundary.
    const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
    const bisLen = Math.hypot(bisector[0], bisector[1]);
    if (bisLen < 1e-8) {
        return null;
    }
    const inward = [-bisector[0] / bisLen, -bisector[1] / bisLen];
    const innerAnchor = [pj[0] + inward[0] * (halfWidth * 0.25), pj[1] + inward[1] * (halfWidth * 0.25)];

    const wedgeHTRS = [pA, pB, innerAnchor, pA];

    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

function _combineRoadPolygons(polygon1, polygon2) {
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

    // Prefer the shared implementation from road-drawing.js when available — it has a
    // multi-step fallback ladder (raw union → cleanCoords union → truncate union) that
    // recovers from JSTS topology side-location failures on rectangular road segments.
    // Without this, the first failing union returns one of the two input polygons and
    // the corridor ends up missing every segment after that, which means most parents
    // are never tested for intersection by turf.difference and very few descendants
    // get rebuilt.
    if (typeof window !== 'undefined' && typeof window.combineRoadPolygons === 'function') {
        try {
            const merged = window.combineRoadPolygons(polygon1, polygon2);
            if (merged) return merged;
        } catch (_) { /* fall through to local union */ }
    }

    try {
        if (typeof turf === 'undefined' || !turf || typeof turf.union !== 'function') {
            return polygon2 || polygon1;
        }

        // Union in local planar meters (HTRS) for robustness (see road-drawing.js rationale).
        const toHTRS = (p) => {
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
            if (typeof wgs84ToHTRS96 !== 'function') return null;
            try {
                const xy = wgs84ToHTRS96(p.lat, p.lng);
                return (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) ? xy : null;
            } catch (_) {
                return null;
            }
        };

        const fromHTRS = (coord) => {
            if (!Array.isArray(coord) || coord.length < 2) return null;
            const x = Number(coord[0]);
            const y = Number(coord[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            if (typeof htrs96ToWGS84 !== 'function') return null;
            try {
                const out = htrs96ToWGS84(x, y);
                if (!Array.isArray(out) || out.length < 2) return null;
                const lat = Number(out[0]);
                const lng = Number(out[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return L.latLng(lat, lng);
            } catch (_) {
                return null;
            }
        };

        if (typeof wgs84ToHTRS96 !== 'function' || typeof htrs96ToWGS84 !== 'function') {
            return polygon2 || polygon1;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

        const toClosedLngLatRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(toHTRS)
                .filter(Boolean);
            const closed = _ensurePolygonIsClosed(coords);
            return Array.isArray(closed) && closed.length >= 4 ? closed : null;
        };

        const toTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;

            // LatLng[]
            if (isLatLng(poly[0])) {
                const ring = toClosedLngLatRing(poly);
                return ring ? turf.polygon([ring]) : null;
            }

            // LatLng[][]
            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly.map(toClosedLngLatRing).filter(Boolean);
                return rings.length ? turf.polygon(rings) : null;
            }

            // LatLng[][][]
            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(toClosedLngLatRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                return polys.length ? turf.multiPolygon(polys) : null;
            }

            return null;
        };

        const feature1 = toTurfFeature(polygon1);
        const feature2 = toTurfFeature(polygon2);
        if (!feature1 && feature2) return polygon2;
        if (feature1 && !feature2) return polygon1;
        if (!feature1 || !feature2) return null;

        // Layered union: raw → cleanCoords → truncate. JSTS occasionally fails with
        // "Unable to complete output ring" on adjacent rectangular road segments because
        // of duplicate or near-duplicate vertices; cleanCoords removes those, and truncate
        // snaps coordinates to a centimetre grid which heals topology-side-location errors.
        // Without this ladder, a single failing union loses the rest of the corridor and
        // most parents never get cut by the road.
        const tryUnion = (a, b) => turf.union(a, b);
        let combined = null;
        const unionAttempts = [
            () => tryUnion(feature1, feature2),
            () => {
                if (typeof turf.cleanCoords !== 'function') return null;
                const f1 = turf.cleanCoords(feature1, { mutate: false }) || feature1;
                const f2 = turf.cleanCoords(feature2, { mutate: false }) || feature2;
                return tryUnion(f1, f2);
            },
            () => {
                if (typeof turf.truncate !== 'function') return null;
                const f1 = turf.truncate(feature1, { precision: 2, coordinates: 2, mutate: false }) || feature1;
                const f2 = turf.truncate(feature2, { precision: 2, coordinates: 2, mutate: false }) || feature2;
                return tryUnion(f1, f2);
            },
            () => {
                if (typeof turf.truncate !== 'function') return null;
                const f1 = turf.truncate(feature1, { precision: 1, coordinates: 2, mutate: false }) || feature1;
                const f2 = turf.truncate(feature2, { precision: 1, coordinates: 2, mutate: false }) || feature2;
                return tryUnion(f1, f2);
            }
        ];
        for (const attempt of unionAttempts) {
            try {
                const result = attempt();
                if (result && result.geometry) {
                    combined = result;
                    break;
                }
            } catch (_) { /* try next */ }
        }
        if (!combined || !combined.geometry) return polygon2 || polygon1;

        const geom = combined.geometry;
        const toLatLngRing = (ring) => (Array.isArray(ring) ? ring : []).map(fromHTRS).filter(Boolean);

        if (geom.type === 'Polygon') {
            const rings = (geom.coordinates || []).map(toLatLngRing).filter(r => r.length >= 4);
            if (!rings.length) return null;
            return rings.length === 1 ? rings[0] : rings;
        }

        if (geom.type === 'MultiPolygon') {
            const polys = (geom.coordinates || [])
                .map(polyRings => (Array.isArray(polyRings) ? polyRings : [])
                    .map(toLatLngRing)
                    .filter(r => r.length >= 4))
                .filter(rings => rings.length > 0);
            return polys.length ? polys : null;
        }

        return null;
    } catch (error) {
        console.error('Error combining road polygons:', error);
        return polygon2 || polygon1;
    }
}

function _isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

function _calculateAreaFromLatLngPolygon(latLngPolygon) {
    try {
        if (!latLngPolygon || typeof turf === 'undefined' || !turf || typeof turf.area !== 'function') {
            return 0;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
        const toClosedLngLatRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(p => [p.lng, p.lat]);
            const closed = _ensurePolygonIsClosed(coords);
            return Array.isArray(closed) && closed.length >= 4 ? closed : null;
        };

        const toTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;
            if (isLatLng(poly[0])) {
                const ring = toClosedLngLatRing(poly);
                return ring ? turf.polygon([ring]) : null;
            }
            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly.map(toClosedLngLatRing).filter(Boolean);
                return rings.length ? turf.polygon(rings) : null;
            }
            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(toClosedLngLatRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                return polys.length ? turf.multiPolygon(polys) : null;
            }
            return null;
        };

        const feature = toTurfFeature(latLngPolygon);
        if (!feature) return 0;
        return turf.area(feature) || 0;
    } catch (e) {
        return 0;
    }
}

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
