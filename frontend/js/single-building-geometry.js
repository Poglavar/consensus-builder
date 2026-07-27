// Pure geometry for the freeform-building editor: its initial square, footprint validation,
// translation, and rotation in a Web-Mercator projector's space. Interactive vertex editing lives
// in polygon-geometry-editor.js so block manual mode and freeform buildings use one system.
//
// It exists to fix a real bug: buildRectangleFeature added the building's ground-metre half-width
// and half-length directly as offsets in EPSG:3857 (Web-Mercator) coordinates. But Mercator inflates
// distance by 1/cos(latitude), so at Zagreb (~45.8°) a "20 m" building came out ~14 m on the ground
// (area off by cos²φ ≈ 0.49×). The offsets are now scaled by 1/cos(lat) so the projected rectangle is
// the intended ground size. Pure — the projector is injected — so the area is unit-testable.

(function (global) {
    'use strict';

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

    function outerRings(geometry) {
        if (!geometry || !Array.isArray(geometry.coordinates)) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(polygon => polygon && polygon[0]).filter(Boolean);
        }
        return [];
    }

    function projectedGeometryCenter(projector, geometry) {
        if (!projector || !geometry) return null;
        const centroids = [];
        outerRings(geometry).forEach(ring => {
            const projected = openRing(ring).map(([lng, lat]) => projector.project({ lat, lng }));
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
        return centroids.reduce((sum, item) => [
            sum[0] + item.point[0] * item.weight,
            sum[1] + item.point[1] * item.weight
        ], [0, 0]).map(total => total / totalWeight);
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

    function translateGeometry(projector, geometry, deltaX, deltaY) {
        if (!projector || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
        return mapGeometryCoordinates(geometry, ([lng, lat]) => {
            const [x, y] = projector.project({ lat, lng });
            const [nextLat, nextLng] = projector.unproject([x + deltaX, y + deltaY]);
            return [nextLng, nextLat];
        });
    }

    function moveGeometryCenter(projector, geometry, target) {
        if (!projector || !target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return null;
        const center = projectedGeometryCenter(projector, geometry);
        if (!center) return null;
        const targetPoint = projector.project(target);
        return translateGeometry(projector, geometry, targetPoint[0] - center[0], targetPoint[1] - center[1]);
    }

    function rotateGeometry(projector, geometry, rotationDeg) {
        const degrees = Number(rotationDeg);
        if (!projector || !Number.isFinite(degrees)) return null;
        const center = projectedGeometryCenter(projector, geometry);
        if (!center) return null;
        const angle = degrees * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return mapGeometryCoordinates(geometry, ([lng, lat]) => {
            const [x, y] = projector.project({ lat, lng });
            const dx = x - center[0];
            const dy = y - center[1];
            const [nextLat, nextLng] = projector.unproject([
                center[0] + dx * cos - dy * sin,
                center[1] + dx * sin + dy * cos
            ]);
            return [nextLng, nextLat];
        });
    }

    // projector: { project({lat,lng}) -> [x,y] Mercator metres, unproject([x,y]) -> [lat,lng] }.
    // Returns a closed [lng,lat] ring of a rotated rectangle centred on `center`, sized in GROUND
    // metres. The freeform editor uses equal width/length for its initial square.
    function buildRectangleRing(projector, center, params = {}) {
        if (!projector || !center) return null;
        const widthM = Number(params.widthM);
        const lengthM = Number(params.lengthM);
        if (!Number.isFinite(widthM) || !Number.isFinite(lengthM)) return null;
        const rotationDeg = Number(params.rotationDeg) || 0;

        const halfW = Math.max(0.5, widthM / 2);
        const halfL = Math.max(0.5, lengthM / 2);

        // Ground metres → Mercator units at this latitude. Web-Mercator scale is 1/cos(φ), so a
        // ground distance d spans d/cos(φ) in projected space. Without this the building shrinks by
        // cos(φ) on the ground.
        const latRad = center.lat * Math.PI / 180;
        const s = 1 / Math.cos(latRad);

        const [cx, cy] = projector.project(center);
        const left = -halfW * s, right = halfW * s, bottom = -halfL * s, top = halfL * s;
        const pts = [
            [left, bottom],
            [right, bottom],
            [right, top],
            [left, top]
        ];

        const angleRad = (rotationDeg * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);

        const ring = pts.map(([x, y]) => {
            const rx = x * cos - y * sin;
            const ry = x * sin + y * cos;
            const [lat, lng] = projector.unproject([cx + rx, cy + ry]);
            return [lng, lat];
        });

        return ensureClosedRing(ring);
    }

    const api = {
        buildRectangleRing,
        ensureClosedRing,
        isSimpleRing,
        projectedGeometryCenter,
        translateGeometry,
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
