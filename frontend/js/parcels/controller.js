(function (global) {
    'use strict';

    function isTwoDimensionalViewportActive() {
        var mode = global.__mapModeState;
        if (mode && (mode.pending || mode.desired !== '2d')) return false;
        return typeof global.isThreeModeActive !== 'function' || !global.isThreeModeActive();
    }

    function handleMoveEnd(map, options) {
        if (!map || !isTwoDimensionalViewportActive() || global.ParcelPresenter?.isVisible?.() === false) return;
        if (!map._loaded || typeof map.getBounds !== 'function') {
            return;
        }
        var parcelFetchConfig = options && options.parcelFetchConfig;

        // When opening via proposal deep links, skip parcel fetches entirely until proposal flow finishes
        if (typeof global.skipParcelFetchUntilProposalLoaded !== 'undefined' && global.skipParcelFetchUntilProposalLoaded) {
            return;
        }
        // Skip parcel fetching if camera movement is suppressed (e.g., when showing proposal contours)
        if (typeof global.suppressCameraMoves !== 'undefined' && global.suppressCameraMoves) {
            return;
        }

        // Buildings follow the map from map-core.js's moveend handler (one debounced fetch per pan
        // for every survey switched on); this controller handles parcels only.

        // No cadastre here (the explore city): only a chosen session plan needs viewport updates.
        if (global.CityConfigManager && typeof global.CityConfigManager.hasParcelData === 'function'
            && !global.CityConfigManager.hasParcelData()
            && !global.ParcelGroundFallback?.activeSource?.(global.CityConfigManager.getCurrentCityId())) {
            return;
        }

        if (typeof global.parcelsTimeout !== 'undefined') clearTimeout(global.parcelsTimeout);
        var debounceMs = parcelFetchConfig && typeof parcelFetchConfig.getDebounce === 'function'
            ? parcelFetchConfig.getDebounce()
            : 500;
        global.parcelsTimeout = setTimeout(function () {
            global.parcelsTimeout = null;
            if (!isTwoDimensionalViewportActive() || global.ParcelPresenter?.isVisible?.() === false) return;
            if (typeof global.fetchParcelData !== 'function') return;
            // No cache inspection here. The repository returns immediately when this exact ground
            // is already retained and joins an existing request when another consumer got there first.
            global.fetchParcelData(map.getBounds(), { viewport: true })
                .catch(function (error) {
                    if (typeof global.reportParcelFetchFailure === 'function') global.reportParcelFetchFailure(error, 'map move');
                    else console.error('[' + new Date().toISOString() + '] [ParcelFetchController] cadastral ground unavailable', error);
                });
        }, debounceMs);

        if (typeof global.updateVisibleParcelsCount === 'function') {
            global.updateVisibleParcelsCount();
        }
    }

    global.ParcelFetchController = {
        handleMoveEnd: handleMoveEnd
    };
})(typeof window !== 'undefined' ? window : globalThis);
