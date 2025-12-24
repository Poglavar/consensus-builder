(function (global) {
    'use strict';

    function getParcelIdFromFeature(feature) {
        if (!feature) return null;
        const props = feature.properties || {};
        return (typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId))?.toString?.() || null;
    }

    function highlightFeature(e) {
        const layer = e.target;
        const parcelId = getParcelIdFromFeature(layer.feature);
        if (!parcelId) return;
        const proposalUIActive = (typeof global.isProposalUIActive === 'function')
            ? global.isProposalUIActive()
            : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);
        const activeProposalParcelIds = Array.isArray(global.currentlyHighlightedProposal?.parentParcelIds)
            ? global.currentlyHighlightedProposal.parentParcelIds.map(id => id.toString())
            : (Array.isArray(global.currentlyHighlightedProposal?.childParcelIds)
                ? global.currentlyHighlightedProposal.childParcelIds.map(id => id.toString())
                : []);
        const restrictHoverToActiveProposal = proposalUIActive && activeProposalParcelIds.length > 0;
        const parcelInActiveProposal = restrictHoverToActiveProposal && activeProposalParcelIds.includes(parcelId);

        // Only use proposal hover overlay when Proposal UI is active
        try {
            if (proposalUIActive && typeof global.proposalStorage !== 'undefined') {
                const proposals = global.proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
                if (proposals && proposals.length > 0) {
                    // When a proposal is already open, only highlight its parcels on hover
                    const allowProposalHover = !restrictHoverToActiveProposal || parcelInActiveProposal;
                    if (allowProposalHover && typeof global.showProposalInfoHoverOverlay === 'function') {
                        global.showProposalInfoHoverOverlay(parcelId);
                        return; // Do not apply default hover styling
                    }
                }
            }
        } catch (_) { }

        // Skip highlight if parcel is part of currently highlighted proposal, but only when proposal UI is active
        if (proposalUIActive && parcelInActiveProposal) {
            return;
        }
        // Do not highlight over the currently selected parcel
        if (parcelId === global.selectedParcelId) {
            return;
        }
        // Do not highlight over multi-selected parcels
        const isMultiSelected = typeof global.multiParcelSelection !== 'undefined' &&
            global.multiParcelSelection.isActive &&
            global.multiParcelSelection.selectedParcels.has(parcelId);
        if (isMultiSelected) {
            return;
        }
        // Do not apply hover styling if parcel is locked for road drawing (green highlighting)
        const isLockedForRoad = typeof global.isParcelLockedForRoadDrawing === 'function' &&
            global.isParcelLockedForRoadDrawing(parcelId);
        if (isLockedForRoad) {
            return;
        }
        // Do not apply hover styling if parcel is committed for track drawing (green highlighting)
        const isCommittedForTrack = typeof global.isParcelCommittedForTrackDrawing === 'function' &&
            global.isParcelCommittedForTrackDrawing(parcelId);
        if (isCommittedForTrack) {
            return;
        }
        // Proposal-aware: only change border, not fill
        layer.setStyle({
            weight: 5,
            color: '#666',
            dashArray: '',
            // Do not change fillColor/fillOpacity
        });
        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
            layer.bringToFront();
        }
    }

    function resetHighlight(e) {
        const layer = e.target;
        const parcelId = getParcelIdFromFeature(layer.feature);
        if (!parcelId) return;
        const proposalUIActive = (typeof global.isProposalUIActive === 'function')
            ? global.isProposalUIActive()
            : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);

        // Clear the proposal hover overlay only when Proposal UI is active
        try {
            if (proposalUIActive && typeof global.clearProposalInfoHoverOverlay === 'function') {
                global.clearProposalInfoHoverOverlay();
            }
        } catch (_) { }

        // Do not reset the style of the currently selected parcel (normal)
        if (parcelId === global.selectedParcelId) {
            return;
        }
        // Keep selected block parcels highlighted in blue ONLY when Parcel Blocks are shown
        try {
            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
            const currentSelectedBlockName = (typeof global.selectedBlockName !== 'undefined' && global.selectedBlockName)
                ? global.selectedBlockName
                : (typeof global !== 'undefined' ? global.selectedBlockName : null);
            const layerBlockName = layer?.feature?.properties?.block;
            if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                const parcelHighlightStyle = {
                    fillColor: '#3388ff',
                    fillOpacity: 0.4,
                    color: '#3388ff',
                    weight: 2
                };
                layer.setStyle(parcelHighlightStyle);
                return;
            }
        } catch (_) { }

        // Track parcels: restore stored track style or default track style
        const isTrackParcel = layer?.feature?.properties?.isTrack === true;
        const storedTrackStyle = (layer && (layer._trackStyle || (layer.feature && layer.feature._trackStyle))) || null;
        const defaultTrackStyle = {
            color: '#000000',
            weight: 2,
            opacity: 0.9,
            dashArray: '',
            fillColor: '#d3d3d3',
            fillOpacity: 0.35
        };
        if (isTrackParcel || storedTrackStyle) {
            layer.setStyle(storedTrackStyle || defaultTrackStyle);
            return;
        }

        // Check if this parcel is locked for road drawing (green highlighting)
        const isLockedForRoad = typeof global.isParcelLockedForRoadDrawing === 'function' &&
            global.isParcelLockedForRoadDrawing(parcelId);

        if (isLockedForRoad) {
            // Keep green highlighting for committed road parcels
            layer.setStyle({
                fillColor: 'green',
                fillOpacity: 0.6,
                color: 'green',
                weight: 3
            });
            return;
        }

        // Check if this parcel is committed for track drawing (green highlighting)
        const isCommittedForTrack = typeof global.isParcelCommittedForTrackDrawing === 'function' &&
            global.isParcelCommittedForTrackDrawing(parcelId);

        if (isCommittedForTrack) {
            // Keep green highlighting for committed track parcels
            layer.setStyle({
                fillColor: 'green',
                fillOpacity: 0.6,
                color: 'green',
                weight: 3
            });
            return;
        }

        // Check if this parcel is in track preview (orange highlighting during track drawing)
        // Use Set for O(1) lookup instead of array iteration for better performance
        const isInTrackPreview = typeof global.trackPreviewAffectedParcelIds !== 'undefined' &&
            global.trackPreviewAffectedParcelIds instanceof Set &&
            global.trackPreviewAffectedParcelIds.has(parcelId);

        if (isInTrackPreview) {
            // Keep orange highlighting for track preview
            layer.setStyle({
                fillColor: '#ff6600', // Orange
                fillOpacity: 0.4,
                color: '#ff6600',
                weight: 2
            });
            return;
        }

        // Otherwise, reset to its original style (road or normal)
        // But check if this parcel is part of multi-selection first
        const isMultiSelected2 = typeof global.multiParcelSelection !== 'undefined' &&
            global.multiParcelSelection.isActive &&
            global.multiParcelSelection.selectedParcels.has(parcelId);

        if (isMultiSelected2) {
            // Restore multi-selection highlighting
            layer.setStyle({
                fillColor: '#ff9800',
                fillOpacity: 0.6,
                color: '#f57c00',
                weight: 3
            });
        } else {
            // Restore normal or road style using the original style definitions
            // but preserve block highlight if this parcel is part of the selected block
            try {
                const currentSelectedBlockName = (typeof global.selectedBlockName !== 'undefined' && global.selectedBlockName)
                    ? global.selectedBlockName
                    : (typeof global !== 'undefined' ? global.selectedBlockName : null);
                const layerBlockName = layer?.feature?.properties?.block;
                const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
                if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                    layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                } else {
                    // Use getParcelStyle to preserve ownership highlighting
                    const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                    layer.setStyle(styleFn(parcelId, layer));
                }
            } catch (_) {
                // Use getParcelStyle to preserve ownership highlighting
                const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                layer.setStyle(styleFn(parcelId, layer));
            }
        }
    }

    // This function will be called on each created feature
    function onEachFeature(feature, layer) {
        // Check if drawing mode is active - if so, don't attach click handlers
        const isDrawingMode = (typeof global.roadDrawingMode !== 'undefined' && global.roadDrawingMode) ||
            (typeof global.trackDrawingMode !== 'undefined' && global.trackDrawingMode);

        const events = {
            mouseover: highlightFeature,
            mouseout: resetHighlight
        };

        // Only attach click handler if not in drawing mode
        if (!isDrawingMode && global.onParcelClick) {
            events.click = global.onParcelClick;
        }

        layer.on(events);
        // Ensure layer is interactive - critical for clickability
        if (layer.options) {
            layer.options.interactive = true;
        }
        if (typeof layer.setInteractive === 'function') {
            layer.setInteractive(true);
        }
    }

    function selectParcel(parcelOrId, showPanel = true) {
        if (!global.parcelLayer) return;
        const parcelId = parcelOrId && parcelOrId.feature
            ? getParcelIdFromFeature(parcelOrId.feature)
            : parcelOrId;
        if (!parcelId) return;

        const selectedLayer = parcelOrId && parcelOrId.feature
            ? parcelOrId
            : global.parcelLayer.getLayers().find(layer => {
                if (!layer.feature || !layer.feature.properties) return false;
                const layerParcelId = getParcelIdFromFeature(layer.feature);
                return layerParcelId && layerParcelId.toString() === parcelId.toString();
            });

        if (selectedLayer) {
            global.selectedParcelId = parcelId.toString();
            if (!(typeof global !== 'undefined' && global.suppressCameraMoves)) {
                map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
            }
            // Only reset styles for parcels in the viewport to avoid iterating all parcels
            const mapBounds = (typeof global.map !== 'undefined' && global.map && typeof global.map.getBounds === 'function')
                ? global.map.getBounds()
                : null;
            const layersToProcess = (mapBounds && typeof global.getParcelLayersWithinBounds === 'function')
                ? global.getParcelLayersWithinBounds(mapBounds)
                : null;

            if (Array.isArray(layersToProcess) && layersToProcess.length > 0) {
                // Use viewport-filtered layers
                layersToProcess.forEach(layer => {
                    if (layer && layer.feature && layer.feature.properties) {
                        const layerParcelId = getParcelIdFromFeature(layer.feature);
                        const isRoad = (layerParcelId && typeof global.isRoadParcel === 'function') ? global.isRoadParcel(layerParcelId) : false;
                        const isTrack = (layer.feature.properties.isTrack === true) || Boolean(layer._trackStyle);
                        if (layerParcelId !== parcelId.toString()) {
                            // Check if this parcel is part of multi-selection before resetting style
                            const isMultiSelected = typeof global.multiParcelSelection !== 'undefined' &&
                                global.multiParcelSelection.isActive &&
                                global.multiParcelSelection.selectedParcels.has(layerParcelId);
                            if (!isMultiSelected) {
                                // Use getParcelStyle to preserve ownership highlighting
                                const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                                layer.setStyle(styleFn(layerParcelId, layer, { isRoad, isTrack }));
                            }
                        }
                    }
                });
            } else {
                // Fallback: only process if we have a small number of parcels (safety check)
                const totalLayers = (global.parcelLayer && typeof global.parcelLayer.getLayers === 'function')
                    ? global.parcelLayer.getLayers().length
                    : 0;
                if (totalLayers < 1000) {
                    // Only fallback to full scan if parcel count is reasonable
                    global.parcelLayer.eachLayer(layer => {
                        if (layer.feature && layer.feature.properties) {
                            const layerParcelId = getParcelIdFromFeature(layer.feature);
                            const isRoad = (layerParcelId && typeof global.isRoadParcel === 'function') ? global.isRoadParcel(layerParcelId) : false;
                            const isTrack = (layer.feature.properties.isTrack === true) || Boolean(layer._trackStyle);
                            if (layerParcelId !== parcelId.toString()) {
                                // Check if this parcel is part of multi-selection before resetting style
                                const isMultiSelected = typeof global.multiParcelSelection !== 'undefined' &&
                                    global.multiParcelSelection.isActive &&
                                    global.multiParcelSelection.selectedParcels.has(layerParcelId);
                                if (!isMultiSelected) {
                                    // Use getParcelStyle to preserve ownership highlighting
                                    const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                                    layer.setStyle(styleFn(layerParcelId, layer, { isRoad, isTrack }));
                                }
                            }
                        }
                    });
                }
            }
            const isTrackSelected = (selectedLayer?.feature?.properties?.isTrack === true) || Boolean(selectedLayer?._trackStyle);
            if (isTrackSelected) {
                const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                // Keep track fill; optionally bump stroke weight for selection
                const trackStyle = styleFn ? styleFn(parcelId, selectedLayer, { isTrack: true }) : (global.trackStyle || {});
                selectedLayer.setStyle({ ...trackStyle, weight: 4 });
            } else {
                selectedLayer.setStyle(global.selectedParcelStyle);
            }
            selectedLayer.bringToFront();
            global.currentParcel = {
                id: parcelId,
                layer: selectedLayer,
                isRoad: (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false
            };

            // Only show the panel if requested (desktop behavior)
            const showParcelInfoPanel = (global.Parcels && global.Parcels.uiParcelPanel && global.Parcels.uiParcelPanel.showParcelInfoPanel)
                ? global.Parcels.uiParcelPanel.showParcelInfoPanel
                : global.showParcelInfoPanel;
            if (showPanel && typeof showParcelInfoPanel === 'function') {
                showParcelInfoPanel(selectedLayer.feature);
                const roadCheckbox = document.getElementById('roadCheckbox');
                if (roadCheckbox) {
                    roadCheckbox.checked = global.currentParcel.isRoad;
                }
                const parcelInfoPanel = document.getElementById('parcel-info-panel');
                if (parcelInfoPanel) {
                    parcelInfoPanel.classList.add('visible');
                }
            }
            if (typeof global.neighborHighlightActive !== 'undefined' && global.neighborHighlightActive) {
                if (typeof global.highlightNeighbors === 'function') {
                    global.highlightNeighbors(selectedLayer);
                }
            }
            if (typeof global.verticesDisplayActive !== 'undefined' && global.verticesDisplayActive) {
                global.verticesDisplayActive = false;
                const verticesBtn = document.getElementById('verticesButton');
                if (verticesBtn) verticesBtn.classList.remove('active');
                if (typeof global.clearVertexMarkers === 'function') {
                    global.clearVertexMarkers();
                }
            }
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Selected parcel ${selectedLayer.feature.properties.BROJ_CESTICE}`);
            }
        }
    }

    global.highlightFeature = highlightFeature;
    global.resetHighlight = resetHighlight;
    global.onEachFeature = onEachFeature;
    global.selectParcel = selectParcel;
})(typeof window !== 'undefined' ? window : globalThis);

