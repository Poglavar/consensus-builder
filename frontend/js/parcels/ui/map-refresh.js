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

        const showParcelsElem = global.document.getElementById('showParcels');
        const showParcels = showParcelsElem ? showParcelsElem.checked : true;

        // Check if zoom is within parcel range before showing parcels
        const isZoomWithinRange = (typeof global.isZoomWithinParcelRange === 'function')
            ? global.isZoomWithinParcelRange()
            : true; // Default to true if function not available

        if (showParcels && isZoomWithinRange) {
            if (global.parcelLayer) {
                // Only add to map if not already there - calling addTo multiple times can cause issues
                if (!global.map.hasLayer(global.parcelLayer)) {
                    global.parcelLayer.addTo(global.map);
                }
                // Don't add layers directly - they're already rendered through parcelLayer FeatureGroup
                // Adding them directly would cause double rendering (darker appearance)
            }
        } else {
            const hideAll = uiVisibility.hideAllParcels || global.hideAllParcels;
            if (typeof hideAll === 'function') {
                hideAll();
            }
        }

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

        const fetchParcels = fetchApi.fetchParcelData || global.fetchParcelData;
        if (typeof fetchParcels === 'function') {
            fetchParcels();
        }
        if (typeof global.loadBuildings === 'function') {
            global.loadBuildings();
        }
    }

    global.refreshAllMapLayers = refreshAllMapLayers;
    global.setupMap = setupMap;
    global.ParcelsUIMap = { refreshAllMapLayers, setupMap };
})(typeof window !== 'undefined' ? window : globalThis);
