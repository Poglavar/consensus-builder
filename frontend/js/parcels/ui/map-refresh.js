(function (global) {
    'use strict';

    const Parcels = global.Parcels || {};
    const fetchApi = Parcels.fetch || {};
    const uiVisibility = Parcels.uiVisibility || {};
    const uiLabels = Parcels.uiLabels || {};
    const uiSelection = Parcels.uiSelection || global.ParcelsUISelection || {};

    function refreshAllMapLayers() {
        if (typeof global.blockStorage !== 'undefined' && global.blockStorage.load) {
            // Block detection is an ephemeral id projection over the current Fabric revision.
            // Refresh only rebinds those ids to Presenter layers; it never writes domain metadata
            // into rendered GeoJSON clones or discovers membership by scanning Leaflet.
            global.blockStorage.load();
        }

        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
        }

        global.ParcelPresenter?.addGroupToMapIfAppropriate?.();
        const updateVisibleCount = uiVisibility.updateVisibleParcelsCount || global.updateVisibleParcelsCount;
        if (typeof updateVisibleCount === 'function') {
            updateVisibleCount();
        }
        if (global.document.getElementById('parcelBlocksCheckbox') && global.document.getElementById('parcelBlocksCheckbox').checked && typeof global.updateBlockLayer === 'function') {
            global.updateBlockLayer();
        }
        try { global.dispatchEvent(new CustomEvent('parcelBlocksShouldRedraw')); } catch (_) { }

        try {
            if (typeof global.rehighlightSelectedBlockParcels === 'function') {
                global.rehighlightSelectedBlockParcels();
            }
        } catch (_) { }

        const refreshLabels = uiLabels.refreshParcelNumberLabelsIfVisible || global.refreshParcelNumberLabelsIfVisible;
        if (typeof refreshLabels === 'function') {
            refreshLabels();
        }
    }

    function setupMap() {
        if (uiSelection && typeof uiSelection.onParcelClick === 'function' && !global.onParcelClick) {
            global.onParcelClick = uiSelection.onParcelClick;
        }
        if (typeof global.originalOnParcelClick === 'undefined' || global.originalOnParcelClick === null) {
            global.originalOnParcelClick = global.onParcelClick;
        }

        // The reported variant surfaces a failed fetch (status + console) instead of leaving an
        // unhandled rejection behind this fire-and-forget call.
        const fetchParcels = fetchApi.fetchParcelDataReported || global.fetchParcelDataReported;
        if (typeof fetchParcels === 'function') {
            fetchParcels(undefined, 'map-refresh.setupMap', { viewport: true });
        }
        if (typeof global.loadBuildings === 'function') {
            global.loadBuildings();
        }
    }

    global.refreshAllMapLayers = refreshAllMapLayers;
    global.setupMap = setupMap;
    global.ParcelsUIMap = { refreshAllMapLayers, setupMap };
})(typeof window !== 'undefined' ? window : globalThis);
