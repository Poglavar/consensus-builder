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
    const corridorParcelStyle = {
        // The cross-section renderer supplies the visible asphalt, paths and verges. This underlying
        // structural parcel only needs a quiet footprint for edges the lane geometry does not cover.
        fillColor: '#94a3b8',
        fillOpacity: 0.12,
        color: '#64748b',
        opacity: 0.55,
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
        fillOpacity: 0,
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
        // Border-only, like every other parcel. The old 0.2 red fill "pink-shaded" the WHOLE
        // parcel whenever any applied park/square/building touched a corner of it — the
        // proposal's own visuals already show where it sits, so the parcel fill was only noise.
        fillOpacity: 0
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
        let options = optionsOrLayer;
        let layer = null;
        if (global.ParcelPresenter?.getIdForLayer?.(optionsOrLayer)) {
            layer = optionsOrLayer;
            options = maybeOptions || {};
        } else if (optionsOrLayer === null || optionsOrLayer === undefined) {
            options = maybeOptions || {};
        }
        const { isRoad: isRoadOverride, isTrack: isTrackOverride } = options || {};
        const idStr = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        // Style decisions only read properties, so use the fabric's non-cloning read: a full
        // restyle touches every presented layer and `get` would deep-clone each polygon.
        const fabric = global.LiveParcelFabric;
        const readFabric = fabric ? (fabric.peek || fabric.get) : null;
        const feature = options?.feature?.type === 'Feature'
            ? options.feature
            : (idStr && readFabric ? readFabric.call(fabric, idStr) || null : null);
        const properties = feature?.properties || {};

        // Check track first - tracks have isCorridor=true and isTrack=true but isRoad=false
        let trackFlag = typeof isTrackOverride === 'boolean' ? isTrackOverride : false;
        if (!trackFlag) {
            trackFlag = properties.isTrack === true || Boolean(layer?._trackStyle);
        }
        if (trackFlag) {
            if (layer && layer._trackStyle) {
                return { ...layer._trackStyle };
            }
            return { ...trackStyle };
        }

        const corridorRoadFlag = properties.isCorridor === true && properties.isRoad === true;
        if (corridorRoadFlag) {
            return { ...corridorParcelStyle };
        }

        // Check for road (tracks have isRoad=false, so no conflict). Both sources count: the
        // feature's own isRoad flag (child slices carry it before addRoadParcel registers them)
        // and the persisted road-parcel set (legacy/curated parcels carry no flag at all).
        const propsRoadFlag = properties.isRoad === true || properties.isRoad === 'true';
        const roadFlag = typeof isRoadOverride === 'boolean'
            ? isRoadOverride
            : (propsRoadFlag || (idStr ? (typeof global.isRoad === 'function' ? global.isRoad(idStr) : false) : false));
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
        const properties = global.LiveParcelFabric?.get?.(idStr)?.properties || options?.feature?.properties || {};

        // Roads, tracks, and ad parcels use their specific styles, don't apply ownership highlighting
        const { isRoad: isRoadOverride } = options || {};
        const propsRoadFlag = properties.isRoad === true || properties.isRoad === 'true';
        const roadFlag = typeof isRoadOverride === 'boolean'
            ? isRoadOverride
            : (propsRoadFlag || (idStr ? (typeof global.isRoad === 'function' ? global.isRoad(idStr) : false) : false));
        const isAdParcel = Boolean(global.showAdParcels && idStr && adParcelIdSet.has(idStr));

        // Check if this is a track parcel (via layer or by searching parcelLayer)
        let isTrackParcelFlag = false;
        if (properties.isTrack === true) {
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
                // Ask the module, not the feature: a re-ingested parcel arrives without the
                // property, and its type lives in the id-keyed cache until something re-stamps it.
                const ownershipType = (typeof ownershipHighlight.typeFor === 'function')
                    ? ownershipHighlight.typeFor(layer)
                    : properties.ownershipType;

                if (ownershipType && selectedTypes.has(ownershipType)) {
                    const highlightStyle = typeof ownershipHighlight.styleFor === 'function'
                        ? ownershipHighlight.styleFor(ownershipType)
                        : null;
                    if (highlightStyle) {
                        return highlightStyle;
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
                    const parcelIds = [];
                    const buildingProposal = proposal.buildingProposal || null;
                    if (buildingProposal) {
                        if (isApplied(proposal, buildingProposal)) {
                            const ids = Array.isArray(proposal.cadastreParcelIds)
                                ? proposal.cadastreParcelIds
                                : [];
                            if (Array.isArray(ids)) parcelIds.push(...ids);
                        }
                    } else {
                        const goalKey = (typeof global.normalizeProposalGoalKey === 'function')
                            ? global.normalizeProposalGoalKey(proposal.goal)
                            : (proposal.goal || '').toLowerCase();
                        const isBuildingGoal = ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey);
                        if ((isBuildingGoal || (proposal.geometry && Array.isArray(proposal.geometry.buildings) && proposal.geometry.buildings.length))
                            && isApplied(proposal)) {
                            if (Array.isArray(proposal.cadastreParcelIds)) parcelIds.push(...proposal.cadastreParcelIds);
                        }
                    }

                    const structureProposal = proposal.structureProposal || null;
                    if (structureProposal) {
                        const kind = (structureProposal.kind || '').toLowerCase();
                        if ((kind === 'park' || kind === 'square') && isApplied(proposal, structureProposal)) {
                            const ids = Array.isArray(proposal.cadastreParcelIds)
                                ? proposal.cadastreParcelIds
                                : [];
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

    // With no options every presented layer is restyled (a mode change: ownership highlight,
    // block selection). After one proposal changes, pass `parcelIds` — the live pieces under
    // that proposal — and only those, the parcels whose applied-proposal membership changed and
    // the selection are touched. Profiled on a 7,000-layer Šibenik view, the full pass was 30%
    // of every single apply or unapply.
    function refreshParcelStylesForAppliedProposals(options = {}) {
        const membershipBefore = parcelsWithAppliedSpatialProposals;
        const membershipAfter = recomputeParcelsWithAppliedSpatialProposals();
        if (!global.LiveParcelFabric || !global.ParcelPresenter) return;

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
            visibleParcelIds = new Set(parcelsToProcess
                .map(layer => global.ParcelPresenter?.getIdForLayer?.(layer))
                .filter(Boolean).map(String));
        }

        // Process layers - use optimized path when available
        const processLayer = (layer) => {
            const parcelId = global.ParcelPresenter?.getIdForLayer?.(layer);
            if (parcelId === undefined || parcelId === null) return;
            const idStr = parcelId.toString();
            const fabric = global.LiveParcelFabric;
            const feature = fabric ? (fabric.peek ? fabric.peek(idStr) : fabric.get(idStr)) : null;
            if (!feature) return;

            // For ownership highlighting, skip parcels not in view (if we have that info)
            const isInVisibleSet = visibleParcelIds ? visibleParcelIds.has(idStr) : true;

            if (selectedId && idStr === selectedId) {
                const isTrackSelected = feature.properties?.isTrack === true || Boolean(layer?._trackStyle);
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
            const layerBlockName = global.parcelBlockNameForId?.(idStr) || null;
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
                const ownershipType = (typeof ownershipHighlight.typeFor === 'function')
                    ? ownershipHighlight.typeFor(layer)
                    : feature.properties?.ownershipType;
                if (ownershipType && selectedTypes.has(ownershipType)) {
                    const highlightStyle = typeof ownershipHighlight.styleFor === 'function'
                        ? ownershipHighlight.styleFor(ownershipType)
                        : null;
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

        // Process all layers (we still need to touch all for proper state management). Ids come
        // from the snapshot: `list()` deep-clones every polygon in the fabric, and profiled on a
        // 7,000-parcel Šibenik view that one call was 70% of a corridor apply.
        let fabricIds;
        if (options && options.parcelIds) {
            const targeted = new Set(Array.from(options.parcelIds, id => String(id)));
            membershipBefore.forEach(id => { if (!membershipAfter.has(id)) targeted.add(id); });
            membershipAfter.forEach(id => { if (!membershipBefore.has(id)) targeted.add(id); });
            if (selectedId) targeted.add(selectedId);
            fabricIds = Array.from(targeted);
        } else {
            fabricIds = global.LiveParcelFabric?.snapshot?.().parcelIds || [];
        }
        global.ParcelPresenter?.getLayers?.(fabricIds).forEach(processLayer);

        if (hasMultiSelection && typeof global.multiParcelSelection?.reapplyMultiParcelHighlights === 'function') {
            global.multiParcelSelection.reapplyMultiParcelHighlights();
        }

        if (typeof global.rehighlightSelectedBlockParcels === 'function') {
            global.rehighlightSelectedBlockParcels();
        }

        if (selectedId) {
            const selectedLayer = global.LiveParcelFabric?.get?.(selectedId)
                ? global.ParcelPresenter?.getLayer?.(selectedId)
                : null;
            if (selectedLayer) {
                const isTrackSelected = global.LiveParcelFabric?.get?.(selectedId)?.properties?.isTrack === true || Boolean(selectedLayer?._trackStyle);
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
    global.corridorParcelStyle = corridorParcelStyle;
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
