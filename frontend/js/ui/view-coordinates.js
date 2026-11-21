// The view's coordinates at the top of the Layers sheet, copied with a click: the 2D map's centre or,
// in 3D, the point the camera looks at (MapShare.position, as the address writes it). Pasted into
// the search box, the same text goes back to that point (ui/search-model.js parseCoordinates).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) {
        root.ViewCoordinates = api;
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.install(root), { once: true });
        else api.install(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function install(win) {
        const doc = win.document;
        const button = doc.getElementById('view-coordinates-copy');
        const text = doc.getElementById('view-coordinates-text');
        if (!button || !text) return;
        if (!win.MapShare || !win.SearchModel || !win.map) throw new Error('ViewCoordinates: MapShare, SearchModel and the map must load first');
        const translate = (key, params, fallback) => {
            const value = win.i18n?.t(key, params);
            return value && value !== key ? value : fallback;
        };
        const current = () => {
            const { lat, lng } = win.MapShare.position(win);
            return win.SearchModel.formatCoordinates({ lat, lon: lng });
        };
        let shown = null;
        const render = () => {
            const coordinates = current();
            if (coordinates === shown) return;
            shown = coordinates;
            button.hidden = coordinates === null;
            text.textContent = coordinates || '';
            const label = translate('mapShell.viewCoordinates', { coordinates }, `Copy the coordinates of the view's centre: ${coordinates}`);
            button.title = label;
            button.setAttribute('aria-label', label);
        };
        // Copies what the view is at now, also mid-move; "Copied" is the shared copy feedback.
        button.addEventListener('click', () => {
            render();
            if (shown) win.copyTextWithFeedback(shown);
        });
        win.map.on('moveend', render);
        // The 3D camera reports every frame while it moves; the text follows it live.
        win.addEventListener('threecamerachange', render);
        win.addEventListener('loadviewchange', render);
        const relabel = () => { shown = null; render(); };
        win.i18n?.onChange?.(relabel);
        win.addEventListener('i18n:translationsLoaded', relabel);
        render();
    }

    return { install };
});
