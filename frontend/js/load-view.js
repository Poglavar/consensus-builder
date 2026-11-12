// The area the map's data layers load for, and the one zoom their gates read in both modes: the
// 2D map's view in 2D; in 3D, the 2D view the camera stands for (ofCamera), around the camera's
// target. At a mode switch both give the same zoom and area, so a layer shown in one mode stays
// shown in the other. Layers that load by viewport (permitted massing, Explore's designs) read
// `LoadView.current()` and reload on the map's moveend and on `loadviewchange`, which fires when
// the 3D camera settles and when the map changes mode.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.LoadView = Object.freeze({ ...api, ...api.browser(root) });
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    // Metres per pixel at zoom 0 on the equator (256 px Web Mercator tiles).
    const METRES_PER_PIXEL_Z0 = 156543.03392804097;
    const METRES_PER_DEG_LAT = 110570;
    const METRES_PER_DEG_LNG = 111320;
    // A camera nearer its target than this still loads a street's width around it.
    const MIN_HALF_SIDE_M = 75;
    // The camera fires a change every frame while it moves; the view counts as settled after this.
    const SETTLE_MS = 400;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // The 2D view a 3D camera stands for: the zoom whose straight-down view, in a viewport as tall
    // as the 3D one, shows the ground a camera at this height above its target shows with its
    // vertical field of view. Entering 3D frames the 2D view by exactly this rule (three-mode.js
    // initScene puts the camera at the top-down distance of the 2D bounds), so at the switch both
    // modes report the same zoom. Tilting at a fixed distance lowers the camera and raises the
    // zoom, as moving closer does. The area is that view's rectangle around the camera target,
    // which at the switch is the 2D map's bounds. `view` is getThree3DGeoView()'s (range in true
    // metres, pitchRad 0 = horizon, -π/2 = straight down); `viewport` is getThree3DViewport()'s.
    // The zoom is rounded to 1/1000 so a switch never lands a hair under a gate it was on.
    function ofCamera(view, viewport) {
        if (!view || ![view.range, view.targetLat, view.targetLng].every(finite) || !viewport
            || !(viewport.widthPx > 0) || !(viewport.heightPx > 0) || !(viewport.fovDeg > 0 && viewport.fovDeg < 180)) return null;
        const lat = view.targetLat, lng = view.targetLng, cos = Math.cos(lat * Math.PI / 180);
        const elevation = finite(view.pitchRad) ? Math.min(Math.PI / 2, Math.max(0, -view.pitchRad)) : Math.PI / 2;
        const heightM = Math.max(view.range * Math.sin(elevation), 1);
        const metresPerPixel = 2 * heightM * Math.tan(viewport.fovDeg * Math.PI / 360) / viewport.heightPx;
        const halfW = Math.max(viewport.widthPx * metresPerPixel / 2, MIN_HALF_SIDE_M);
        const halfH = Math.max(viewport.heightPx * metresPerPixel / 2, MIN_HALF_SIDE_M);
        const dLat = halfH / METRES_PER_DEG_LAT, dLng = halfW / (METRES_PER_DEG_LNG * cos);
        return { mode: '3d', bbox: [lng - dLng, lat - dLat, lng + dLng, lat + dLat], centre: [lat, lng],
            zoom: Math.round(Math.log2(METRES_PER_PIXEL_Z0 * cos / metresPerPixel) * 1000) / 1000 };
    }
    // The 2D zoom on leaving 3D: the camera's, but never outside the 2D parcel zoom range when
    // parcels were showing as 3D was entered. Below that range 2D switches parcels and buildings
    // off for performance, so the ground the 3D view showed would vanish on the switch; a camera
    // farther out returns to 2D at the range's edge, a narrower view of the same place.
    function returnZoom(cameraZoom, { parcelRange = null, parcelsShown = false } = {}) {
        if (!finite(cameraZoom)) return null;
        if (!parcelsShown || !parcelRange) return cameraZoom;
        const min = finite(parcelRange.min) ? parcelRange.min : -Infinity, max = finite(parcelRange.max) ? parcelRange.max : Infinity;
        return Math.min(max, Math.max(min, cameraZoom));
    }
    function browser(win) {
        function current() {
            const map = win.map;
            if (!map || typeof map.getBounds !== 'function') return null;
            const centre = map.getCenter();
            const three = typeof win.isThreeModeActive === 'function' && win.isThreeModeActive();
            const camera = three ? ofCamera(win.getThree3DGeoView?.(), win.getThree3DViewport?.()) : null;
            if (camera) return camera;
            const bounds = map.getBounds();
            return { mode: '2d', bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                centre: [centre.lat, centre.lng], zoom: map.getZoom() };
        }
        let timer = null;
        const announce = () => { timer = null; win.dispatchEvent(new Event('loadviewchange')); };
        win.addEventListener('threecamerachange', () => { if (timer) clearTimeout(timer); timer = setTimeout(announce, SETTLE_MS); });
        win.addEventListener('mapmodechange', event => {
            const mode = event.detail || win.__mapModeState;
            if (mode && mode.pending) return;
            if (timer) clearTimeout(timer);
            announce();
        });
        return { current };
    }
    return { ofCamera, returnZoom, browser, MIN_HALF_SIDE_M };
});
