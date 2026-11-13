// The view's zoom beside the Layers heading: the 2D map's zoom in 2D and, in 3D, the 2D zoom the
// camera stands for (LoadView.current), which is the number every zoom-gated layer reads.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) {
        root.ViewZoom = api;
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.install(root), { once: true });
        else api.install(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // One decimal place: 2D zoom steps are whole numbers, while a 3D camera usually sits between them.
    function formatZoom(zoom, locale) {
        if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return null;
        return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 1 }).format(Math.round(zoom * 10) / 10);
    }

    function install(win) {
        const doc = win.document;
        const sheet = doc.getElementById('layers-sheet');
        const badge = doc.getElementById('layers-sheet-zoom');
        if (!sheet || !badge) return;
        if (!win.LoadView || !win.map) throw new Error('ViewZoom: LoadView and the map must load first');
        const translate = (key, params, fallback) => {
            const text = win.i18n?.t(key, params);
            return text && text !== key ? text : fallback;
        };
        const render = () => {
            if (sheet.hidden) return;
            const zoom = formatZoom(win.LoadView.current()?.zoom, win.i18n?.getLocale?.());
            badge.hidden = zoom === null;
            if (zoom === null) return;
            const label = translate('mapShell.zoomLevel', { zoom }, `Zoom ${zoom}`);
            if (badge.textContent !== label) badge.textContent = label;
        };
        const relabel = () => {
            badge.title = translate('mapShell.zoomLevelTitle', {}, badge.title);
            badge.textContent = '';
            render();
        };
        win.map.on('zoomend', render);
        // The camera reports every frame while it moves; the badge follows it live.
        win.addEventListener('threecamerachange', render);
        win.addEventListener('loadviewchange', render);
        doc.addEventListener('mapshell:sheetopened', event => { if (event.detail?.id === sheet.id) render(); });
        win.i18n?.onChange?.(relabel);
        win.addEventListener('i18n:translationsLoaded', relabel);
        relabel();
    }

    return { formatZoom, install };
});
