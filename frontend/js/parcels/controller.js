(function (global) {
    'use strict';

    function handleMoveEnd(map, options) {
        if (!map) return;
        if (!map._loaded || typeof map.getBounds !== 'function') {
            return;
        }
        var parcelFetchConfig = options && options.parcelFetchConfig;
        var resolveParcelLayer = options && options.resolveParcelLayer ? options.resolveParcelLayer : function () { return null; };
        var isZoomWithinParcelRange = options && options.isZoomWithinParcelRange ? options.isZoomWithinParcelRange : function () { return true; };

        // When opening via proposal deep links, skip parcel fetches entirely until proposal flow finishes
        if (typeof global.skipParcelFetchUntilProposalLoaded !== 'undefined' && global.skipParcelFetchUntilProposalLoaded) {
            return;
        }
        // Skip parcel fetching if camera movement is suppressed (e.g., when showing proposal contours)
        if (typeof global.suppressCameraMoves !== 'undefined' && global.suppressCameraMoves) {
            return;
        }

        // Handle buildings update
        try {
            var showBuildings = document.getElementById('showBuildings');
            if (showBuildings && showBuildings.checked && typeof global.fetchBuildings === 'function') {
                if (typeof global.buildingsTimeout !== 'undefined') {
                    clearTimeout(global.buildingsTimeout);
                }
                global.buildingsTimeout = setTimeout(global.fetchBuildings, 1000);
            }
        } catch (_) { /* ignore */ }

        var bounds = map.getBounds();
        if (!isZoomWithinParcelRange()) {
            var layerRef = resolveParcelLayer();
            if (layerRef && map.hasLayer(layerRef)) {
                try { map.removeLayer(layerRef); } catch (_) { }
            }
            global.updateStatus?.('Parcels disabled at this zoom');
            global.updateVisibleParcelsCount?.();
            return;
        }

        if (typeof global.parcelsTimeout !== 'undefined') clearTimeout(global.parcelsTimeout);
        var debounceMs = parcelFetchConfig && typeof parcelFetchConfig.getDebounce === 'function'
            ? parcelFetchConfig.getDebounce()
            : 500;
        global.parcelsTimeout = setTimeout(function () {
            if (typeof global.fetchParcelData !== 'function') return;
            // No cache inspection here. The repository returns immediately when this exact ground
            // is already retained and joins an existing request when another consumer got there first.
            global.fetchParcelData(bounds)
                .then(function () { global.ParcelPresenter?.restoreSelectionStyles?.(); })
                .catch(function (error) { console.error('[ParcelFetchController] cadastral ground unavailable', error); });
        }, debounceMs);

        if (typeof global.updateVisibleParcelsCount === 'function') {
            global.updateVisibleParcelsCount();
        }
    }

    global.ParcelFetchController = {
        handleMoveEnd: handleMoveEnd
    };
})(typeof window !== 'undefined' ? window : globalThis);
