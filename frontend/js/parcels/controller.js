(function (global) {
    'use strict';

    function handleMoveEnd(map, options) {
        if (!map) return;
        if (!map._loaded || typeof map.getBounds !== 'function') {
            return;
        }
        var parcelFetchConfig = options && options.parcelFetchConfig;
        var resolveParcelCache = options && options.resolveParcelCache ? options.resolveParcelCache : function () { return null; };
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
        var cache = resolveParcelCache();
        if (typeof global.getRequiredGridCells === 'function' && cache && cache.grid) {
            if (!isZoomWithinParcelRange()) {
                var layerRef = resolveParcelLayer();
                if (layerRef && map.hasLayer(layerRef)) {
                    try { map.removeLayer(layerRef); } catch (_) { }
                }
                if (typeof global.updateStatus === 'function') global.updateStatus('Parcels disabled at this zoom');
                if (typeof global.updateVisibleParcelsCount === 'function') {
                    global.updateVisibleParcelsCount();
                }
                return;
            }
            var latLngPadding = parcelFetchConfig && typeof parcelFetchConfig.getPadding === 'function'
                ? parcelFetchConfig.getPadding()
                : 0.12;
            var expandedBounds = (bounds && typeof bounds.pad === 'function' && latLngPadding > 0)
                ? bounds.pad(latLngPadding)
                : bounds;
            var gridRadius = (parcelFetchConfig && typeof parcelFetchConfig.getGridRadius === 'function')
                ? parcelFetchConfig.getGridRadius()
                : 0;
            var requiredCells = global.getRequiredGridCells(expandedBounds, gridRadius);
            var missingCells = Array.from(requiredCells).filter(function (cell) { return !cache.grid.has(cell); });

            if (typeof global.parcelsTimeout !== 'undefined') {
                clearTimeout(global.parcelsTimeout);
            }
            if (missingCells.length === 0) {
                var layerRefCached = resolveParcelLayer();
                if (layerRefCached) {
                    if (typeof global.selectedParcelId !== 'undefined' && global.selectedParcelId) {
                        var layer = layerRefCached.getLayers().find(function (l) {
                            var pid = global.ensureParcelId ? global.ensureParcelId(l.feature) : (l.feature && l.feature.properties && (l.feature.properties.parcelId || l.feature.properties.parcel_id));
                            return pid && pid.toString() === global.selectedParcelId;
                        });
                        if (layer) {
                            const isTrackSelected = (layer?.feature?.properties?.isTrack === true) || Boolean(layer?._trackStyle);
                            if (isTrackSelected) {
                                const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                                const trackStyle = styleFn ? styleFn(global.selectedParcelId, layer, { isTrack: true }) : (global.trackStyle || {});
                                layer.setStyle({ ...trackStyle, weight: 4 });
                            } else if (typeof global.selectedParcelStyle !== 'undefined') {
                                layer.setStyle(global.selectedParcelStyle);
                            }
                            if (typeof layer.bringToFront === 'function') layer.bringToFront();
                        }
                    }
                }
            } else {
                var baseDebounce = parcelFetchConfig && typeof parcelFetchConfig.getDebounce === 'function'
                    ? parcelFetchConfig.getDebounce()
                    : 500;
                var missingCount = missingCells.length;
                var debounceMs = (function () {
                    if (missingCount <= 2) return Math.max(150, baseDebounce - 200);
                    if (missingCount >= 8) return Math.min(baseDebounce + 300, 1200);
                    return baseDebounce;
                })();

                global.parcelsTimeout = setTimeout(function () {
                    if (typeof global.fetchParcelData === 'function') {
                        global.fetchParcelData(expandedBounds).then(function () {
                            if (typeof global.deduplicateParcelLayer === 'function' && map._loaded) {
                                var tDedupStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                                var removed = global.deduplicateParcelLayer();
                                var dedupMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tDedupStart;
                                if (removed > 0) {
                                    console.warn('[map-core] Removed ' + removed + ' duplicate parcel layer(s) after fetch in ' + (dedupMs.toFixed ? dedupMs.toFixed(1) : dedupMs) + 'ms');
                                } else if (typeof console !== 'undefined' && console.log) {
                                    console.log('[map-core] Deduplication skipped/clean in ' + (dedupMs.toFixed ? dedupMs.toFixed(1) : dedupMs) + 'ms');
                                }
                            }
                            var layerRefAfterFetch = resolveParcelLayer();
                            if (typeof global.selectedParcelId !== 'undefined' && global.selectedParcelId && layerRefAfterFetch) {
                                var layerFetched = layerRefAfterFetch.getLayers().find(function (l) {
                                    var pid2 = global.ensureParcelId ? global.ensureParcelId(l.feature) : (l.feature && l.feature.properties && (l.feature.properties.parcelId || l.feature.properties.parcel_id));
                                    return pid2 && pid2.toString() === global.selectedParcelId;
                                });
                                if (layerFetched) {
                                    const isTrackSelected = (layerFetched?.feature?.properties?.isTrack === true) || Boolean(layerFetched?._trackStyle);
                                    if (isTrackSelected) {
                                        const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                                        const trackStyle = styleFn ? styleFn(global.selectedParcelId, layerFetched, { isTrack: true }) : (global.trackStyle || {});
                                        layerFetched.setStyle({ ...trackStyle, weight: 4 });
                                    } else if (typeof global.selectedParcelStyle !== 'undefined') {
                                        layerFetched.setStyle(global.selectedParcelStyle);
                                    }
                                    if (typeof layerFetched.bringToFront === 'function') layerFetched.bringToFront();
                                }
                            }
                            if (typeof global.updateVisibleParcelsCount === 'function') {
                                global.updateVisibleParcelsCount();
                            }
                        });
                    }
                }, debounceMs);
            }
        }

        if (typeof global.updateVisibleParcelsCount === 'function') {
            global.updateVisibleParcelsCount();
        }
    }

    global.ParcelFetchController = {
        handleMoveEnd: handleMoveEnd
    };
})(typeof window !== 'undefined' ? window : globalThis);
