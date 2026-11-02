// A short-lived block result highlight with a message that leaves the underlying selection alone.
(function (root, factory) {
    const create = factory;
    const api = create(root);
    if (typeof module === 'object' && module.exports) module.exports = { ...api, create };
    if (root) root.BlockDetectionPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function create(root) {
    'use strict';
    const MAX_FEATURES = 100;
    const t = (key, fallback) => {
        const value = root?.i18n?.t?.(key);
        return value && value !== key ? value : fallback;
    };

    function show(features, { message = '', title = '' } = {}) {
        const win = root;
        const map = win?.map;
        const L = win?.L;
        if (!Array.isArray(features)) return Promise.reject(new TypeError('Block preview features must be an array.'));
        if (!map || !L?.geoJSON || !win?.CbDialog?.open) return Promise.resolve(null);

        const shown = features.filter(feature => feature?.type === 'Feature').slice(0, MAX_FEATURES);
        let layer = null, dialog = null, previousView = null, fitted = false, cleaned = false;
        const cityAtOpen = win.CityConfigManager?.getCurrentCityId?.() || win.currentCityId || win.currentCity || null;
        const modeAtOpen = win.isThreeModeActive?.() === true;

        function restoreView() {
            if (!fitted || win.map !== map) return;
            const cityNow = win.CityConfigManager?.getCurrentCityId?.() || win.currentCityId || win.currentCity || null;
            if (cityNow !== cityAtOpen || (win.isThreeModeActive?.() === true) !== modeAtOpen) return;
            try { map.setView(previousView.center, previousView.zoom, { animate: false }); } catch (_) { /* map may be unloading */ }
        }
        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            try {
                if (layer && typeof map.removeLayer === 'function') map.removeLayer(layer);
                else layer?.remove?.();
            } catch (_) { /* map may already be unloading */ }
            restoreView();
        }

        try {
            const highlight = win.MapHighlight;
            if (!highlight?.style) return Promise.resolve(null);
            layer = L.geoJSON(shown, { renderer: L.svg(), interactive: false,
                style: highlight.style({ className: 'block-detection-preview' }) });
            layer.addTo(map);

            const bounds = layer.getBounds?.();
            const currentBounds = map.getBounds?.();
            if (!modeAtOpen && bounds?.isValid?.() && currentBounds?.contains && !currentBounds.contains(bounds)) {
                previousView = { center: map.getCenter(), zoom: map.getZoom() };
                map.fitBounds(bounds, { padding: [32, 32], maxZoom: map.getZoom(), animate: false });
                fitted = true;
            }

            const body = win.document.createElement('p');
            body.textContent = String(message ?? '');
            dialog = win.CbDialog.open({
                title: String(title || t('panel.parcel.detectBlock', 'Detect block')),
                size: 'sm',
                className: 'block-detection-preview-dialog',
                overlayClassName: 'block-detection-preview-overlay',
                role: 'alertdialog',
                body,
                closeLabel: t('common.close', 'Close'),
                closeOnBackdrop: false,
                actions: [{ id: 'ok', label: t('common.ok', 'OK'), role: 'primary', autofocus: true }],
                onClose: cleanup
            });
            if (!dialog?.closed?.then) {
                cleanup();
                return Promise.resolve(null);
            }
            return Promise.resolve(dialog.closed).then(result => {
                cleanup();
                return result;
            }, error => {
                cleanup();
                throw error;
            });
        } catch (error) {
            try { dialog?.close?.(null); } catch (_) { /* preserve the original error */ }
            cleanup();
            return Promise.reject(error);
        }
    }

    return { show };
});
