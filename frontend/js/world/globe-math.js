// Pure maths for the world-view globe: lat/lon <-> unit-sphere vectors, ray picking, camera fly-to
// interpolation and the globe-altitude -> Leaflet-zoom handoff. No three.js, no DOM; UMD so it is
// window.GlobeMath in the browser and require()-able in node tests.
//
// Sphere convention matches three.js SphereGeometry's default UVs, so an equirectangular texture
// (u = 0 at lon -180) lands where these vectors say: lon 0 -> +X, lon 90 -> -Z, north pole -> +Y.
//   x = cos(lat) cos(lon),  y = sin(lat),  z = -cos(lat) sin(lon)
// Distances are in globe radii (1 = EARTH_RADIUS_KM).
//
// API
//   latLonToVector(lat, lon, radius=1) -> [x, y, z]
//   vectorToLatLon([x, y, z]) -> { lat, lon }
//   raySphere(origin, direction, radius=1) -> [x, y, z] | null   nearest hit in front of the origin
//   angularDistance(a, b) -> radians between two {lat, lon}
//   slerpLatLon(a, b, t) -> { lat, lon }                         great-circle interpolation
//   flyInterpolate(from, to, t, opts) -> { lat, lon, altitudeKm } camera state along a flight
//   easeInOutCubic(t), easeOutCubic(t)
//   altitudeToLeafletZoom(altitudeKm, latitude, viewportPx, fovDeg=40) -> fractional zoom
//   leafletZoomToAltitude(zoom, latitude, viewportPx, fovDeg=40) -> km (inverse)
//   wheelDeltaPixels(deltaY, deltaMode, viewportPx) -> pixel-equivalent wheel distance
//   dampAltitude(current, target, dtSeconds) -> altitude, easing geometrically toward the target
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.GlobeMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EARTH_RADIUS_KM = 6371;
    const DEG = Math.PI / 180;
    // Leaflet/Web-Mercator metres per pixel at zoom 0 on the equator (256 px tiles).
    const MERCATOR_M_PER_PX_Z0 = 156543.03392;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wrapLon = lon => ((((lon + 180) % 360) + 360) % 360) - 180;

    function latLonToVector(lat, lon, radius) {
        const r = radius === undefined ? 1 : radius;
        const phi = lat * DEG; const lam = lon * DEG;
        return [r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam)];
    }

    function vectorToLatLon(v) {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        const lat = Math.asin(clamp(v[1] / len, -1, 1)) / DEG;
        const lon = Math.atan2(-v[2], v[0]) / DEG;
        return { lat, lon: wrapLon(lon) };
    }

    function raySphere(origin, direction, radius) {
        const r = radius === undefined ? 1 : radius;
        const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1;
        const d = [direction[0] / dl, direction[1] / dl, direction[2] / dl];
        const b = origin[0] * d[0] + origin[1] * d[1] + origin[2] * d[2];
        const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - r * r;
        const disc = b * b - c;
        if (disc < 0) return null;
        const sq = Math.sqrt(disc);
        let t = -b - sq;
        if (t < 0) t = -b + sq;
        if (t < 0) return null;
        return [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t];
    }

    function angularDistance(a, b) {
        const va = latLonToVector(a.lat, a.lon); const vb = latLonToVector(b.lat, b.lon);
        const dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
        return Math.acos(dot);
    }

    function slerpLatLon(a, b, t) {
        const va = latLonToVector(a.lat, a.lon); const vb = latLonToVector(b.lat, b.lon);
        const omega = angularDistance(a, b);
        if (omega < 1e-9) return { lat: a.lat, lon: a.lon };
        if (Math.abs(omega - Math.PI) < 1e-6) {
            // Antipodal: any great circle works; go over the pole-side midpoint for a defined path.
            const mid = { lat: clamp(90 - Math.abs(a.lat), -89, 89), lon: wrapLon(a.lon + 90) };
            return t < 0.5 ? slerpLatLon(a, mid, t * 2) : slerpLatLon(mid, b, (t - 0.5) * 2);
        }
        const s = Math.sin(omega);
        const wa = Math.sin((1 - t) * omega) / s; const wb = Math.sin(t * omega) / s;
        return vectorToLatLon([va[0] * wa + vb[0] * wb, va[1] * wa + vb[1] * wb, va[2] * wa + vb[2] * wb]);
    }

    const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

    function wheelDeltaPixels(deltaY, deltaMode, viewportPx) {
        return deltaY * (deltaMode === 1 ? 30 : deltaMode === 2 ? viewportPx : 1);
    }

    // A wheel notch changes the target, not the camera in one jump. Damping in log space keeps
    // the apparent zoom speed consistent at every altitude and across display refresh rates.
    function dampAltitude(current, target, dtSeconds) {
        const remaining = Math.log(target / current) * Math.exp(-Math.max(0, dtSeconds) / 0.065);
        return Math.abs(remaining) < 0.0001 ? target : target * Math.exp(-remaining);
    }

    // Camera state along a flight from `from` to `to` ({lat, lon, altitudeKm}) at t in [0, 1].
    // The look direction follows the great circle with ease-in-out; altitude interpolates
    // geometrically (so a dive slows as it nears the ground) plus a "hop" that lifts long flights so
    // the destination swings into view instead of skimming the surface. opts.hop scales it (0 = none).
    function flyInterpolate(from, to, t, opts) {
        const tt = clamp(t, 0, 1);
        const hopScale = opts && typeof opts.hop === 'number' ? opts.hop : 1;
        const e = easeInOutCubic(tt);
        const pos = slerpLatLon(from, to, e);
        const a0 = Math.max(1, from.altitudeKm); const a1 = Math.max(1, to.altitudeKm);
        // Altitude leads the rotation slightly when diving so the point is centred before the plunge.
        const ea = a1 < a0 ? easeInOutCubic(clamp((tt - 0.15) / 0.85, 0, 1)) : easeInOutCubic(tt);
        const base = a0 * Math.pow(a1 / a0, ea);
        const arc = angularDistance(from, to);
        const hop = hopScale * EARTH_RADIUS_KM * 0.6 * (arc / Math.PI) * Math.sin(Math.PI * tt);
        const altitudeKm = tt === 0 ? from.altitudeKm : tt === 1 ? to.altitudeKm : base + hop;
        return { lat: tt === 1 ? to.lat : pos.lat, lon: tt === 1 ? to.lon : pos.lon, altitudeKm };
    }

    // Ground width (km) visible across `viewportPx` at the screen centre for a camera at altitudeKm
    // with vertical field of view fovDeg, looking straight down. Uses the tangent-plane
    // approximation, which is what matters at handoff altitudes (a few to a few hundred km).
    function visibleGroundKm(altitudeKm, fovDeg) {
        return 2 * altitudeKm * Math.tan(((fovDeg || 40) * DEG) / 2);
    }

    function altitudeToLeafletZoom(altitudeKm, latitude, viewportPx, fovDeg) {
        const px = viewportPx > 0 ? viewportPx : 800;
        const metresPerPx = (visibleGroundKm(Math.max(0.01, altitudeKm), fovDeg) * 1000) / px;
        const cosLat = Math.max(0.01, Math.cos((latitude || 0) * DEG));
        return Math.log2((MERCATOR_M_PER_PX_Z0 * cosLat) / metresPerPx);
    }

    function leafletZoomToAltitude(zoom, latitude, viewportPx, fovDeg) {
        const px = viewportPx > 0 ? viewportPx : 800;
        const cosLat = Math.max(0.01, Math.cos((latitude || 0) * DEG));
        const metresPerPx = (MERCATOR_M_PER_PX_Z0 * cosLat) / Math.pow(2, zoom);
        return (metresPerPx * px) / 1000 / (2 * Math.tan(((fovDeg || 40) * DEG) / 2));
    }

    return {
        EARTH_RADIUS_KM, clamp, wrapLon, latLonToVector, vectorToLatLon, raySphere, angularDistance, slerpLatLon,
        easeInOutCubic, easeOutCubic, wheelDeltaPixels, dampAltitude,
        flyInterpolate, visibleGroundKm, altitudeToLeafletZoom, leafletZoomToAltitude
    };
});
