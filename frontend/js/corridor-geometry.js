// Pure road/corridor geometry, lifted out of road-drawing.js so it can be unit-tested headless.
// Everything here is plain math over {lat,lng} points and HTRS96 metres — the only couplings are
// the projection functions (wgs84ToHTRS96 / htrs96ToWGS84) and Leaflet's L.latLng factory, both of
// which are resolved from injected deps (node tests) or the browser globals. No map, no DOM.
//
// This module starts with createRectangularRoadSegment because it carried a live bug: the
// degenerate near-zero-length branch picked its direction with Math.random(), so two clicks in the
// same spot produced a different saved polygon — and a different geometryHash — on every run.
// proposal-manager.js had a second, DIVERGED copy that returned null in that case instead. One
// deterministic copy ends both problems.

(function (global) {
    'use strict';

    function resolveDep(deps, name) {
        if (deps && typeof deps[name] === 'function') return deps[name];
        if (typeof global[name] === 'function') return global[name];
        return null;
    }

    function makeLatLng(deps, lat, lng) {
        if (deps && typeof deps.latLng === 'function') return deps.latLng(lat, lng);
        if (global.L && typeof global.L.latLng === 'function') return global.L.latLng(lat, lng);
        return { lat, lng };
    }

    function isValidHtrsPoint(point) {
        return Array.isArray(point) && point.length === 2 && isFinite(point[0]) && isFinite(point[1]);
    }

    // Build the WGS84 corner ring of a width-wide rectangle running from point1 to point2.
    // Returns an array of latLng corners (closed ring) or null if the inputs can't form one.
    // deps (optional): { wgs84ToHTRS96, htrs96ToWGS84, latLng } — defaults to the browser globals.
    function createRectangularRoadSegment(point1, point2, width, deps = {}) {
        const wgs84ToHTRS96 = resolveDep(deps, 'wgs84ToHTRS96');
        const htrs96ToWGS84 = resolveDep(deps, 'htrs96ToWGS84');
        if (!wgs84ToHTRS96 || !htrs96ToWGS84) {
            console.warn('createRectangularRoadSegment: projection functions unavailable');
            return null;
        }

        if (!point1 || !point2 || !isFinite(width) || width <= 0) {
            console.warn('Invalid inputs to createRectangularRoadSegment');
            return null;
        }
        if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
            !isFinite(point2.lat) || !isFinite(point2.lng)) {
            console.warn('Invalid coordinates in createRectangularRoadSegment');
            return null;
        }

        const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
        let htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);
        if (!isValidHtrsPoint(htrsPoint1) || !isValidHtrsPoint(htrsPoint2)) {
            console.warn('Invalid HTRS points in createRectangularRoadSegment');
            return null;
        }

        let dx = htrsPoint2[0] - htrsPoint1[0];
        let dy = htrsPoint2[1] - htrsPoint1[1];
        let length = Math.sqrt(dx * dx + dy * dy);

        // Near-zero-length: nudge the far point a fixed 10 cm DUE EAST so the rectangle is still
        // well-formed. Deterministic on purpose — this was Math.random() and made the footprint
        // (and its geometryHash) irreproducible for coincident clicks.
        if (length < 0.001) {
            const minLength = 0.1; // 10 cm
            htrsPoint2 = [htrsPoint1[0] + minLength, htrsPoint1[1]];
            dx = minLength;
            dy = 0;
            length = minLength;
        }

        const perpX = -dy / length;
        const perpY = dx / length;
        const halfWidth = width / 2;

        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth],
            [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth],
            [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth],
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth],
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]
        ];

        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(makeLatLng(deps, lat, lng));
            }
        }

        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }
        return wgsCorners;
    }

    // ---- Centerline graph geometry (moved out of road-drawing.js) ----------------------------
    // These operate on {lat,lng} centerline segments. External deps (corridorTunnelEdgeKey,
    // calculateSegmentLengthMeters, wgs84ToHTRS96) are resolved from the global scope at call time
    // and every reference is typeof-guarded or try/caught, so the pure geometry is testable alone.

    function planarSegmentIntersection(a1, a2, b1, b2) {
        const d1x = a2.lng - a1.lng;
        const d1y = a2.lat - a1.lat;
        const d2x = b2.lng - b1.lng;
        const d2y = b2.lat - b1.lat;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-18) return null;
        const t = ((b1.lng - a1.lng) * d2y - (b1.lat - a1.lat) * d2x) / denom;
        const u = ((b1.lng - a1.lng) * d1y - (b1.lat - a1.lat) * d1x) / denom;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
        return { lat: a1.lat + t * d1y, lng: a1.lng + t * d1x };
    }

    // Wherever two centerline segments cross, both get a vertex at the crossing point. That makes
    // junctions real graph nodes: draggable, bulldozable, and honest for connectivity checks.
    function insertCorridorCrossingNodes(segments, segmentIds, protectedEdgeKeys = null) {
        const EPS = 1e-7;
        const near = (p, q) => p && q && Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
        // Tunnel records are keyed by their exact edge — inserting a vertex into a tunnelled edge
        // would orphan the record (the stretch silently reverts to surface). Callers pass those keys.
        const isProtectedEdge = (p, q) => {
            if (!protectedEdgeKeys || !protectedEdgeKeys.size || typeof corridorTunnelEdgeKey !== 'function') return false;
            const key = corridorTunnelEdgeKey(p, q);
            return !!key && protectedEdgeKeys.has(key);
        };
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 200) {
            changed = false;
            outer:
            for (let i = 0; i < segments.length; i += 1) {
                for (let j = i + 1; j < segments.length; j += 1) {
                    const A = segments[i];
                    const B = segments[j];
                    for (let ai = 0; ai < A.length - 1; ai += 1) {
                        for (let bi = 0; bi < B.length - 1; bi += 1) {
                            const x = planarSegmentIntersection(A[ai], A[ai + 1], B[bi], B[bi + 1]);
                            if (!x) continue;
                            let inserted = false;
                            // Inserting the crossing vertex does NOT change what the segment IS —
                            // the id must survive, because per-segment cross-section overrides are
                            // keyed by it. (Nulling it here orphaned every absorbed road's profile
                            // at the junction step, repainting merges with the newest profile.)
                            if (!near(x, A[ai]) && !near(x, A[ai + 1]) && !isProtectedEdge(A[ai], A[ai + 1])) {
                                A.splice(ai + 1, 0, { lat: x.lat, lng: x.lng });
                                inserted = true;
                            }
                            if (!near(x, B[bi]) && !near(x, B[bi + 1]) && !isProtectedEdge(B[bi], B[bi + 1])) {
                                B.splice(bi + 1, 0, { lat: x.lat, lng: x.lng });
                                inserted = true;
                            }
                            if (inserted) {
                                changed = true;
                                break outer;
                            }
                        }
                    }
                }
            }
        }
    }

    // Connected components of a segment set: segments sharing any coincident vertex belong to one
    // body. Bodies are returned sorted by total length descending (the main run first).
    function corridorConnectedComponents(segments, segmentIds) {
        const EPS = 1e-7;
        const near = (p, q) => Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
        const parent = segments.map((_, index) => index);
        const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const union = (i, j) => { parent[find(j)] = find(i); };
        for (let i = 0; i < segments.length; i += 1) {
            for (let j = i + 1; j < segments.length; j += 1) {
                if (find(i) === find(j)) continue;
                const touches = segments[i].some(p => segments[j].some(q => near(p, q)));
                if (touches) union(i, j);
            }
        }
        const groups = new Map();
        segments.forEach((segment, index) => {
            const root = find(index);
            if (!groups.has(root)) groups.set(root, { segments: [], segmentIds: [], length: 0 });
            const group = groups.get(root);
            group.segments.push(segment);
            group.segmentIds.push(Array.isArray(segmentIds) ? (segmentIds[index] || null) : null);
            group.length += (typeof calculateSegmentLengthMeters === 'function') ? calculateSegmentLengthMeters(segment) : segment.length;
        });
        return [...groups.values()].sort((a, b) => b.length - a.length);
    }

    // Do two centerline sets genuinely connect — sharing a vertex or crossing? Footprint overlap
    // alone (two parallel roads grazing each other's width) is not a connection.
    function centerlinesTouch(segmentsA, segmentsB) {
        const EPS = 1e-7;
        const near = (p, q) => Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;
        for (const a of segmentsA) {
            for (const b of segmentsB) {
                if (a.some(p => b.some(q => near(p, q)))) return true;
                for (let i = 0; i < a.length - 1; i += 1) {
                    for (let j = 0; j < b.length - 1; j += 1) {
                        if (planarSegmentIntersection(a[i], a[i + 1], b[j], b[j + 1])) return true;
                    }
                }
            }
        }
        return false;
    }

    function segmentsIntersect(p1, q1, p2, q2) {
        const EPS = 1e-9;

        const orient = (a, b, c) => {
            const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (Math.abs(val) < EPS) return 0;
            return val > 0 ? 1 : 2;
        };

        const onSegment = (a, b, c) => {
            return b.x <= Math.max(a.x, c.x) + EPS && b.x + EPS >= Math.min(a.x, c.x)
                && b.y <= Math.max(a.y, c.y) + EPS && b.y + EPS >= Math.min(a.y, c.y);
        };

        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;

        // Colinear cases
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;

        return false;
    }

    // Does a road centerline cross itself? Works in planar metres (wgs84ToHTRS96) to dodge geodesic
    // edge cases; a false negative would save a self-crossing road with an even-odd hole at the
    // crossing, so parcels inside the loop are never acquired.
    function polylineHasSelfIntersection(latLngPoints) {
        if (!Array.isArray(latLngPoints) || latLngPoints.length < 4) return false;

        const pts = [];
        for (const p of latLngPoints) {
            try {
                const xy = wgs84ToHTRS96(p.lat, p.lng);
                if (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) {
                    pts.push({ x: xy[0], y: xy[1] });
                } else {
                    return false;
                }
            } catch (_) {
                return false;
            }
        }

        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!a || !b) continue;
            for (let j = i + 2; j < pts.length - 1; j++) {
                if (j === i + 1) continue;
                const c = pts[j];
                const d = pts[j + 1];
                if (!c || !d) continue;
                if (segmentsIntersect(a, b, c, d)) {
                    return true;
                }
            }
        }
        return false;
    }

    // Merge polylines that share an endpoint into single segments, keeping ids and per-segment
    // profile overrides aligned. Pieces with DIFFERENT cross-section profiles stay separate.
    function weldCorridorSegments(segments, segmentIds, segmentProfiles = null) {
        const EPS = 1e-7; // ~1 cm — snap targets copy exact vertex coordinates
        const same = (a, b) => a && b && Math.abs(a.lat - b.lat) < EPS && Math.abs(a.lng - b.lng) < EPS;
        const profileKeyOf = id => {
            if (!segmentProfiles || id === null || id === undefined) return '';
            const override = segmentProfiles[String(id)];
            return override ? JSON.stringify(override) : '';
        };
        const segs = segments.map(segment => segment.slice());
        const ids = segmentIds.slice();
        let joined = true;
        while (joined) {
            joined = false;
            outer:
            for (let i = 0; i < segs.length; i += 1) {
                for (let j = 0; j < segs.length; j += 1) {
                    if (i === j) continue;
                    if (profileKeyOf(ids[i]) !== profileKeyOf(ids[j])) continue;
                    const a = segs[i];
                    const b = segs[j];
                    if (same(a[a.length - 1], b[0])) segs[i] = a.concat(b.slice(1));
                    else if (same(a[a.length - 1], b[b.length - 1])) segs[i] = a.concat(b.slice(0, -1).reverse());
                    else if (same(a[0], b[b.length - 1])) segs[i] = b.concat(a.slice(1));
                    else if (same(a[0], b[0])) segs[i] = b.slice(1).reverse().concat(a);
                    else continue;
                    ids[i] = profileKeyOf(ids[i]) ? ids[i] : (profileKeyOf(ids[j]) ? ids[j] : null);
                    segs.splice(j, 1);
                    ids.splice(j, 1);
                    joined = true;
                    break outer;
                }
            }
        }
        return { segments: segs, segmentIds: ids };
    }

    // ---- Road-footprint shape conversion (moved out of road-drawing.js) ----------------------
    // Every corridor footprint passes through here on its way to persistence. The only coupling is
    // an `instanceof L.LatLng` probe, guarded by `typeof L !== 'undefined'`, so the branch logic —
    // which is where a MultiPolygon footprint was once misread as polygon-with-holes and lost — is
    // testable without Leaflet.

    // Normalize a road polygon (single ring / polygon-with-holes / MultiPolygon, of LatLng objects
    // or numeric pairs) into [lat,lng] pair rings. Returns null if it can't form a valid ring.
    function convertRoadPolygonToLatLngPairs(polygon) {
        if (!Array.isArray(polygon) || !polygon.length) return null;

        const isLatLngObj = (p) => {
            if (!p) return false;
            if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
            if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return true;
            const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
            const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
            return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
        };

        const extractLatLng = (p) => {
            if (!p) return null;
            if (typeof L !== 'undefined' && L.LatLng && p instanceof L.LatLng) return [p.lat, p.lng];
            if (typeof p.lat === 'function' && typeof p.lng === 'function') return [p.lat(), p.lng()];
            if (typeof p.lat === 'number' && typeof p.lng === 'number') return [p.lat, p.lng];
            return null;
        };

        const toRingPairs = (ring) => {
            if (!Array.isArray(ring) || !ring.length) return null;
            const pairs = [];
            for (const entry of ring) {
                const extracted = extractLatLng(entry);
                if (extracted) {
                    pairs.push(extracted);
                    continue;
                }
                if (Array.isArray(entry) && entry.length >= 2) {
                    const a = Number(entry[0]);
                    const b = Number(entry[1]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                    // Assume [lat, lng] but swap if first looks like lng
                    if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                        pairs.push([b, a]);
                    } else {
                        pairs.push([a, b]);
                    }
                }
            }
            if (pairs.length < 3) return null;
            const first = pairs[0];
            const last = pairs[pairs.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                pairs.push([first[0], first[1]]);
            }
            return pairs.length >= 4 ? pairs : null;
        };

        // MultiPolygon FIRST: [ [ring, hole...], [ring, ...], ... ].
        //
        // This has to be tested before polygon-with-holes, and it has to accept rings made of LatLng
        // OBJECTS, not just numeric pairs. combineRoadPolygons produces exactly that shape whenever the
        // footprint is DISJOINT — which is what a corridor tunnelled through its MIDDLE is: two surface
        // runs, one either side of the tunnel. The old order matched such a footprint as a
        // polygon-with-holes, tried to read each ring as a coordinate pair, produced NaN, and returned
        // null. Every consumer then silently lost the footprint: the 3D view carved nothing at all for
        // a mid-corridor tunnel, and parcel parents under the tunnel were never re-derived.
        //
        // The giveaway is depth: in a MultiPolygon, polygon[0][0] is itself a list of POINTS (one level
        // deeper than in a polygon-with-holes, where polygon[0][0] IS a point).
        const isPoint = (value) => isLatLngObj(value)
            || (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number');
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && isPoint(polygon[0][0][0])) {
            const polys = polygon
                .map(poly => Array.isArray(poly) ? poly.map(toRingPairs).filter(Boolean) : [])
                .filter(rings => rings.length);
            return polys.length ? polys : null;
        }

        // Polygon with holes: [ring, hole1, ...]
        if (Array.isArray(polygon[0]) && polygon[0].length) {
            const firstRing = polygon[0];
            if (isLatLngObj(firstRing[0]) || (Array.isArray(firstRing[0]) && firstRing[0].length >= 2)) {
                const rings = polygon.map(toRingPairs).filter(Boolean);
                return rings.length ? rings : null;
            }
        }

        // Single ring
        if (isLatLngObj(polygon[0]) || (Array.isArray(polygon[0]) && polygon[0].length >= 2)) {
            return toRingPairs(polygon);
        }

        // (The MultiPolygon case is handled at the top — it must be tested before polygon-with-holes.)
        return null;
    }

    // [lat,lng] pair rings → a GeoJSON Polygon/MultiPolygon ([lng,lat] order).
    function convertLatLngPairsToGeoJSON(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) return null;

        const toLngLatRing = (ring) => {
            if (!Array.isArray(ring)) return null;
            const coords = ring
                .map(entry => {
                    if (!entry || !Array.isArray(entry) || entry.length < 2) return null;
                    const lat = Number(entry[0]);
                    const lng = Number(entry[1]);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                    return [lng, lat];
                })
                .filter(Boolean);
            return coords.length >= 4 ? coords : null;
        };

        // MultiPolygon
        if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && Array.isArray(pairs[0][0][0])) {
            const polygons = pairs
                .map(poly => Array.isArray(poly) ? poly.map(toLngLatRing).filter(Boolean) : [])
                .filter(rings => rings.length);
            return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
        }

        // Polygon with holes
        if (Array.isArray(pairs[0]) && Array.isArray(pairs[0][0]) && typeof pairs[0][0][0] === 'number') {
            const rings = pairs.map(toLngLatRing).filter(Boolean);
            return rings.length ? { type: 'Polygon', coordinates: rings } : null;
        }

        // Ring only
        if (Array.isArray(pairs[0]) && typeof pairs[0][0] === 'number') {
            const ring = toLngLatRing(pairs);
            return ring ? { type: 'Polygon', coordinates: [ring] } : null;
        }

        return null;
    }

    function isValidPolygonLatLngPairs(polygon) {
        if (!Array.isArray(polygon) || polygon.length === 0) return false;

        // Ring: [ [lat,lng], ... ]
        if (Array.isArray(polygon[0]) && polygon[0].length >= 2 && Number.isFinite(Number(polygon[0][0])) && Number.isFinite(Number(polygon[0][1]))) {
            return polygon.length >= 3;
        }

        // Polygon with holes: [ ring, hole... ]
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0])) {
            const ring = polygon[0];
            if (Array.isArray(ring[0]) && ring[0].length >= 2 && Number.isFinite(Number(ring[0][0])) && Number.isFinite(Number(ring[0][1]))) {
                return ring.length >= 3;
            }
        }

        // MultiPolygon: [ [rings...], [rings...] ... ]
        if (Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) && Array.isArray(polygon[0][0][0])) {
            for (const poly of polygon) {
                if (!Array.isArray(poly) || poly.length === 0) continue;
                const outer = poly[0];
                if (Array.isArray(outer) && outer.length >= 3) return true;
            }
        }

        return false;
    }

    // ---- Track curvature constraints (moved out of road-drawing.js) --------------------------
    // A track vertex must not create a turn tighter than its speed allows. Pure projection math
    // (wgs84ToHTRS96 / htrs96ToWGS84 from the runtime global); the audio feedback stays in the UI.

    // Track speed (km/h) → minimum curvature radius (m), from railway engineering standards.
    const TRACK_SPEED_TO_MIN_RADIUS = {
        50: 300, 80: 500, 120: 1000, 160: 2000, 200: 3500, 250: 5000
    };

    function getMinCurvatureRadius(speed) {
        return TRACK_SPEED_TO_MIN_RADIUS[speed] || 1000;
    }

    // Radius (m) of the circle through three lat/lng points. Infinity when the points are collinear
    // or too close (treated as straight).
    function calculateCurvatureRadius(p1, p2, p3) {
        const toMeters = (latLng) => {
            const [x, y] = wgs84ToHTRS96(latLng.lat, latLng.lng);
            return [x, y];
        };
        const a = toMeters(p1);
        const b = toMeters(p2);
        const c = toMeters(p3);
        const ab = [b[0] - a[0], b[1] - a[1]];
        const bc = [c[0] - b[0], c[1] - b[1]];
        const ac = [c[0] - a[0], c[1] - a[1]];
        const abLen = Math.hypot(ab[0], ab[1]);
        const bcLen = Math.hypot(bc[0], bc[1]);
        const acLen = Math.hypot(ac[0], ac[1]);
        if (abLen < 0.1 || bcLen < 0.1 || acLen < 0.1) {
            return Infinity; // Points too close, treat as straight
        }
        const area = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / 2;
        if (area < 0.1) {
            return Infinity; // Collinear, treat as straight
        }
        return (abLen * bcLen * acLen) / (4 * area);
    }

    // Would appending newPoint after `points` violate the minimum radius? Returns
    // { valid, adjustedPoint, violatesConstraint, wasAdjusted }. May nudge the point outward to
    // satisfy the constraint when a small extension fixes it.
    function checkCurvatureConstraint(points, newPoint, minRadius, deps = {}) {
        if (points.length < 2) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }
        const lastPoint = points[points.length - 1];
        const secondLastPoint = points.length >= 2 ? points[points.length - 2] : null;
        if (!secondLastPoint) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const [prevX, prevY] = wgs84ToHTRS96(secondLastPoint.lat, secondLastPoint.lng);
        const [lastX, lastY] = wgs84ToHTRS96(lastPoint.lat, lastPoint.lng);
        const [newX, newY] = wgs84ToHTRS96(newPoint.lat, newPoint.lng);

        const prevDx = lastX - prevX;
        const prevDy = lastY - prevY;
        const prevDist = Math.hypot(prevDx, prevDy);
        const dx = newX - lastX;
        const dy = newY - lastY;
        const dist = Math.hypot(dx, dy);
        if (prevDist < 0.1 || dist < 0.1) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const prevAngle = Math.atan2(prevDy, prevDx);
        const newAngle = Math.atan2(dy, dx);
        let angleDiff = newAngle - prevAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        const absAngleDiff = Math.abs(angleDiff);
        if (absAngleDiff < 0.01) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        const radius = calculateCurvatureRadius(secondLastPoint, lastPoint, newPoint);
        if (radius >= minRadius) {
            return { valid: true, adjustedPoint: newPoint, violatesConstraint: false, wasAdjusted: false };
        }

        // L = 2·R·sin(θ/2): the minimum chord for this turn angle at the minimum radius.
        const chordDx = newX - prevX;
        const chordDy = newY - prevY;
        const chordLength = Math.hypot(chordDx, chordDy);
        const minRequiredChordLength = 2 * minRadius * Math.sin(absAngleDiff / 2);

        if (chordLength < minRequiredChordLength) {
            const cosAngleDiff = Math.cos(absAngleDiff);
            const qa = 1;
            const qb = -2 * prevDist * cosAngleDiff;
            const qc = prevDist * prevDist - minRequiredChordLength * minRequiredChordLength;
            const discriminant = qb * qb - 4 * qa * qc;
            if (discriminant < 0) {
                return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
            }
            const requiredDist = (-qb + Math.sqrt(discriminant)) / (2 * qa);
            if (requiredDist > dist * 2 || requiredDist < dist * 0.5) {
                return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
            }
            const scale = requiredDist / dist;
            const adjustedX = lastX + dx * scale;
            const adjustedY = lastY + dy * scale;
            const [adjustedLat, adjustedLng] = htrs96ToWGS84(adjustedX, adjustedY);
            const adjustedPoint = makeLatLng(deps, adjustedLat, adjustedLng);
            const adjustedRadius = calculateCurvatureRadius(secondLastPoint, lastPoint, adjustedPoint);
            if (adjustedRadius >= minRadius * 0.98) {
                return { valid: true, adjustedPoint: adjustedPoint, violatesConstraint: false, wasAdjusted: true };
            }
        }

        return { valid: true, adjustedPoint: newPoint, violatesConstraint: true, wasAdjusted: false };
    }

    // ---- Snap-target selection (moved out of road-drawing.js) --------------------------------
    // Pure pixel-space geometry: which existing vertex/edge should a cursor snap to. The UI projects
    // lat/lng to screen pixels and resolves the result back; this decides the priority.

    function projectPointOnPixelSegment(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return { x: a.x, y: a.y };
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * dx, y: a.y + t * dy };
    }

    function pixelDistance(p, q) {
        return Math.hypot(p.x - q.x, p.y - q.y);
    }

    // Tiered nearest-snap. localSegments: [[{x,y}...], ...]; externalSegments: [{points:[{x,y}...]}].
    // Priority: any LOCAL VERTEX within radius beats any LOCAL EDGE beats any EXTERNAL (placed road).
    // The active segment's growing tip is skipped (snapping to it makes a zero-length edge) and the
    // active segment is never edge-inserted (that renumbers vertices under the pointer). Returns a
    // raw descriptor (indices + winning pixel) the UI resolves back to a latlng; null if nothing near.
    function pickSnapTarget(cursorPx, localSegments, externalSegments, activeIndex, radiusPx) {
        let best = null;

        // Tier 1: local vertices
        localSegments.forEach((seg, segmentIndex) => {
            if (!Array.isArray(seg) || !seg.length) return;
            seg.forEach((vertex, vertexIndex) => {
                if (segmentIndex === activeIndex && vertexIndex === seg.length - 1) return;
                const distance = pixelDistance(cursorPx, vertex);
                if (distance > radiusPx) return;
                if (best && distance >= best.distance) return;
                const isEndpoint = vertexIndex === 0 || vertexIndex === seg.length - 1;
                best = {
                    distance, source: 'local', kind: isEndpoint ? 'endpoint' : 'vertex',
                    segmentIndex, vertexIndex, atStart: vertexIndex === 0, pixel: vertex
                };
            });
        });
        if (best) return best;

        // Tier 2: local edges
        localSegments.forEach((seg, segmentIndex) => {
            if (!Array.isArray(seg) || seg.length < 2) return;
            if (segmentIndex === activeIndex) return;
            for (let i = 0; i < seg.length - 1; i++) {
                const projected = projectPointOnPixelSegment(cursorPx, seg[i], seg[i + 1]);
                const distance = pixelDistance(cursorPx, projected);
                if (distance > radiusPx) continue;
                if (best && distance >= best.distance) continue;
                best = { distance, source: 'local', kind: 'edge', segmentIndex, insertAfter: i, pixel: projected };
            }
        });
        if (best) return best;

        // Tier 3: placed (external) corridors — endpoints and edges compete on distance
        externalSegments.forEach((entry, externalIndex) => {
            const seg = entry && entry.points;
            if (!Array.isArray(seg) || seg.length < 2) return;
            seg.forEach((vertex, vertexIndex) => {
                const isEndpoint = vertexIndex === 0 || vertexIndex === seg.length - 1;
                if (!isEndpoint) return;
                const distance = pixelDistance(cursorPx, vertex);
                if (distance > radiusPx) return;
                if (best && distance >= best.distance) return;
                best = { distance, source: 'external', kind: 'external-endpoint', externalIndex, vertexIndex, pixel: vertex };
            });
            for (let i = 0; i < seg.length - 1; i++) {
                const projected = projectPointOnPixelSegment(cursorPx, seg[i], seg[i + 1]);
                const distance = pixelDistance(cursorPx, projected);
                if (distance > radiusPx) continue;
                if (best && distance >= best.distance) continue;
                best = { distance, source: 'external', kind: 'external-edge', externalIndex, insertAfter: i, pixel: projected };
            }
        });
        return best;
    }

    const api = {
        createRectangularRoadSegment,
        isValidHtrsPoint,
        getMinCurvatureRadius,
        calculateCurvatureRadius,
        checkCurvatureConstraint,
        projectPointOnPixelSegment,
        pickSnapTarget,
        planarSegmentIntersection,
        insertCorridorCrossingNodes,
        corridorConnectedComponents,
        centerlinesTouch,
        segmentsIntersect,
        polylineHasSelfIntersection,
        weldCorridorSegments,
        convertRoadPolygonToLatLngPairs,
        convertLatLngPairsToGeoJSON,
        isValidPolygonLatLngPairs
    };

    if (typeof window !== 'undefined') {
        window.CorridorGeometry = api;
        window.createRectangularRoadSegment = createRectangularRoadSegment;
        window.planarSegmentIntersection = planarSegmentIntersection;
        window.insertCorridorCrossingNodes = insertCorridorCrossingNodes;
        window.corridorConnectedComponents = corridorConnectedComponents;
        window.centerlinesTouch = centerlinesTouch;
        window.segmentsIntersect = segmentsIntersect;
        window.polylineHasSelfIntersection = polylineHasSelfIntersection;
        window.weldCorridorSegments = weldCorridorSegments;
        window.convertRoadPolygonToLatLngPairs = convertRoadPolygonToLatLngPairs;
        window.convertLatLngPairsToGeoJSON = convertLatLngPairsToGeoJSON;
        window.isValidPolygonLatLngPairs = isValidPolygonLatLngPairs;
        window.getMinCurvatureRadius = getMinCurvatureRadius;
        window.calculateCurvatureRadius = calculateCurvatureRadius;
        window.checkCurvatureConstraint = checkCurvatureConstraint;
        window.pickSnapTarget = pickSnapTarget;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
