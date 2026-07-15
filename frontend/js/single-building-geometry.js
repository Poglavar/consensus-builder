// The rectangle footprint for a single building, built in a Web-Mercator projector's space.
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

    // projector: { project({lat,lng}) -> [x,y] Mercator metres, unproject([x,y]) -> [lat,lng] }.
    // Returns a closed [lng,lat] ring of a chamfered, rotated rectangle centred on `center`, sized in
    // GROUND metres.
    function buildRectangleRing(projector, center, params = {}) {
        if (!projector || !center) return null;
        const widthM = Number(params.widthM);
        const lengthM = Number(params.lengthM);
        if (!Number.isFinite(widthM) || !Number.isFinite(lengthM)) return null;
        const chamferM = Number(params.chamferM) || 0;
        const rotationDeg = Number(params.rotationDeg) || 0;

        const halfW = Math.max(0.5, widthM / 2);
        const halfL = Math.max(0.5, lengthM / 2);
        const maxChamferX = Math.max(0, halfW - 0.1);
        const maxChamferY = Math.max(0, halfL - 0.1);
        const dX = Math.min(Math.max(0, chamferM), maxChamferX);
        const dY = Math.min(Math.max(0, chamferM), maxChamferY);

        // Ground metres → Mercator units at this latitude. Web-Mercator scale is 1/cos(φ), so a
        // ground distance d spans d/cos(φ) in projected space. Without this the building shrinks by
        // cos(φ) on the ground.
        const latRad = center.lat * Math.PI / 180;
        const s = 1 / Math.cos(latRad);

        const [cx, cy] = projector.project(center);
        const left = -halfW * s, right = halfW * s, bottom = -halfL * s, top = halfL * s;
        const dXs = dX * s, dYs = dY * s;

        let pts;
        if (dX > 0 || dY > 0) {
            pts = [
                [left + dXs, bottom],
                [right - dXs, bottom],
                [right, bottom + dYs],
                [right, top - dYs],
                [right - dXs, top],
                [left + dXs, top],
                [left, top - dYs],
                [left, bottom + dYs]
            ];
        } else {
            pts = [
                [left, bottom],
                [right, bottom],
                [right, top],
                [left, top]
            ];
        }

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

    const api = { buildRectangleRing, ensureClosedRing };

    if (typeof window !== 'undefined') {
        window.SingleBuildingGeometry = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
