(function (global) {
    'use strict';

    const adParcelIdSet = (global.adParcelIdSet instanceof Set) ? global.adParcelIdSet : new Set();
    global.adParcelIdSet = adParcelIdSet;
    if (typeof global.showAdParcels !== 'boolean') {
        global.showAdParcels = false;
    }

    function supportsOssOwnership() {
        return typeof global.getCurrentCityId === 'function' ? global.getCurrentCityId() === 'zagreb' : false;
    }

    function formatParcelText(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function translateParcelText(key, fallback, params = {}) {
        const api = (typeof global !== 'undefined' && global.i18n) ? global.i18n : null;
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return formatParcelText(fallback, params);
    }

    function showParcelAlert(key, fallback, params = {}) {
        const message = translateParcelText(`alerts.messages.${key}`, fallback, params);
        const alertFn = (typeof global !== 'undefined' && typeof global.showStyledAlert === 'function')
            ? global.showStyledAlert
            : global.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    }

    const roadStyle = {
        // Fresh asphalt look; center dashed line is drawn separately
        fillColor: '#2b2b2b',
        fillOpacity: 0.7,
        color: '#2b2b2b',
        weight: 1,
        dashArray: null
    };
    const trackStyle = {
        color: '#000000',
        weight: 2,
        opacity: 0.9,
        dashArray: '',
        fillColor: '#d3d3d3',
        fillOpacity: 0.35
    };
    const adParcelStyle = {
        fillColor: '#b5f7b2',
        fillOpacity: 0.45,
        color: '#2e7d32',
        weight: 2,
        opacity: 1
    };
    const normalStyle = {
        fillColor: 'red',
        fillOpacity: 0.2,
        color: 'red',
        weight: 1
    };
    const selectedParcelStyle = {
        fillColor: '#ff3300',
        fillOpacity: 0.4,
        color: '#ff3300',
        weight: 4,
        opacity: 1,
        dashArray: ''
    };

    const appliedProposalStyleTemplate = {
        color: normalStyle.color,
        weight: normalStyle.weight,
        opacity: normalStyle.opacity !== undefined ? normalStyle.opacity : 1,
        dashArray: normalStyle.dashArray || '',
        fillColor: normalStyle.fillColor,
        // Keep fills visible for applied spatial proposals (e.g., building overlays) instead of clearing to transparent
        fillOpacity: normalStyle.fillOpacity
    };

    let parcelsWithAppliedSpatialProposals = new Set();

    function createAppliedProposalStyle() {
        return { ...appliedProposalStyleTemplate };
    }

    function parcelHasAppliedSpatialProposal(parcelId) {
        if (parcelId === undefined || parcelId === null) return false;
        return parcelsWithAppliedSpatialProposals.has(parcelId.toString());
    }

    function getParcelBaseStyle(parcelId, optionsOrLayer = {}, maybeOptions = {}) {
        // Handle case where second arg is a layer (for compatibility with getParcelStyle signature)
        let options = optionsOrLayer;
        let layer = null;
        if (optionsOrLayer && typeof optionsOrLayer === 'object' && optionsOrLayer.feature) {
            layer = optionsOrLayer;
            options = maybeOptions || {};
        }
        const { isRoad: isRoadOverride, isTrack: isTrackOverride } = options || {};
        const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;

        // Check track first - tracks have isCorridor=true and isTrack=true but isRoad=false
        let trackFlag = typeof isTrackOverride === 'boolean' ? isTrackOverride : false;
        if (!trackFlag && layer) {
            if (layer.feature && layer.feature.properties && layer.feature.properties.isTrack === true) {
                trackFlag = true;
            } else if (layer._trackStyle) {
                trackFlag = true;
            }
        }
        if (trackFlag) {
            if (layer && layer._trackStyle) {
                return { ...layer._trackStyle };
            }
            return { ...trackStyle };
        }

        // Check for road (tracks have isRoad=false, so no conflict)
        const roadFlag = typeof isRoadOverride === 'boolean'
            ? isRoadOverride
            : (idStr ? (typeof global.isRoad === 'function' ? global.isRoad(idStr) : false) : false);
        if (roadFlag) {
            return { ...roadStyle };
        }

        const isAdParcel = Boolean(global.showAdParcels && idStr && adParcelIdSet.has(idStr));
        if (isAdParcel) {
            return { ...adParcelStyle };
        }
        if (idStr && parcelHasAppliedSpatialProposal(idStr)) {
            return createAppliedProposalStyle();
        }
        return { ...normalStyle };
    }

    /**
     * Get the appropriate style for a parcel, considering ownership highlighting
     * @param {string|number} parcelId - The parcel ID
     * @param {Object} layer - Optional layer object to check ownership type from
     * @param {Object} options - Optional style options
     * @returns {Object} Style object for the parcel
     */
    function getParcelStyle(parcelId, layer = null, options = {}) {
        const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!idStr) {
            return { ...normalStyle };
        }

        // Get base style first - pass layer so track detection works
        const baseStyle = getParcelBaseStyle(parcelId, layer, options);

        // Roads, tracks, and ad parcels use their specific styles, don't apply ownership highlighting
        const { isRoad: isRoadOverride } = options || {};
        const roadFlag = typeof isRoadOverride === 'boolean'
            ? isRoadOverride
            : (idStr ? (typeof global.isRoad === 'function' ? global.isRoad(idStr) : false) : false);
        const isAdParcel = Boolean(global.showAdParcels && idStr && adParcelIdSet.has(idStr));

        // Check if this is a track parcel (via layer or by searching parcelLayer)
        let isTrackParcelFlag = false;
        if (layer && layer.feature && layer.feature.properties && layer.feature.properties.isTrack === true) {
            isTrackParcelFlag = true;
        } else if (layer && layer._trackStyle) {
            isTrackParcelFlag = true;
        }

        if (roadFlag || isAdParcel || isTrackParcelFlag || (idStr && parcelHasAppliedSpatialProposal(idStr))) {
            return baseStyle;
        }

        // Check for ownership type highlighting for non-road, non-ad parcels
        const ownershipHighlight = global.ParcelsOwnershipHighlight;
        if (ownershipHighlight && typeof ownershipHighlight.getSelectedOwnershipTypes === 'function') {
            const selectedTypes = ownershipHighlight.getSelectedOwnershipTypes();
            if (selectedTypes.size > 0) {
                // Try to get ownership type from layer if provided, otherwise from feature properties
                let ownershipType = null;
                if (layer && layer.feature && layer.feature.properties) {
                    ownershipType = layer.feature.properties.ownershipType;
                }

                if (ownershipType && selectedTypes.has(ownershipType)) {
                    const highlightColors = {
                        'government': { fillColor: '#4a90e2', fillOpacity: 0.3, color: '#2e5c8a', weight: 2 },
                        'institution': { fillColor: '#9b59b6', fillOpacity: 0.3, color: '#6b3d8f', weight: 2 },
                        'company': { fillColor: '#f39c12', fillOpacity: 0.3, color: '#b8730d', weight: 2 },
                        'private individual': { fillColor: '#27ae60', fillOpacity: 0.3, color: '#1e8449', weight: 2 }
                    };
                    const highlightStyle = highlightColors[ownershipType];
                    if (highlightStyle) {
                        return { ...highlightStyle };
                    }
                }
            }
        }

        // Fall back to base style if no ownership highlighting applies
        return baseStyle;
    }

    function recomputeParcelsWithAppliedSpatialProposals() {
        const result = new Set();
        if (typeof global.proposalStorage !== 'undefined' && global.proposalStorage && typeof global.proposalStorage.getAllProposals === 'function') {
            try {
                const proposals = global.proposalStorage.getAllProposals();
                proposals.forEach(proposal => {
                    if (!proposal) return;
                    const status = (proposal.status || '').toLowerCase();
                    const parcelIds = [];
                    const buildingProposal = proposal.buildingProposal || null;
                    if (buildingProposal) {
                        const buildingStatus = (buildingProposal.status || status).toLowerCase();
                        if (buildingStatus === 'applied' || buildingStatus === 'executed') {
                            const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
                                ? buildingProposal.parentParcelIds
                                : (Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : []);
                            if (Array.isArray(ids)) parcelIds.push(...ids);
                        }
                    } else {
                        const goalKey = (typeof global.normalizeProposalGoalKey === 'function')
                            ? global.normalizeProposalGoalKey(proposal.goal)
                            : (proposal.goal || '').toLowerCase();
                        const isBuildingGoal = ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey);
                        if ((isBuildingGoal || (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length))
                            && (status === 'applied' || status === 'executed')) {
                            if (Array.isArray(proposal.parentParcelIds)) parcelIds.push(...proposal.parentParcelIds);
                        }
                    }

                    const structureProposal = proposal.structureProposal || null;
                    if (structureProposal) {
                        const kind = (structureProposal.kind || '').toLowerCase();
                        const structureStatus = (structureProposal.status || status).toLowerCase();
                        if ((kind === 'park' || kind === 'square') && (structureStatus === 'applied' || structureStatus === 'executed')) {
                            const ids = Array.isArray(structureProposal.parentParcelIds) && structureProposal.parentParcelIds.length > 0
                                ? structureProposal.parentParcelIds
                                : (Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : []);
                            if (Array.isArray(ids)) parcelIds.push(...ids);
                        }
                    }

                    parcelIds
                        .filter(id => id !== undefined && id !== null)
                        .forEach(id => result.add(id.toString()));
                });
            } catch (error) {
                console.warn('recomputeParcelsWithAppliedSpatialProposals failed', error);
            }
        }
        parcelsWithAppliedSpatialProposals = result;
        return result;
    }

    function refreshParcelStylesForAppliedProposals() {
        recomputeParcelsWithAppliedSpatialProposals();
        if (!global.parcelLayer) return;

        const mapBounds = (global.map && typeof global.map.getBounds === 'function') ? global.map.getBounds() : null;

        const selectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        const hasMultiSelection = typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection && global.multiParcelSelection.isActive;

        // Check if we need ownership highlighting (expensive operation)
        const ownershipHighlight = global.ParcelsOwnershipHighlight;
        const ownershipTypesActive = ownershipHighlight
            && typeof ownershipHighlight.getSelectedOwnershipTypes === 'function'
            && ownershipHighlight.getSelectedOwnershipTypes().size > 0;

        // For ownership highlighting, we need to be smarter about which parcels we process
        // If ownership types are active and we have getParcelsInBounds, use it for optimization
        let parcelsToProcess = null;
        let visibleParcelIds = null;

        if (ownershipTypesActive && typeof global.getParcelsInBounds === 'function' && mapBounds) {
            // Get only visible parcels for the expensive ownership highlighting
            parcelsToProcess = global.getParcelsInBounds(mapBounds);
            visibleParcelIds = new Set(parcelsToProcess.map(layer => {
                const pid = layer?.feature?.properties?.parcelId;
                return pid !== undefined && pid !== null ? pid.toString() : null;
            }).filter(Boolean));
        }

        // Process layers - use optimized path when available
        const processLayer = (layer) => {
            const parcelId = layer?.feature?.properties?.parcelId;
            if (parcelId === undefined || parcelId === null) return;
            const idStr = parcelId.toString();

            // For ownership highlighting, skip parcels not in view (if we have that info)
            const isInVisibleSet = visibleParcelIds ? visibleParcelIds.has(idStr) : true;

            if (selectedId && idStr === selectedId) {
                const isTrackSelected = (layer?.feature?.properties?.isTrack === true) || Boolean(layer?._trackStyle);
                if (isTrackSelected) {
                    const trackStyle = getParcelBaseStyle(idStr, layer, { isTrack: true });
                    layer.setStyle({ ...trackStyle, weight: 4 });
                } else {
                    layer.setStyle(selectedParcelStyle);
                }
                layer.bringToFront();
                return;
            }

            if (hasMultiSelection && global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.has(idStr)) {
                layer.setStyle({
                    fillColor: '#ff9800',
                    fillOpacity: 0.6,
                    color: '#f57c00',
                    weight: 3
                });
                return;
            }

            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
            const currentSelectedBlockName = (typeof global.selectedBlockName !== 'undefined' && global.selectedBlockName)
                ? global.selectedBlockName
                : (typeof global !== 'undefined' ? global.selectedBlockName : null);
            const layerBlockName = layer?.feature?.properties?.block;
            if (blocksShown && currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                layer.setStyle({ fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 });
                return;
            }

            // Check for ownership type highlighting - only for visible parcels
            if (ownershipTypesActive) {
                if (!isInVisibleSet) {
                    // Not in view - just reset to base style, skip expensive ownership check
                    layer.setStyle(getParcelBaseStyle(idStr, layer));
                    return;
                }

                const selectedTypes = ownershipHighlight.getSelectedOwnershipTypes();
                const ownershipType = layer?.feature?.properties?.ownershipType;
                if (ownershipType && selectedTypes.has(ownershipType)) {
                    const highlightColors = {
                        'government': { fillColor: '#4a90e2', fillOpacity: 0.3, color: '#2e5c8a', weight: 2 },
                        'institution': { fillColor: '#9b59b6', fillOpacity: 0.3, color: '#6b3d8f', weight: 2 },
                        'company': { fillColor: '#f39c12', fillOpacity: 0.3, color: '#b8730d', weight: 2 },
                        'private individual': { fillColor: '#27ae60', fillOpacity: 0.3, color: '#1e8449', weight: 2 }
                    };
                    const highlightStyle = highlightColors[ownershipType];
                    if (highlightStyle) {
                        layer.setStyle(highlightStyle);
                        return;
                    }
                }
            }

            // Skip parcels that are locked for road drawing (preserve green highlighting)
            if (typeof global.isParcelLockedForRoadDrawing === 'function' && global.isParcelLockedForRoadDrawing(idStr)) {
                return;
            }

            // Pass layer so getParcelBaseStyle can detect track properties
            layer.setStyle(getParcelBaseStyle(idStr, layer));
        };

        // Process all layers (we still need to touch all for proper state management)
        global.parcelLayer.eachLayer(processLayer);

        if (hasMultiSelection && typeof global.multiParcelSelection?.reapplyMultiParcelHighlights === 'function') {
            global.multiParcelSelection.reapplyMultiParcelHighlights();
        }

        if (typeof global.rehighlightSelectedBlockParcels === 'function') {
            global.rehighlightSelectedBlockParcels();
        }

        if (selectedId) {
            const selectedLayer = global.parcelLayer.getLayers().find(layer =>
                layer.feature && layer.feature.properties && layer.feature.properties.parcelId.toString() === selectedId
            );
            if (selectedLayer) {
                const isTrackSelected = (selectedLayer?.feature?.properties?.isTrack === true) || Boolean(selectedLayer?._trackStyle);
                if (isTrackSelected) {
                    const trackStyle = getParcelBaseStyle(selectedId, selectedLayer, { isTrack: true });
                    selectedLayer.setStyle({ ...trackStyle, weight: 4 });
                } else {
                    selectedLayer.setStyle(selectedParcelStyle);
                }
                selectedLayer.bringToFront();
            }
        }
    }

    global.supportsOssOwnership = supportsOssOwnership;
    global.formatParcelText = formatParcelText;
    global.translateParcelText = translateParcelText;
    global.showParcelAlert = showParcelAlert;
    global.roadStyle = roadStyle;
    global.trackStyle = trackStyle;
    global.normalStyle = normalStyle;
    global.adParcelStyle = adParcelStyle;
    global.selectedParcelStyle = selectedParcelStyle;
    global.appliedProposalStyleTemplate = appliedProposalStyleTemplate;
    global.createAppliedProposalStyle = createAppliedProposalStyle;
    global.parcelHasAppliedSpatialProposal = parcelHasAppliedSpatialProposal;
    global.getParcelBaseStyle = getParcelBaseStyle;
    global.getParcelStyle = getParcelStyle;
    global.recomputeParcelsWithAppliedSpatialProposals = recomputeParcelsWithAppliedSpatialProposals;
    global.refreshParcelStylesForAppliedProposals = refreshParcelStylesForAppliedProposals;
    global.parcelsWithAppliedSpatialProposals = parcelsWithAppliedSpatialProposals;
})(typeof window !== 'undefined' ? window : globalThis);

