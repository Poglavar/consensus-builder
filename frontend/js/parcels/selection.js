(function (global) {
    'use strict';

    function highlightFeature(e) {
        const layer = e.target;
        const parcelId = layer.feature.properties.CESTICA_ID.toString();
        const proposalUIActive = (typeof global.isProposalUIActive === 'function')
            ? global.isProposalUIActive()
            : (document.getElementById('showProposalsCheckbox') && document.getElementById('showProposalsCheckbox').checked);
        const activeProposalParcelIds = Array.isArray(global.currentlyHighlightedProposal?.parcelIds)
            ? global.currentlyHighlightedProposal.parcelIds.map(id => id.toString())
            : [];
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
        const parcelId = layer.feature.properties.CESTICA_ID.toString();
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
        layer.on({
            mouseover: highlightFeature,
            mouseout: resetHighlight,
            click: global.onParcelClick
        });
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
            ? parcelOrId.feature.properties?.CESTICA_ID
            : parcelOrId;
        if (!parcelId) return;

        const selectedLayer = parcelOrId && parcelOrId.feature
            ? parcelOrId
            : global.parcelLayer.getLayers().find(layer => {
                return layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
            });

        if (selectedLayer) {
            global.selectedParcelId = parcelId.toString();
            if (!(typeof global !== 'undefined' && global.suppressCameraMoves)) {
                map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
            }
            global.parcelLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties) {
                    const layerParcelId = layer.feature.properties.CESTICA_ID.toString();
                    const isRoad = PersistentStorage.getItem(`parcel_${layerParcelId}_isRoad`) === 'true';
                    if (layerParcelId !== parcelId.toString()) {
                        // Check if this parcel is part of multi-selection before resetting style
                        const isMultiSelected = typeof global.multiParcelSelection !== 'undefined' &&
                            global.multiParcelSelection.isActive &&
                            global.multiParcelSelection.selectedParcels.has(layerParcelId);
                        if (!isMultiSelected) {
                            // Use getParcelStyle to preserve ownership highlighting
                            const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
                            layer.setStyle(styleFn(layerParcelId, layer, { isRoad }));
                        }
                    }
                }
            });
            selectedLayer.setStyle(global.selectedParcelStyle);
            selectedLayer.bringToFront();
            global.currentParcel = {
                id: parcelId,
                layer: selectedLayer,
                isRoad: PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
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

