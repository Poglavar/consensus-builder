(function (global) {
    'use strict';

    const uiParcelPanel = (global.Parcels && global.Parcels.uiParcelPanel) ? global.Parcels.uiParcelPanel : (global.ParcelsUIParcelPanel || {});

    function onParcelClick(e) {
        if (global.measureMode) return;
        // Ignore parcel clicks when road drawing mode is active
        if (typeof global.roadDrawingMode !== 'undefined' && global.roadDrawingMode) {
            return;
        }
        const targetLayer = e && e.target ? e.target : null;
        if (!targetLayer || !targetLayer.feature) return;
        const feature = targetLayer.feature;
        const isRoad = global.PersistentStorage.getItem(`parcel_${feature.properties.CESTICA_ID}_isRoad`) === 'true';

        const proposalDetailsPanel = global.document.getElementById('proposal-details-panel');
        if (proposalDetailsPanel && proposalDetailsPanel.classList.contains('visible')) {
            if (typeof global.hideProposalDetailsPanel === 'function') {
                global.hideProposalDetailsPanel(true);
            } else {
                proposalDetailsPanel.classList.remove('visible');
                if (typeof global.clearProposalHighlights === 'function') {
                    global.clearProposalHighlights();
                }
            }
            global.currentlyHighlightedProposal = null;
            global.selectedParcelInProposal = null;
            if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive) {
                global.multiParcelSelection.toggle({ restoreSingleSelection: false });
            }
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive) {
            const wasToggled = global.multiParcelSelection.toggleParcel(targetLayer);
            if (wasToggled) {
                L.DomEvent.stopPropagation(e);
                return;
            }
        }

        if (typeof global.multiParcelSelection !== 'undefined' && !global.multiParcelSelection.isActive) {
            global.multiParcelSelection.clearSelection();
        }

        if (global.splitLayer && global.map.hasLayer(global.splitLayer)) {
            global.map.removeLayer(global.splitLayer);
            global.splitLayer = null;
        }

        if (!isRoad && feature.properties.geometries) {
            const splitFeatures = feature.properties.geometries;
            if (splitFeatures && splitFeatures.length > 0) {
                const style = {
                    color: '#ff0000',
                    weight: 3,
                    opacity: 0.8,
                    fillColor: '#ff0000',
                    fillOpacity: 0.3
                };
                global.splitLayer = L.layerGroup().addTo(global.map);
                splitFeatures.forEach(geom => {
                    const layer = L.geoJSON(geom, { style });
                    global.splitLayer.addLayer(layer);
                });
                const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
                if (typeof showParcelInfoPanel === 'function') {
                    showParcelInfoPanel(splitFeatures[0]);
                }
                return;
            }
        }
        const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
        if (typeof showParcelInfoPanel === 'function') {
            showParcelInfoPanel(feature);
        }
        global.currentParcelCoordinates = feature.geometry.coordinates;
        const parcelId = feature.properties.CESTICA_ID;
        const currentIsRoad = global.PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
        global.document.getElementById('roadCheckbox').checked = currentIsRoad;

        const previousSelectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        const previousLayer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        if (previousLayer && previousSelectedId && previousSelectedId !== parcelId.toString()) {
            const keepHighlighted = typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive &&
                global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.has(previousSelectedId);
            if (!keepHighlighted) {
                const wasRoad = global.PersistentStorage.getItem(`parcel_${previousSelectedId}_isRoad`) === 'true';
                try {
                    previousLayer.setStyle(global.getParcelBaseStyle(previousSelectedId, { isRoad: wasRoad }));
                } catch (_) { }
            }
        }

        global.selectedParcelId = parcelId.toString();
        targetLayer.setStyle(global.selectedParcelStyle);
        targetLayer.bringToFront();

        global.window.selectedParcelId = global.selectedParcelId;

        const blockName = feature.properties.block;
        const blocksActive = global.document.getElementById('parcelBlocksCheckbox') && global.document.getElementById('parcelBlocksCheckbox').checked;
        if (blocksActive) {
            const currentSelectedBlockName = (typeof global.selectedBlockName !== 'undefined' && global.selectedBlockName)
                ? global.selectedBlockName
                : (typeof global !== 'undefined' ? global.selectedBlockName : null);
            if (blockName) {
                global.highlightAndCenterBlock(blockName);
            } else if (currentSelectedBlockName) {
                try { if (typeof global.clearSelectedBlockAndUI === 'function') global.clearSelectedBlockAndUI(); } catch (_) { }
            }
        }

        global.currentParcel = {
            id: parcelId,
            layer: targetLayer,
            isRoad: currentIsRoad
        };
        global.window.currentParcel = global.currentParcel;

        const createProposalButton = global.document.getElementById('createProposalFromParcelButton');
        if (createProposalButton) {
            createProposalButton.style.display = 'inline-block';
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.updateCreateProposalButton) {
            global.multiParcelSelection.updateCreateProposalButton();
        }

        global.document.getElementById('parcel-info-panel').classList.add('visible');
        L.DomEvent.stopPropagation(e);

        try { if (typeof global.updateBlockButtonStates === 'function') global.updateBlockButtonStates(); } catch (_) { }
    }

    global.onParcelClick = onParcelClick;
    global.ParcelsUISelection = Object.assign({}, global.ParcelsUISelection, { onParcelClick });
})(typeof window !== 'undefined' ? window : globalThis);

