// A public share names published designs and their view; it does not convey consent.
// The browser captures before any selection panel changes the map; the URL helpers are pure.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MapShare = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const fields = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
    function readCamera(value) {
        try {
            if (typeof value !== 'string' || value.split(',').some(part => !part.trim())) return null;
            const parts = value.split(',').map(Number);
            if (parts.length !== fields.length || !parts.every(Number.isFinite)) return null;
            const [lat, lng, , pitch, range] = parts;
            if (Math.abs(lat) > 85.0511 || Math.abs(lng) > 180 || pitch < -Math.PI / 2 || pitch > 0 || range < 1) return null;
            return Object.fromEntries(fields.map((key, index) => [key, parts[index]]));
        } catch (_) { return null; }
    }
    function capture(win) {
        const center = win.map.getCenter();
        const mode = win.__mapModeState?.desired || '2d';
        const settings = win.PlanningScene?.settings(win.PlanningViews?.getState());
        const source = new URLSearchParams(win.location?.search || '');
        if (settings) for (const key of ['planningSource', 'planningScenario']) {
            if (source.has(key)) settings[key] = source.get(key);
        }
        return { mode, at: [center.lat, center.lng, win.map.getZoom()].join(','),
            camera: mode === '2d' ? null : win.getThree3DGeoView?.(),
            rotate: mode !== '2d' && source.get('rotate') === '1',
            language: win.i18n?.getLanguage?.(),
            ...(source.has('backend') ? { backend: source.get('backend') } : {}),
            ...(settings ? { settings } : {}),
            city: win.CityConfigManager?.getCurrentCityId?.() };
    }
    function link(base, context) {
        const url = new URL(base);
        for (const key of ['3d', 'photo', 'model', 'mode3d', 'real', 'rl', 'rw', 'camera', 'rotate', 'draft']) url.searchParams.delete(key);
        url.searchParams.set('at', context.at);
        if (context.city) url.searchParams.set('city', context.city);
        if (context.language) url.searchParams.set('lang', context.language);
        if (context.backend) url.searchParams.set('backend', context.backend);
        for (const [key, value] of Object.entries(context.settings || {})) url.searchParams.set(key, value);
        if (context.mode === 'model') url.searchParams.set('3d', '');
        if (context.mode === 'photo') url.searchParams.set('photo', '');
        if (context.camera) url.searchParams.set('camera', fields.map(key => context.camera[key]).join(','));
        if (context.mode !== '2d') url.searchParams.set('rotate', context.rotate === true ? '1' : '0');
        return url.toString();
    }
    function arrivalOptions(search) {
        const params = new URLSearchParams(search);
        return { restoreView: readCamera(params.get('camera')), rotate: params.get('rotate') === '1' };
    }
    return Object.freeze({ readCamera, capture, link, arrivalOptions });
});
