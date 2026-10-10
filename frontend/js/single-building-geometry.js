// Pure geometry for the freeform-building and row-house editors: the initial rectangle, footprint
// validation, moving and rotating — all in true ground metres, in a metric frame on the footprint or
// the point it moves from/to (metric-frame.js, projections.md §2 and §6). Interactive vertex editing
// lives in polygon-geometry-editor.js so block manual mode and freeform buildings use one system.
//
// It began as the fix for buildings built in EPSG:3857 (Web-Mercator) coordinates: Mercator inflates
// distance by 1/cos(latitude), so at Zagreb (~45.8°) a "20 m" building came out ~14 m on the ground.
// That was corrected with a 1/cos(lat) factor at the centre; a move in Mercator still rescaled the
// footprint by the change of that factor (≈ 0.025% per km north at 45°). Built in metres, neither
// exists. Pure — no map, no projector — so sizes and moves are unit-tested.

(function (global) {
    'use strict';

    const GROUND_AREA_EPSILON_M2 = 0.01;

    function ensureClosedRing(ring) {
        if (!Array.isArray(ring) || ring.length === 0) return ring;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (!last || first[0] !== last[0] || first[1] !== last[1]) {
            return ring.concat([[first[0], first[1]]]);
        }
        return ring;
    }

    function coordinatesEqual(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
    }

    function openRing(ring) {
        if (!Array.isArray(ring)) return [];
        const open = ring
            .filter(coord => Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1]))
            .map(coord => [coord[0], coord[1]]);
        if (open.length > 1 && coordinatesEqual(open[0], open[open.length - 1])) open.pop();
        return open;
    }

    function orientation(a, b, c) {
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }

    function onSegment(a, b, point, epsilon = 1e-12) {
        return Math.abs(orientation(a, b, point)) <= epsilon
            && point[0] >= Math.min(a[0], b[0]) - epsilon
            && point[0] <= Math.max(a[0], b[0]) + epsilon
            && point[1] >= Math.min(a[1], b[1]) - epsilon
            && point[1] <= Math.max(a[1], b[1]) + epsilon;
    }

    function segmentsIntersect(a, b, c, d) {
        const epsilon = 1e-12;
        const o1 = orientation(a, b, c);
        const o2 = orientation(a, b, d);
        const o3 = orientation(c, d, a);
        const o4 = orientation(c, d, b);
        if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
            && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) return true;
        return (Math.abs(o1) <= epsilon && onSegment(a, b, c, epsilon))
            || (Math.abs(o2) <= epsilon && onSegment(a, b, d, epsilon))
            || (Math.abs(o3) <= epsilon && onSegment(c, d, a, epsilon))
            || (Math.abs(o4) <= epsilon && onSegment(c, d, b, epsilon));
    }

    // A footprint ring must not fold across itself or reuse a vertex. Adjacent edges share one
    // endpoint by definition, so only non-adjacent edge pairs are tested for intersections.
    function isSimpleRing(ring) {
        const open = openRing(ring);
        if (open.length < 3) return false;
        const unique = new Set(open.map(coord => `${coord[0]},${coord[1]}`));
        if (unique.size !== open.length) return false;

        let twiceArea = 0;
        for (let i = 0; i < open.length; i++) {
            const next = open[(i + 1) % open.length];
            twiceArea += open[i][0] * next[1] - next[0] * open[i][1];
        }
        if (Math.abs(twiceArea) <= 1e-18) return false;

        for (let i = 0; i < open.length; i++) {
            const a = open[i];
            const b = open[(i + 1) % open.length];
            for (let j = i + 1; j < open.length; j++) {
                const adjacent = j === i + 1 || (i === 0 && j === open.length - 1);
                if (adjacent) continue;
                const c = open[j];
                const d = open[(j + 1) % open.length];
                if (segmentsIntersect(a, b, c, d)) return false;
            }
        }
        return true;
    }

    // The editor and the authoritative apply path use the same absolute area tolerance. A looser
    // editor check used to accept a default footprint with 0.018 m² outside its host parcel; the
    // proposal was then saved but correctly refused by apply.
    function footprintWithinBoundary(footprint, boundary, turfApi, epsilonM2 = GROUND_AREA_EPSILON_M2) {
        if (!footprint?.geometry || !boundary?.geometry || !turfApi) return false;
        try {
            const outside = turfApi.difference(footprint, boundary);
            if (!outside) return true;
            const outsideArea = Number(turfApi.area(outside));
            const epsilon = Number.isFinite(Number(epsilonM2)) ? Math.max(0, Number(epsilonM2)) : GROUND_AREA_EPSILON_M2;
            return Number.isFinite(outsideArea) && outsideArea <= epsilon;
        } catch (_) {
            try { return turfApi.booleanWithin(footprint, boundary); } catch (_) { return false; }
        }
    }

    function outerRings(geometry) {
        if (!geometry || !Array.isArray(geometry.coordinates)) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(polygon => polygon && polygon[0]).filter(Boolean);
        }
        return [];
    }

    function metricFrames() {
        if (global && global.__metricFrame) return global.__metricFrame;
        if (typeof require === 'function') return require('./metric-frame.js');
        throw new Error('single-building-geometry: metric-frame.js is not loaded');
    }

    const round6 = value => Math.round(value * 1e6) / 1e6;

    // Metres east/north of `point` ({lat, lng}) itself, in a frame on it (offsets from the point, not
    // from the frame's rounded anchor), and back.
    function pointFrame(point) {
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
            throw new Error('single-building-geometry: a point must be finite {lat, lng}');
        }
        const frame = metricFrames().frameAt([round6(point.lng), round6(point.lat)]);
        const origin = frame.toMetric([point.lng, point.lat]);
        return {
            toLocal: ([lng, lat]) => {
                const [x, y] = frame.toMetric([lng, lat]);
                return [x - origin[0], y - origin[1]];
            },
            toLngLat: ([x, y]) => frame.toLngLat([x + origin[0], y + origin[1]])
        };
    }

    // The area-weighted centroid of a footprint's outer rings, as {lat, lng}, measured in metres in a
    // frame on the footprint.
    function geometryCenter(geometry) {
        if (!geometry) return null;
        const rings = outerRings(geometry).map(openRing).filter(ring => ring.length >= 3);
        if (!rings.length) return null;
        const frame = metricFrames().frameFor(rings);
        const centroids = [];
        rings.forEach(ring => {
            const projected = ring.map(position => frame.toMetric(position));
            if (projected.length < 3) return;
            const origin = projected[0];
            const local = projected.map(point => [point[0] - origin[0], point[1] - origin[1]]);
            let twiceArea = 0;
            let weightedX = 0;
            let weightedY = 0;
            for (let i = 0; i < local.length; i++) {
                const current = local[i];
                const next = local[(i + 1) % local.length];
                const cross = current[0] * next[1] - next[0] * current[1];
                twiceArea += cross;
                weightedX += (current[0] + next[0]) * cross;
                weightedY += (current[1] + next[1]) * cross;
            }
            if (Math.abs(twiceArea) <= 1e-9) return;
            centroids.push({
                point: [
                    origin[0] + weightedX / (3 * twiceArea),
                    origin[1] + weightedY / (3 * twiceArea)
                ],
                weight: Math.abs(twiceArea)
            });
        });
        if (!centroids.length) return null;
        const totalWeight = centroids.reduce((sum, item) => sum + item.weight, 0);
        const center = centroids.reduce((sum, item) => [
            sum[0] + item.point[0] * item.weight,
            sum[1] + item.point[1] * item.weight
        ], [0, 0]).map(total => total / totalWeight);
        const [lng, lat] = frame.toLngLat(center);
        return { lat, lng };
    }

    function mapGeometryCoordinates(geometry, mapper) {
        if (!geometry || !Array.isArray(geometry.coordinates) || typeof mapper !== 'function') return null;
        const mapRing = ring => ring.map(coord => mapper(coord));
        if (geometry.type === 'Polygon') {
            return { ...geometry, coordinates: geometry.coordinates.map(mapRing) };
        }
        if (geometry.type === 'MultiPolygon') {
            return { ...geometry, coordinates: geometry.coordinates.map(polygon => polygon.map(mapRing)) };
        }
        return null;
    }

    // Move a footprint so that `from` lands on `to` ({lat, lng} each), keeping its ground shape and
    // size exactly: every vertex keeps its metres east/north of `from` (in a frame there) and gets the
    // same metres east/north of `to` (in a frame there), however far it moves.
    function moveGeometry(geometry, from, to) {
        if (!geometry || !from || !to) return null;
        const source = pointFrame(from);
        const target = pointFrame(to);
        return mapGeometryCoordinates(geometry, coordinate => target.toLngLat(source.toLocal(coordinate)));
    }

    function moveGeometryCenter(geometry, target) {
        if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return null;
        const center = geometryCenter(geometry);
        if (!center) return null;
        return moveGeometry(geometry, center, target);
    }

    // Rotate a footprint about its centroid by `rotationDeg` (counter-clockwise), in ground metres.
    function rotateGeometry(geometry, rotationDeg) {
        const degrees = Number(rotationDeg);
        if (!Number.isFinite(degrees)) return null;
        const center = geometryCenter(geometry);
        if (!center) return null;
        const frame = pointFrame(center);
        const angle = degrees * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return mapGeometryCoordinates(geometry, coordinate => {
            const [x, y] = frame.toLocal(coordinate);
            return frame.toLngLat([x * cos - y * sin, x * sin + y * cos]);
        });
    }

    // A closed [lng,lat] ring of a rotated rectangle centred on `center` ({lat, lng}), sized in
    // ground metres. The freeform editor uses equal width/length for its initial square.
    function buildRectangleRing(center, params = {}) {
        if (!center) return null;
        const widthM = Number(params.widthM);
        const lengthM = Number(params.lengthM);
        if (!Number.isFinite(widthM) || !Number.isFinite(lengthM)) return null;
        const rotationDeg = Number(params.rotationDeg) || 0;
        const halfW = Math.max(0.5, widthM / 2);
        const halfL = Math.max(0.5, lengthM / 2);
        const frame = pointFrame(center);
        const angle = rotationDeg * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const ring = [[-halfW, -halfL], [halfW, -halfL], [halfW, halfL], [-halfW, halfL]]
            .map(([x, y]) => frame.toLngLat([x * cos - y * sin, x * sin + y * cos]));
        return ensureClosedRing(ring);
    }

    function siteClipApi() {
        if (global && global.__siteClip) return global.__siteClip;
        try { return typeof require === 'function' ? require('./proposals/site-clip.js') : null; } catch (_) { return null; }
    }

    // footprintWithinBoundary accepts up to GROUND_AREA_EPSILON_M2 outside the block (float noise
    // from dragging a vertex onto the edge), but 0.01 m² is a 1-2 cm sliver along a few decimetres
    // of the neighbour's ground, which binds that parcel at tolerance 0. A saved footprint is
    // therefore clipped to the block: what the editor tolerated as noise is cut off, not published.
    function clipFootprintToBoundary(footprint, boundary, turfApi) {
        if (!footprint?.geometry || !boundary?.geometry) return footprint;
        const clip = siteClipApi();
        if (!clip) throw new Error('single-building-geometry: proposals/site-clip.js is not loaded');
        const clipped = clip.clipToSite(footprint, boundary, turfApi ? { turf: turfApi } : undefined);
        return clipped || footprint;
    }

    const api = {
        GROUND_AREA_EPSILON_M2,
        buildRectangleRing,
        clipFootprintToBoundary,
        ensureClosedRing,
        footprintWithinBoundary,
        isSimpleRing,
        geometryCenter,
        moveGeometry,
        moveGeometryCenter,
        rotateGeometry
    };

    if (typeof window !== 'undefined') {
        window.SingleBuildingGeometry = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
