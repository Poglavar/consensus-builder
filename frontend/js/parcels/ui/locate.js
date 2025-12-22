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

        function locateParcel() {
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
                locateError.textContent = 'Parcel data not loaded';
                return;
            }

            // Find the layer with the matching parcel ID
            const foundLayer = global.parcelLayer.getLayers().find(layer => {
                const parcelId = resolveParcelId(layer.feature);
                return parcelId && parcelId === value;
            });

            if (foundLayer) {
                const selectParcel = selectionApi.selectParcel || global.selectParcel;
                const parcelId = resolveParcelId(foundLayer.feature);
                if (typeof selectParcel === 'function' && parcelId) {
                    selectParcel(parcelId);
                }
                locateError.textContent = '';
            } else {
                locateError.textContent = 'Parcel not found';
            }
        }

        locateButton.addEventListener('click', locateParcel);
        locateInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                locateParcel();
            }
        });
    });

    // Add road checkbox event listener
    const roadCheckbox = document.getElementById('roadCheckbox');
    if (roadCheckbox) {
        roadCheckbox.addEventListener('change', function (e) {
            if (global.currentParcel) {
                const wasRoad = global.currentParcel.isRoad;
                global.currentParcel.isRoad = e.target.checked;

                // Check if this parcel is part of multi-selection
                const isMultiSelected = typeof global.multiParcelSelection !== 'undefined' &&
                    global.multiParcelSelection.isActive &&
                    global.multiParcelSelection.selectedParcels.has(global.currentParcel.id.toString());

                // Only update appearance if not part of multi-selection
                if (!isMultiSelected) {
                    global.currentParcel.layer.setStyle(global.getParcelBaseStyle(global.currentParcel.id, { isRoad: e.target.checked }));
                }
                // If it's multi-selected, keep the multi-selection highlighting

                // Store the road status via centralized helper
                if (e.target.checked) {
                    if (typeof global.addRoadParcel === 'function') global.addRoadParcel(global.currentParcel.id);
                } else {
                    if (typeof global.removeRoadParcel === 'function') global.removeRoadParcel(global.currentParcel.id);
                    // Clean related metadata
                    PersistentStorage.removeItem(`parcel_${global.currentParcel.id}_roadName`);
                    PersistentStorage.removeItem(`parcel_${global.currentParcel.id}_roadId`);
                    PersistentStorage.removeItem(`parcel_${global.currentParcel.id}_roadConfidence`);
                }

                // Update TOTAL_SPENT based on the parcel's market price
                const area = global.currentParcel.layer.feature.properties.calculatedArea || 0;
                const parcelPrice = area * (typeof global.SQM_AVG_PRICE !== 'undefined' ? global.SQM_AVG_PRICE : 0);

                if (e.target.checked && !wasRoad) {
                    // Parcel was marked as road - add to total
                    if (typeof global.TOTAL_SPENT !== 'undefined') global.TOTAL_SPENT += parcelPrice;
                } else if (!e.target.checked && wasRoad) {
                    // Parcel was unmarked as road - subtract from total
                    if (typeof global.TOTAL_SPENT !== 'undefined') global.TOTAL_SPENT -= parcelPrice;
                }

                // Update the display
                if (typeof global.updateTotalSpentDisplay === 'function') {
                    global.updateTotalSpentDisplay();
                }

                try {
                    global.dispatchEvent(new CustomEvent('parcelRoadStatusChanged', {
                        detail: {
                            parcelId: global.currentParcel.id,
                            isRoad: e.target.checked
                        }
                    }));
                } catch (_) { }
            }
        });
    }

    global.clearLocalParcelData = clearLocalParcelData;
    global.handleParcelLayerChange = handleParcelLayerChange;
})(typeof window !== 'undefined' ? window : globalThis);

