(function (global) {
    'use strict';

    const uiParcelPanel = (global.Parcels && global.Parcels.uiParcelPanel) ? global.Parcels.uiParcelPanel : (global.ParcelsUIParcelPanel || {});

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    function onParcelClick(e) {
        if (global.measureMode) return;
        if (typeof global.isParcelDrawingModeActive === 'function' && global.isParcelDrawingModeActive()) {
            return;
        }
        if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) return;
        const targetLayer = e && e.target ? e.target : null;
        if (!targetLayer || !targetLayer.feature) return;
        const feature = targetLayer.feature;
        const parcelId = resolveParcelId(feature);
        if (!parcelId) return;
        const isRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;

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

        // Shift+click enters multi-select on the fly — same as ticking the "Select multiple
        // parcels" checkbox (updateUI syncs it). The currently viewed parcel is preserved as the
        // seed, and the shift-clicked parcel joins the selection below.
        const shiftHeld = !!(e && e.originalEvent && e.originalEvent.shiftKey);
        if (shiftHeld && typeof global.multiParcelSelection !== 'undefined'
            && !global.multiParcelSelection.isActive
            && typeof global.multiParcelSelection.toggle === 'function') {
            global.multiParcelSelection.toggle({ preserveSelectedParcel: true });
            if (global.multiParcelSelection.selectedParcels
                && global.multiParcelSelection.selectedParcels.has(parcelId)) {
                // Shift+click on the already-selected parcel: it is the seed — keep it selected
                // instead of letting toggleParcel immediately deselect it.
                L.DomEvent.stopPropagation(e);
                return;
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
        const currentIsRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;
        global.document.getElementById('roadCheckbox').checked = currentIsRoad;

        const previousSelectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        const previousLayer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        if (previousLayer && previousSelectedId && previousSelectedId !== parcelId.toString()) {
            const keepHighlighted = typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive &&
                global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.has(previousSelectedId);
            if (!keepHighlighted) {
                try {
                    const restoreLayerStyle = typeof global.restoreParcelLayerStyle === 'function'
                        ? global.restoreParcelLayerStyle
                        : null;
                    if (restoreLayerStyle) {
                        restoreLayerStyle(previousLayer);
                    } else {
                        // Fallback: preserve ownership highlighting when available
                        const wasRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(previousSelectedId) : false;
                        const styleFn = typeof global.getParcelStyle === 'function'
                            ? global.getParcelStyle
                            : global.getParcelBaseStyle;
                        if (styleFn) {
                            previousLayer.setStyle(styleFn(previousSelectedId, previousLayer, { isRoad: wasRoad }));
                        } else {
                            previousLayer.setStyle(wasRoad ? global.roadStyle : global.normalStyle);
                        }
                    }
                } catch (_) { }
            }
        }

        global.selectedParcelId = parcelId.toString();
        const isTrackSelected = (targetLayer?.feature?.properties?.isTrack === true) || Boolean(targetLayer?._trackStyle);
        if (isTrackSelected) {
            const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
            const trackStyle = styleFn ? styleFn(parcelId, targetLayer, { isTrack: true }) : (global.trackStyle || {});
            targetLayer.setStyle({ ...trackStyle, weight: 4 });
        } else {
            targetLayer.setStyle(global.selectedParcelStyle);
        }
        targetLayer.bringToFront();

        global.window.selectedParcelId = global.selectedParcelId;

        // Clear orange track highlighting from all parcels except the clicked one
        // Only do this if track drawing mode is NOT active (during track drawing, highlighting should persist)
        if (typeof global.trackDrawingMode === 'undefined' || !global.trackDrawingMode) {
            if (typeof global.trackPreviewAffectedParcelIds !== 'undefined' &&
                global.trackPreviewAffectedParcelIds instanceof Set &&
                global.trackPreviewAffectedParcelIds.size > 0 &&
                global.parcelLayer) {
                const clickedParcelIdStr = parcelId.toString();
                global.parcelLayer.eachLayer(layer => {
                    if (!layer.feature || !layer.feature.properties) return;
                    const layerParcelId = resolveParcelId(layer.feature);
                    if (!layerParcelId) return;
                    // If this parcel is in track preview but is not the clicked parcel, clear its orange highlighting
                    if (global.trackPreviewAffectedParcelIds.has(layerParcelId) && layerParcelId !== clickedParcelIdStr) {
                        const isMarkedAsRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(layerParcelId) : false;
                        // Use getParcelBaseStyle or getParcelStyle to preserve ownership highlighting
                        const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                        if (typeof styleFn === 'function') {
                            layer.setStyle(styleFn(layerParcelId, layer, { isRoad: isMarkedAsRoad }));
                        } else {
                            // Fallback to basic style
                            const baseStyle = isMarkedAsRoad ? global.roadStyle : global.normalStyle;
                            if (baseStyle) {
                                layer.setStyle(baseStyle);
                            }
                        }
                    }
                });
                // Update the Set to only contain the clicked parcel (if it was in the set)
                if (global.trackPreviewAffectedParcelIds.has(clickedParcelIdStr)) {
                    global.trackPreviewAffectedParcelIds = new Set([clickedParcelIdStr]);
                } else {
                    global.trackPreviewAffectedParcelIds.clear();
                }
                // Also update window.trackPreviewAffectedParcelIds if it exists
                if (typeof global.window !== 'undefined') {
                    global.window.trackPreviewAffectedParcelIds = global.trackPreviewAffectedParcelIds;
                }
            }
        }

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

    // Escape exits multi-select mode (same as unchecking the checkbox: the last parcel is
    // restored as a single selection). Heavily guarded because many tools bind Escape for their
    // own cancel action — never hijack it while typing, inside a modal, or while the road/measure
    // tools (which drive multi-select programmatically) are active.
    function handleMultiSelectEscape(event) {
        if (!event || event.key !== 'Escape' || event.defaultPrevented) return;
        if (typeof global.multiParcelSelection === 'undefined' || !global.multiParcelSelection.isActive) return;
        if (typeof global.isEditableTarget === 'function' && global.isEditableTarget(event.target)) return;
        if (typeof global.isAnyModalOpen === 'function' && global.isAnyModalOpen()) return;
        if (global.roadDrawingMode || global.measureMode) return;
        if (typeof global.multiParcelSelection.toggle !== 'function') return;
        global.multiParcelSelection.toggle();
    }
    global.document.addEventListener('keydown', handleMultiSelectEscape);

    global.onParcelClick = onParcelClick;
    global.ParcelsUISelection = Object.assign({}, global.ParcelsUISelection, { onParcelClick });
})(typeof window !== 'undefined' ? window : globalThis);
