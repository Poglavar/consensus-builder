(function (global) {
    'use strict';

    function isRoad(parcelId) {
        return (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;
    }

    function syncParcelLayerVisibility() {
        const visible = global.ParcelPresenter?.addGroupToMapIfAppropriate?.();
        global.PointParcelMap?.sync?.();
        global.ParcelsMintedLayer?.syncMapVisibility?.();
        if (!visible) {
            clearTimeout(global.parcelsTimeout);
            global.parcelsTimeout = null;
            global.cancelParcelViewportFetch?.();
            global.ParcelPreview?.clear?.();
            global.__drillUi?.clearParcelHover?.();
            global.clearParcelNumberLabels?.();
            global.clearOwnerCountLabels?.();
            global.clearProposalCountLabels?.();
        }
        updateVisibleParcelsCount();
        return visible;
    }

    function showAllParcels() {
        if (!syncParcelLayerVisibility()) return;
        global.refreshParcelNumberLabelsIfVisible?.();
        global.refreshOwnerCountLabelsIfVisible?.();
        global.refreshProposalCountLabelsIfVisible?.();
        fetchGroundReported('show all parcels', { viewport: true });
    }

    // Parcel fetches here are fire-and-forget; the reported wrapper (parcels/fetch.js) turns a
    // failure into a status message + console.error instead of an unhandled rejection.
    function fetchGroundReported(source, options) {
        if (typeof global.fetchParcelDataReported === 'function') {
            return global.fetchParcelDataReported(undefined, source, options);
        }
        const error = new Error('Parcel fetch is unavailable (parcels/fetch.js not loaded).');
        console.error(`[${new Date().toISOString()}] [ParcelVisibility] ${error.message}`);
        global.updateStatus?.(error.message);
        return Promise.resolve(null);
    }

    function showOnlyRoadParcels() {
        if (!global.parcelLayer) {
            // Wait for the fetch itself instead of re-polling every second; retry exactly once.
            fetchGroundReported('show road parcels').then(() => {
                if (global.parcelLayer) showOnlyRoadParcels();
                else global.updateStatus?.('No parcel layer loaded yet; road parcels cannot be shown.');
            });
            return;
        }
        // Remove parcelLayer from map first to avoid double rendering
        if (global.map.hasLayer(global.parcelLayer)) {
            global.map.removeLayer(global.parcelLayer);
        }

        let roadCount = 0;
        global.parcelLayer.eachLayer(layer => {
            const parcelId = global.ParcelPresenter?.getIdForLayer?.(layer) || null;
            const isRoad = (parcelId && typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;
            if (isRoad) {
                // Add road parcels directly to map (parcelLayer is not on map, so no double rendering)
                if (!global.map.hasLayer(layer)) {
                    global.map.addLayer(layer);
                }
                roadCount++;
            } else {
                // Remove non-road parcels from map if they were added directly
                if (global.map.hasLayer(layer)) {
                    global.map.removeLayer(layer);
                }
            }
        });
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(`Showing ${roadCount} road parcels only`);
        }
    }

    function hideAllParcels() {
        syncParcelLayerVisibility();
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('All parcels hidden');
        }
    }

    function updateVisibleParcelsCount() {
        const label = document.getElementById('parcels-in-view');
        if (!label) return;

        const i18nApi = (typeof global !== 'undefined') ? global.i18n : null;
        const setLabel = (key, params, fallback) => {
            label.setAttribute('data-i18n-key', key);
            if (params) {
                label.setAttribute('data-i18n-params', JSON.stringify(params));
            } else {
                label.removeAttribute('data-i18n-params');
            }
            if (i18nApi && typeof i18nApi.t === 'function') {
                label.textContent = i18nApi.t(key, params || {});
            } else {
                label.textContent = fallback;
            }
        };

        if (!global.parcelLayer || typeof global.parcelLayer.getLayers !== 'function' || typeof global.map === 'undefined' || !global.map) {
            setLabel('sidebar.parcels.inViewDefault', null, 'Parcels in map view / total: 0 / 0');
            return;
        }

        const layers = global.parcelLayer.getLayers();
        const totalParcels = layers.length;

        if (!totalParcels) {
            setLabel('sidebar.parcels.inViewDefault', null, 'Parcels in map view / total: 0 / 0');
            return;
        }

        const bounds = global.ParcelPresenter?.isVisible?.() === false ? null : global.map.getBounds();
        if (!bounds || typeof bounds.intersects !== 'function') {
            setLabel('sidebar.parcels.inViewTemplate', { visible: 0, total: totalParcels }, `Parcels in map view / total: 0 / ${totalParcels}`);
            return;
        }

        const visibleParcels = global.getParcelsInBounds(bounds);

        setLabel(
            'sidebar.parcels.inViewTemplate',
            { visible: visibleParcels.length, total: totalParcels },
            `Parcels in map view / total: ${visibleParcels.length} / ${totalParcels}`
        );
    }

    global.isRoad = isRoad;
    global.showAllParcels = showAllParcels;
    global.showOnlyRoadParcels = showOnlyRoadParcels;
    global.hideAllParcels = hideAllParcels;
    global.updateVisibleParcelsCount = updateVisibleParcelsCount;

    global.ParcelsUIVisibility = {
        isRoad,
        syncParcelLayerVisibility,
        showAllParcels,
        showOnlyRoadParcels,
        hideAllParcels,
        updateVisibleParcelsCount
    };
})(typeof window !== 'undefined' ? window : globalThis);
