(function (global) {
    'use strict';

    const Parcels = global.Parcels || {};
    const uiVisibility = Parcels.uiVisibility || {};
    const uiLabels = Parcels.uiLabels || {};
    const fetchApi = Parcels.fetch || {};
    const selectionApi = Parcels.selection || {};
    const uiParcelPanel = Parcels.uiParcelPanel || global.ParcelsUIParcelPanel || {};

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    // Translate a sidebar.parcels.* key, falling back to English if i18n is
    // unavailable or the key is missing (translate() returns the key on a miss).
    const t = (key, fallback) => {
        const fn = global.i18n && typeof global.i18n.t === 'function' ? global.i18n.t : null;
        if (!fn) return fallback;
        const fullKey = `sidebar.parcels.${key}`;
        const result = fn(fullKey);
        return result && result !== fullKey ? result : fallback;
    };

    async function clearLocalParcelData() {
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('Clearing local parcel data...');
        }
        let count = 0;
        const keysToDelete = [];
        for (let i = 0; i < PersistentStorage.length; i++) {
            const key = PersistentStorage.key(i);
            if (key === 'cadastre_blocks') {
                continue;
            }
            if (key.startsWith('parcel_') ||
                key.startsWith('road_') ||
                key.includes('_geometry') ||
                key.includes('_properties') ||
                key.includes('_isRoad') ||
                key.includes('_roadName') ||
                key.includes('_split_')) {
                keysToDelete.push(key);
                count++;
            }
        }
        keysToDelete.forEach(key => {
            PersistentStorage.removeItem(key);
        });

        PersistentStorage.removeItem('modified_parcels');

        // Final message shown after clearing
        const clearedMessage = `Cleared ${count} parcel-related items from local storage`;

        if (global.parcelLayer) {
            global.parcelLayer.clearLayers();
        }
        if (typeof global.clearParcelLayerIndex === 'function') {
            global.clearParcelLayerIndex();
        }
        if (global.parcelCache && global.parcelCache.grid) {
            global.parcelCache.grid.clear();
        }
        if (typeof global.ParcelsState?.bumpParcelCoverageVersion === 'function') {
            global.ParcelsState.bumpParcelCoverageVersion();
        }
        try {
            if (typeof global.dispatchEvent === 'function') {
                global.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                    detail: {
                        version: global.parcelCoverageVersion,
                        source: 'clear',
                        timestamp: Date.now()
                    }
                }));
            }
        } catch (_) { }
        const clearLabels = uiLabels.clearParcelNumberLabels || global.clearParcelNumberLabels;
        if (typeof clearLabels === 'function') {
            clearLabels();
        }
        global.currentParcel = null;
        global.selectedParcelId = null;
        const hideParcelInfoPanel = uiParcelPanel.hideParcelInfoPanel || global.hideParcelInfoPanel;
        if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
        if (typeof global.hideBlockInfo === 'function') global.hideBlockInfo();
        if (typeof global.hideRoadInfoPanel === 'function') global.hideRoadInfoPanel();

        // Set the final status message after fetchParcelData has run its course
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(clearedMessage);
        }
    }

    function handleParcelLayerChange(checkbox) {
        const showParcelsCheckbox = document.getElementById('showParcels');
        const showRoadParcelsCheckbox = document.getElementById('showRoadParcels');
        if (checkbox.id === 'showParcels' && checkbox.checked) {
            showRoadParcelsCheckbox.checked = false;
        } else if (checkbox.id === 'showRoadParcels' && checkbox.checked) {
            showParcelsCheckbox.checked = false;
        }
        const showAll = uiVisibility.showAllParcels || global.showAllParcels;
        const showOnlyRoads = uiVisibility.showOnlyRoadParcels || global.showOnlyRoadParcels;
        const hideAll = uiVisibility.hideAllParcels || global.hideAllParcels;

        if (showParcelsCheckbox.checked) {
            if (typeof showAll === 'function') showAll();
        } else if (showRoadParcelsCheckbox.checked) {
            if (typeof showOnlyRoads === 'function') showOnlyRoads();
        } else if (typeof hideAll === 'function') {
            hideAll();
        }
    }

    // Parcel locating functionality
    // Assumes parcelLayer and selectParcel are globally available
    document.addEventListener('DOMContentLoaded', function () {
        const locateInput = document.getElementById('locateParcelInput');
        const locateButton = document.getElementById('locateParcelButton');
        const locateError = document.getElementById('locateParcelError');

        if (!locateInput || !locateButton || !locateError) {
            // UI elements not present
            return;
        }

        async function locateParcel() {
            const value = locateInput.value.trim();
            locateError.textContent = '';
            if (!value) return;

            // Ensure the 'Show parcel ids' checkbox is checked
            const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');
            if (showParcelNumbersCheckbox && !showParcelNumbersCheckbox.checked) {
                showParcelNumbersCheckbox.checked = true;
                const toggleParcelNumbers = uiLabels.toggleParcelNumbers || global.toggleParcelNumbers;
                if (typeof toggleParcelNumbers === 'function') {
                    toggleParcelNumbers();
                }
            }

            if (typeof global.parcelLayer === 'undefined' || !global.parcelLayer) {
                locateError.textContent = t('locateDataNotLoaded', 'Parcel data not loaded');
                return;
            }

            const selectParcel = selectionApi.selectParcel || global.selectParcel;

            // 1) Already loaded in the layer — select and centre on it directly.
            const foundLayer = global.parcelLayer.getLayers().find(layer => {
                const parcelId = resolveParcelId(layer.feature);
                return parcelId && parcelId === value;
            });
            if (foundLayer) {
                const parcelId = resolveParcelId(foundLayer.feature);
                if (typeof selectParcel === 'function' && parcelId) {
                    selectParcel(parcelId);
                }
                return;
            }

            // 2) Not in memory — fetch it from the backend by id, ingest it, then
            //    select it. selectParcel centres the map (fitBounds), and that move
            //    fires the map's moveend handler which loads the surrounding cell.
            const fetchSingle = fetchApi.fetchSingleParcelById || global.fetchSingleParcelById;
            if (typeof fetchSingle !== 'function') {
                locateError.textContent = t('locateNotFound', 'Parcel not found');
                return;
            }

            locateError.textContent = t('locateSearching', 'Searching…');
            locateButton.disabled = true;
            try {
                const layer = await fetchSingle(value);
                const foundId = layer && layer.feature ? (resolveParcelId(layer.feature) || value) : null;
                if (foundId && typeof selectParcel === 'function') {
                    selectParcel(foundId);
                    locateError.textContent = '';
                } else {
                    locateError.textContent = t('locateNotFound', 'Parcel not found');
                }
            } catch (error) {
                console.info('[locate] backend lookup failed for', value, error && error.message);
                locateError.textContent = t('locateNotFound', 'Parcel not found');
            } finally {
                locateButton.disabled = false;
            }
        }

        locateButton.addEventListener('click', locateParcel);
        locateInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                locateParcel();
            }
        });
    });

    global.clearLocalParcelData = clearLocalParcelData;
    global.handleParcelLayerChange = handleParcelLayerChange;
})(typeof window !== 'undefined' ? window : globalThis);

