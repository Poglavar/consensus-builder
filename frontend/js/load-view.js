// The area the map's data layers load for: the 2D map's view in 2D; in 3D, the 3D camera's zoom
// around where the scene was entered (the 2D map stays there; the 3D scene does not stream as the
// camera pans). Layers that load by viewport (permitted massing, Explore's designs) read
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
    // The ground a 3D camera `range` metres from its target shows, as a square around `centre`
    // ([lat, lng]) `range` metres to each side, and the 2D zoom at which a map `widthPx` wide shows
    // that width.
    function ofCamera(view, centre, widthPx) {
        if (!view || !finite(view.range) || !Array.isArray(centre) || !finite(centre[0]) || !finite(centre[1]) || !(widthPx > 0)) return null;
        const [lat, lng] = centre, cos = Math.cos(lat * Math.PI / 180);
        const half = Math.max(view.range, MIN_HALF_SIDE_M);
        const dLat = half / METRES_PER_DEG_LAT, dLng = half / (METRES_PER_DEG_LNG * cos);
        return { mode: '3d', bbox: [lng - dLng, lat - dLat, lng + dLng, lat + dLat], centre: [lat, lng],
            zoom: Math.log2(METRES_PER_PIXEL_Z0 * cos * widthPx / (2 * half)) };
    }
    function browser(win) {
        function current() {
            const map = win.map;
            if (!map || typeof map.getBounds !== 'function') return null;
            const centre = map.getCenter();
            const three = typeof win.isThreeModeActive === 'function' && win.isThreeModeActive();
            const camera = three ? ofCamera(win.getThree3DGeoView?.(), [centre.lat, centre.lng], map.getSize().x) : null;
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
    return { ofCamera, browser, MIN_HALF_SIDE_M };
});
