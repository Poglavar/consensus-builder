// proposals/layer-render.js — extracted from proposals.js (behavior-preserving relocation).

function ensureProposalHighlightPanes(targetMap) {
    if (!targetMap || typeof targetMap.getPane !== 'function' || typeof targetMap.createPane !== 'function') {
        return null;
    }

    // Keep these above markerPane (600) but below popupPane (700)
    const panes = {
        highlight: { name: 'proposalHighlightPane', zIndex: 650 },
        hover: { name: 'proposalHoverPane', zIndex: 660 },
        hoverLabels: { name: 'proposalHoverLabelPane', zIndex: 670 },
        draftSource: { name: 'proposalDraftSourcePane', zIndex: 674 },
        draft: { name: 'proposalDraftPane', zIndex: 676 }
    };

    Object.values(panes).forEach(({ name, zIndex }) => {
        try {
            if (!targetMap.getPane(name)) {
                targetMap.createPane(name);
            }
            const pane = targetMap.getPane(name);
            if (pane && pane.style) {
                pane.style.zIndex = String(zIndex);
            }
        } catch (error) {
            console.warn('ensureProposalHighlightPanes: unable to create pane', name, error);
        }
    });

    window.__proposalHighlightPanes = {
        highlight: panes.highlight.name,
        hover: panes.hover.name,
        hoverLabels: panes.hoverLabels.name,
        draftSource: panes.draftSource.name,
        draft: panes.draft.name
    };

    return window.__proposalHighlightPanes;
}

function ensureProposalOverlayGroups() {
    if (typeof map === 'undefined' || !map) {
        return {};
    }

    const panes = ensureProposalHighlightPanes(map);

    if (!window.proposalPreviewGroup) {
        window.proposalPreviewGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBorderGroup) {
        window.proposalBorderGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverGroup) {
        window.proposalHoverGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverLabelGroup) {
        window.proposalHoverLabelGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBackgroundGroup) {
        window.proposalBackgroundGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalAcceptedGroup) {
        window.proposalAcceptedGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBuildingPreviewGroup) {
        window.proposalBuildingPreviewGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalDraftSourceGroup) {
        window.proposalDraftSourceGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalDraftPreviewGroup) {
        window.proposalDraftPreviewGroup = L.featureGroup().addTo(map);
    }

    // Attach pane metadata so individual layers can render in a dedicated high-zIndex pane.
    // (FeatureGroup itself doesn't accept pane options.)
    if (panes) {
        window.proposalPreviewGroup.__paneName = panes.highlight;
        window.proposalBorderGroup.__paneName = panes.highlight;
        window.proposalBackgroundGroup.__paneName = panes.highlight;
        window.proposalAcceptedGroup.__paneName = panes.highlight;
        window.proposalBuildingPreviewGroup.__paneName = panes.highlight;
        window.proposalHoverGroup.__paneName = panes.hover;
        window.proposalHoverLabelGroup.__paneName = panes.hoverLabels;
        window.proposalDraftSourceGroup.__paneName = panes.draftSource;
        window.proposalDraftPreviewGroup.__paneName = panes.draft;
    }

    return {
        preview: window.proposalPreviewGroup,
        border: window.proposalBorderGroup,
        hover: window.proposalHoverGroup,
        hoverLabels: window.proposalHoverLabelGroup,
        background: window.proposalBackgroundGroup,
        accepted: window.proposalAcceptedGroup,
        buildingPreview: window.proposalBuildingPreviewGroup,
        draftSource: window.proposalDraftSourceGroup,
        draft: window.proposalDraftPreviewGroup
    };
}

function proposalDraftGeometryFeatures(descriptor, draft) {
    const features = [];
    const pushGeometry = (value, properties = {}) => {
        if (!value) return;
        if (value.type === 'Feature') {
            if (value.geometry) features.push(value);
            return;
        }
        if (value.type === 'FeatureCollection') {
            (value.features || []).forEach(feature => pushGeometry(feature));
            return;
        }
        if (value.type && Array.isArray(value.coordinates)) {
            features.push({ type: 'Feature', properties, geometry: value });
        }
    };

    if (descriptor?.kind === 'corridor') {
        const definition = descriptor.definition || {};
        pushGeometry(definition.polygon, { draftKind: 'corridor' });
        if (!features.length) {
            const raw = definition.points || definition.segments || [];
            const segments = Array.isArray(raw?.[0]) ? raw : (raw.length ? [raw] : []);
            segments.forEach((segment, index) => {
                const coordinates = (segment || []).map(point => {
                    const lat = Number(point?.lat !== undefined ? point.lat : point?.[1]);
                    const lng = Number(point?.lng !== undefined ? point.lng : point?.[0]);
                    return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
                }).filter(Boolean);
                if (coordinates.length >= 2) pushGeometry({ type: 'LineString', coordinates }, { draftKind: 'corridor', segmentIndex: index });
            });
        }
    } else if (descriptor?.kind === 'buildings') {
        (descriptor.features || []).forEach(feature => pushGeometry(feature));
    } else if (descriptor?.kind === 'reparcellization') {
        (descriptor.polygons || []).forEach(polygon => pushGeometry(polygon.geometry || polygon));
    } else {
        pushGeometry(descriptor?.geometry || null);
    }

    if (!features.length) {
        (descriptor?.parcelIds || draft?.fields?.parentParcelIds || []).forEach(parcelId => {
            const feature = getParcelFeatureForHighlight(parcelId, draft?.sourceSnapshot || null, { skipRecovery: true });
            if (feature) features.push(feature);
        });
    }
    return features;
}

function updateProposalDraftMapPreview(detail) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.draftSource || !groups.draft) return;
    groups.draftSource.clearLayers();
    groups.draft.clearLayers();
    if (!detail) return;

    const draft = window.proposalDraftStore?.getDraft?.(detail.draftId) || null;
    const sourceStyle = {
        color: detail.sourceStyle?.color || '#64748b',
        fillColor: detail.sourceStyle?.color || '#64748b',
        weight: 3,
        opacity: 0.55,
        fillOpacity: 0.08,
        dashArray: '3 7',
        className: 'proposal-draft-source-geometry'
    };
    const draftStyle = {
        color: detail.draftStyle?.color || '#2563eb',
        fillColor: detail.draftStyle?.color || '#2563eb',
        weight: 4,
        opacity: 1,
        fillOpacity: 0.2,
        dashArray: detail.draftStyle?.dashArray || '8 5',
        className: 'proposal-draft-preview-geometry'
    };

    if (detail.sourceProposal) {
        let sourceFeatures = [];
        try {
            const sets = collectProposalFeatureSets(detail.sourceProposal, { includeBuildingGeometry: true });
            sourceFeatures = sets.primaryFeatures?.length ? sets.primaryFeatures : sets.parcelFeatures || [];
        } catch (_) { }
        sourceFeatures.forEach(feature => addFeatureToGroup(feature, groups.draftSource, sourceStyle));
    }
    if (detail.draftPreview) {
        proposalDraftGeometryFeatures(detail.draftPreview, draft)
            .forEach(feature => addFeatureToGroup(feature, groups.draft, draftStyle));
    }
    try { groups.draftSource.bringToFront?.(); } catch (_) { }
    try { groups.draft.bringToFront?.(); } catch (_) { }
}

if (typeof window !== 'undefined') window.updateProposalDraftMapPreview = updateProposalDraftMapPreview;

function clearProposalBackgroundLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.background) groups.background.clearLayers();
}

function clearProposalAcceptedLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.accepted) groups.accepted.clearLayers();
}

function clearProposalHoverLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.hover) groups.hover.clearLayers();
    if (groups.hoverLabels) groups.hoverLabels.clearLayers();
}

function highlightFeaturesForHover(features, { color = '#FFB300', weight = 5, dashArray = '4 4', showLabels = false, className = 'proposal-hover-outline proposal-hover-outline--animate' } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.hover || !groups.hoverLabels) return;

    const panes = window.__proposalHighlightPanes || null;

    groups.hover.clearLayers();
    groups.hoverLabels.clearLayers();

    if (!Array.isArray(features)) return;

    features.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            const outline = L.geoJSON(feature, {
                pane: panes?.hover || undefined,
                style: {
                    color,
                    weight,
                    fillOpacity: 0,
                    dashArray,
                    className
                },
                interactive: false
            });
            outline.addTo(groups.hover);

            if (showLabels) {
                const broj = getParcelDisplayNumberFromFeature(feature);
                const center = getFeatureCentroid(feature);
                if (broj && center) {
                    const label = L.marker(center, {
                        pane: panes?.hoverLabels || undefined,
                        icon: L.divIcon({
                            className: 'proposal-hover-parcel-label',
                            html: `${broj}`,
                            iconSize: [46, 20],
                            iconAnchor: [23, 10]
                        }),
                        interactive: false
                    });
                    label.addTo(groups.hoverLabels);
                }
            }
        } catch (error) {
            console.warn('Failed to highlight feature for hover', error);
        }
    });

    if (groups.hover.bringToFront) groups.hover.bringToFront();
    if (groups.hoverLabels.bringToFront) groups.hoverLabels.bringToFront();
}

function getParcelFeatureForHighlight(parcelId, proposalContext = null, options = {}) {
    const { skipRecovery = false } = options;
    const proposal = proposalContext && proposalContext.proposal ? proposalContext.proposal : proposalContext;
    const cached = proposal ? getCachedParcelFeature(parcelId, proposal) : null;
    if (cached) {
        return cached;
    }

    if (!parcelId || typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) {
        return null;
    }

    try {
        // If skipRecovery is true, don't trigger recoverParcelFromProposals (prevents infinite recursion)
        const layer = skipRecovery
            ? (multiParcelSelection.parcelIdIndex && multiParcelSelection.parcelIdIndex.get(parcelId.toString()))
            : multiParcelSelection.findParcelById(parcelId);
        if (layer && typeof layer.toGeoJSON === 'function') {
            const feature = layer.toGeoJSON();
            if (proposal) {
                const cache = buildProposalFeatureCache(proposal);
                if (cache && cache.parcelsById) {
                    try {
                        cache.parcelsById.set(parcelId.toString(), feature);
                    } catch (_) { }
                }
            }
            return feature;
        }
    } catch (error) {
        console.warn('getParcelFeatureForHighlight: unable to locate parcel', parcelId, error);
    }
    return null;
}

function collectProposalHighlightFeatures(proposal, { includeParents = false, includeChildren = true } = {}) {
    const features = [];
    if (!proposal) return features;

    const cache = buildProposalFeatureCache(proposal) || {};

    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal;

    if (isRoadProposal && includeChildren !== false) {
        const childIds = Array.isArray(proposal.roadProposal.childParcelIds)
            ? proposal.roadProposal.childParcelIds
            : [];
        const uniqueChildIds = Array.from(new Set(childIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueChildIds.forEach(childId => {
            const feature = getParcelFeatureForHighlight(childId, proposal);
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if (includeParents && proposal.roadProposal) {
        // Fetch parent features by ID - never read from cached parentFeatures
        const parentIds = [];
        if (Array.isArray(proposal.roadProposal.parentParcelIds)) parentIds.push(...proposal.roadProposal.parentParcelIds);
        if (Array.isArray(proposal.parentParcelIds)) parentIds.push(...proposal.parentParcelIds);
        if (Array.isArray(proposal.parentParcelIds)) parentIds.push(...proposal.parentParcelIds);
        const uniqueParentIds = Array.from(new Set(parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueParentIds.forEach(parentId => {
            const feature = getParcelFeatureForHighlight(parentId, proposal);
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if ((!isRoadProposal || features.length === 0) && Array.isArray(proposal.parentParcelIds)) {
        proposal.parentParcelIds.forEach(parcelId => {
            const feature = getParcelFeatureForHighlight(parcelId, proposal);
            if (feature) {
                features.push(feature);
            }
        });
    }

    return features;
}

function highlightParcelHover(parcelId, options = {}) {
    const proposal = options.proposal || null;
    const feature = getParcelFeatureForHighlight(parcelId, proposal);
    if (feature) {
        highlightFeaturesForHover([feature], {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true,
            ...options
        });
    }
}

function highlightProposalHover(proposal, options = {}) {
    const features = collectProposalHighlightFeatures(proposal, options);
    if (features.length > 0) {
        highlightFeaturesForHover(features, options);
    }
}

function highlightProposalHoverById(proposalId, options = {}) {
    if (!proposalId || typeof proposalStorage === 'undefined') return;
    const proposal = proposalStorage.getProposal(proposalId);
    if (proposal) {
        highlightProposalHover(proposal, options);
    }
}

function collectProposalHighlightParcelIdSet(proposal) {
    const ids = new Set();
    if (!proposal) return ids;
    const push = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const id of arr) {
            if (id == null) continue;
            const s = String(id);
            if (s) ids.add(s);
        }
    };
    push(proposal.parentParcelIds);
    if (resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal) {
        push(proposal.roadProposal.childParcelIds);
    }
    if (proposal.decideLaterProposal) push(proposal.decideLaterProposal.childParcelIds);
    if (proposal.reparcellization) push(proposal.reparcellization.childParcelIds);
    return ids;
}

function applyBlinkToLayerGroup(layerGroup, className) {
    if (!layerGroup || !className) return;
    if (typeof layerGroup.eachLayer !== 'function') return;

    layerGroup.eachLayer(layer => {
        if (layer && typeof layer.getElement === 'function') {
            const el = layer.getElement();
            if (el) {
                el.classList.remove(className);
                // Force reflow to restart animation
                // eslint-disable-next-line no-unused-expressions
                el.offsetWidth;
                el.classList.add(className);
            }
        }
    });
}

function addFeatureToGroup(feature, group, styleOptions, blinkClass) {
    if (!feature || !group) return null;
    try {
        const paneName = group.__paneName;
        const layer = L.geoJSON(feature, {
            pane: paneName || undefined,
            style: typeof styleOptions === 'function' ? styleOptions : () => ({ ...styleOptions }),
            interactive: false
        });
        layer.addTo(group);
        if (blinkClass) {
            requestAnimationFrame(() => applyBlinkToLayerGroup(layer, blinkClass));
        }
        return layer;
    } catch (error) {
        console.warn('addFeatureToGroup: unable to render feature', error);
        return null;
    }
}

function highlightParcelLayerInPlace(parcelIdOrFeature, styleOptions) {
    const id = (parcelIdOrFeature && typeof parcelIdOrFeature === 'object' && parcelIdOrFeature.type === 'Feature')
        ? (typeof getParcelIdFromFeature === 'function' ? getParcelIdFromFeature(parcelIdOrFeature) : null)
        : parcelIdOrFeature;
    if (id == null) return false;
    const idStr = id && id.toString ? id.toString() : String(id);
    if (!idStr) return false;
    let layer = null;
    try {
        const mapById = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map)
            ? window.parcelLayerById
            : null;
        if (mapById) {
            layer = mapById.get(idStr) || null;
        }
        if (!layer && typeof resolveParcelLayerById === 'function') {
            layer = resolveParcelLayerById(idStr);
        }
    } catch (_) { /* ignore */ }
    if (!layer) return false;
    return proposalHighlightStyleOverride.apply(layer, styleOptions);
}

function renderAppliedProposalHighlight(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.border) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    // Restore any previous in-place parcel-layer style overrides before painting new ones.
    // Without this, a repaint (pan / zoom / parcelDataLoaded) would leave the old highlighted
    // layers styled even if they are no longer part of the active proposal's viewport set.
    proposalHighlightStyleOverride.restoreAll();

    const _tClear0 = performance.now();
    groups.border.clearLayers();
    const _tClear1 = performance.now();

    if (!proposal) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    const _tCollect0 = performance.now();
    const { parcelFeatures, primaryFeatures, parcelIds } = collectProposalFeatureSets(proposal, { includeBuildingGeometry: false });
    const _tCollect1 = performance.now();

    // A corridor proposal (road or track — the same object) styles its geometry differently from a
    // parcel-shaped one. There is no track branch: rails come from the rail lanes of its cross-section,
    // drawn by the corridor renderer, not from the kind of proposal this is.
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;
    const lifecycleStatus = (proposal?.status || proposal?.roadProposal?.status || '').toLowerCase();

    // Applied proposals should always be visible at all zoom levels, even when parcels are not shown
    // This allows users to see applied proposals regardless of zoom level

    // Parcels should be highlighted with blue fill like other proposals (parks, squares, etc.)
    // Solid border (not dashed) - only road geometry should be dashed
    const parcelStyle = {
        color: '#2563EB',
        fillColor: '#2563EB',
        weight: 3,
        opacity: 0.9,
        dashArray: null,
        fillOpacity: 0.2,
        className: 'proposal-parcel-outline'
    };

    if (isRoadProposal && (lifecycleStatus === 'applied' || lifecycleStatus === 'executed')) {
        // A selected applied corridor gets ONE crisp selection outline around its footprint — the
        // same visual language as a selected parcel. The cross-section strips already show the
        // corridor itself (rails included, when it has rail lanes), and shading every parent parcel
        // blue only buried the selection. A track takes this path like any other corridor.
        const roadSelectedStyle = {
            color: '#ff3300',
            weight: 3,
            opacity: 1,
            dashArray: null,
            fillOpacity: 0,
            className: 'proposal-road-selected-outline'
        };
        primaryFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.border, roadSelectedStyle, blink ? 'proposal-blink-twice' : null);
        });
    } else {
        // For (parked) road proposals, style road geometry with dashed lines and no fill
        // For other proposals, use the standard primary style
        const primaryStyle = isRoadProposal ? {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: '10 5',
            fillOpacity: 0,
            className: 'proposal-road-outline'
        } : {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: null,
            fillOpacity: 0.2,
            className: 'proposal-primary-outline'
        };

        // Parcel outlines: in-place style override (see note in track branch above).
        const parcelIdSet = collectProposalHighlightParcelIdSet(proposal);
        forEachProposalParcelInViewport(parcelIdSet, (layer) => {
            proposalHighlightStyleOverride.apply(layer, parcelStyle);
        });

        // Always show primary features for applied proposals at all zoom levels
        primaryFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.border, primaryStyle, blink ? 'proposal-blink-twice' : null);
        });
    }

    if (groups.border.bringToFront) {
        groups.border.bringToFront();
    }

    return {
        activeIds: new Set(parcelIds),
        primaryFeatures
    };
}

function updateProposalLayer() { /* intentionally empty */ }

function refreshProposalsLayer() {
    // No special layer to refresh anymore, keep count and indicator in sync
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
}

function applyProposalHighlights() {
    if (!window.currentlyHighlightedProposal) return;

    const proposal = window.currentlyHighlightedProposal;
    const shouldBlink = !!proposalHighlightState.pendingBlink;
    const { activeIds, primaryFeatures } = renderAppliedProposalHighlight(proposal, { blink: shouldBlink });

    proposalHighlightState.pendingBlink = false;
    proposalHighlightState.activeChildFeatures = primaryFeatures;
    // Don't cache parentFeatures - fetch by ID when needed
    proposalHighlightState.activeParentFeatures = [];
    proposalHighlightState.activeProposalId = getProposalKey(proposal);

    updateParcelNumberFilterForProposal(activeIds);
}

function clearProposalHighlights() {
    window.currentlyHighlightedProposal = null;
    // The id mirror must die with the selection: proposal-manager re-selects on apply/unapply when
    // this id matches, so a stale id resurrects the blue selection mid-drawing (absorb unapplies the
    // very road the user once clicked). It was set in selectAndHighlightProposal and never cleared.
    window.currentlyHighlightedProposalId = null;
    window.selectedParcelInProposal = null;

    // Restore any parcel-layer style overrides left behind by the previous highlight.
    proposalHighlightStyleOverride.restoreAll();

    clearProposalPreviewLayers();
    clearProposalHoverLayers();
    updateParcelNumberFilterForProposal(null);
    proposalHighlightState.activeChildFeatures = [];
    proposalHighlightState.activeParentFeatures = [];
    proposalHighlightState.activeProposalId = null;
    currentProposalPreviewId = null;

    if (multiParcelSelection.syntheticParcelLayers && multiParcelSelection.syntheticParcelLayers.size > 0) {
        multiParcelSelection.syntheticParcelLayers.forEach(layer => {
            try {
                if (multiParcelSelection.syntheticLayerGroup && multiParcelSelection.syntheticLayerGroup.hasLayer(layer)) {
                    multiParcelSelection.syntheticLayerGroup.removeLayer(layer);
                } else if (typeof map !== 'undefined' && map && map.hasLayer(layer)) {
                    map.removeLayer(layer);
                }
            } catch (error) {
                console.warn('clearProposalHighlights: unable to remove synthetic layer', error);
            }
        });
        multiParcelSelection.syntheticParcelLayers.clear();
    }

    if (multiParcelSelection.syntheticLayerGroup) {
        try {
            if (multiParcelSelection.syntheticLayerGroup.getLayers().length === 0 && typeof map !== 'undefined' && map && map.hasLayer(multiParcelSelection.syntheticLayerGroup)) {
                map.removeLayer(multiParcelSelection.syntheticLayerGroup);
                multiParcelSelection.syntheticLayerGroup = null;
            }
        } catch (_) {
            multiParcelSelection.syntheticLayerGroup = null;
        }
    }
}

function reapplyProposalHighlights() {
    if (window.currentlyHighlightedProposal && !window.isApplyingProposalHighlights) {
        // Apply highlights immediately - no delay needed with proper event handling
        applyProposalHighlights();
    }
}

function selectAndHighlightProposal(proposalIdOrHash, parcelId, shouldCenter = false, showDetails = true, keepHighlightsWithoutUi = false) {
    // While a corridor tool is drawing, NOTHING may select a proposal — the session opened with a
    // clean selection and every click belongs to the drawing. Any call here mid-drawing is a bug
    // (this is what painted the blue outline + panel over an active drawing session); refuse it
    // loudly and name the caller so the culprit path is visible in the console.
    if (window.roadDrawingMode === true) {
        console.error('[selectAndHighlightProposal] BLOCKED during active drawing session', {
            proposalIdOrHash,
            stack: new Error('selection during drawing').stack
        });
        return;
    }
    console.debug('[selectAndHighlightProposal] Called', {
        proposalIdOrHash,
        parcelId,
        shouldCenter,
        showDetails,
        keepHighlightsWithoutUi
    });

    const resolvedId = resolveProposalIdKey(proposalIdOrHash);
    console.debug('[selectAndHighlightProposal] Resolved ID:', resolvedId);

    const proposal = getProposalByIdOrHash(resolvedId);
    if (!proposal) {
        console.error('[selectAndHighlightProposal] Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }
    console.debug('[selectAndHighlightProposal] Proposal found', {
        proposalId: proposal.proposalId,
        proposalId: proposal.proposalId,
        title: proposal.title,
        parcelIdsCount: proposal.parentParcelIds?.length || 0
    });

    const proposalKey = getProposalKey(proposal) || resolvedId;
    proposalListState.selectedId = proposalKey;
    console.debug('[selectAndHighlightProposal] Set proposal key:', proposalKey);

    // Skip heavy restyle work if the same proposal is already active and we are not recentering
    const alreadySelected = window.currentlyHighlightedProposalId === proposalKey;
    if (alreadySelected && !shouldCenter) {
        window.currentlyHighlightedProposal = proposal;
        window.selectedParcelInProposal = parcelId;
        if (showDetails) {
            window.__openProposalDetailsCollapsed = true;
            showProposalInfo(proposal, parcelId);
        } else {
            hideProposalDetailsPanel();
        }
        updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parentParcelIds.length} parcels)`);
        // If the same proposal remains selected (common when clicking Apply/Remove inside the panel),
        // we still need to (re)apply overlays when its applied/unapplied state changes.
        // In particular, after "Remove from map" the proposal becomes unapplied and should show blue fill + dashed road geometry.
        try {
            const appliedState = (typeof isProposalApplied === 'function') ? isProposalApplied(proposal) : false;
            if (!appliedState) {
                if (typeof applyProposalHighlights === 'function') {
                    applyProposalHighlights();
                }
            } else {
                // For applied proposals, ensure preview overlays are not shown.
                if (typeof clearProposalPreviewLayers === 'function') {
                    clearProposalPreviewLayers();
                }
            }
        } catch (_) { }
        return;
    }

    // Clear any existing proposal highlights
    console.debug('[selectAndHighlightProposal] Clearing existing proposal highlights...');
    clearProposalHighlights();
    console.debug('[selectAndHighlightProposal] Cleared existing highlights');

    // Set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.currentlyHighlightedProposalId = proposalKey;
    window.selectedParcelInProposal = parcelId;
    console.debug('[selectAndHighlightProposal] Set window state variables');

    // Show proposal info immediately (no visual changes yet)
    if (showDetails) {
        console.debug('[selectAndHighlightProposal] Calling showProposalInfo...');
        window.__openProposalDetailsCollapsed = true;
        showProposalInfo(proposal, parcelId);
        console.debug('[selectAndHighlightProposal] showProposalInfo called');
    } else {
        console.debug('[selectAndHighlightProposal] showDetails is false, hiding proposal details panel');
        hideProposalDetailsPanel();
    }

    // Update status
    updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parentParcelIds.length} parcels)`);

    // If we will center the map, suppress overlay reapplication during movement
    if (shouldCenter && !isCameraMovementSuppressed()) {
        window.isApplyingProposalHighlights = true;
    }

    // Refresh base proposal styling across all parcels to reflect the newly selected proposal
    // This ensures the previous proposal regains hatched styling and the new one uses transparent stroke
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    if (shouldCenter) {
        // Center map first, then apply overlays when movement is complete
        const parcelIdsForCentering = (() => {
            // Prefer descendant parcels (not child proposal ids) — _getProposalDescendants mixes both.
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getAllDescendantParcelIds === 'function') {
                const descParcels = ProposalManager._getAllDescendantParcelIds(proposalKey);
                if (Array.isArray(descParcels) && descParcels.length > 0) return descParcels;
            }
            const childIds = (proposal.roadProposal && Array.isArray(proposal.roadProposal.childParcelIds))
                ? proposal.roadProposal.childParcelIds
                : (Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : []);
            if (childIds.length > 0) return childIds;
            return Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
        })();

        let bounds = resolveStandaloneProposalFocusBounds(proposal);
        if (!bounds) {
            const parcels = parcelIdsForCentering.map(id => multiParcelSelection.findParcelById(id))
                .filter(p => {
                    if (!p) return false;
                    if (typeof p.getBounds !== 'function') return false;
                    try {
                        const center = p.getBounds().getCenter();
                        if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                        if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                        return true;
                    } catch (e) {
                        return false;
                    }
                });
            if (parcels.length > 0) {
                const pb = L.latLngBounds();
                parcels.forEach(parcel => {
                    pb.extend(parcel.getBounds());
                });
                bounds = pb;
            }
        }

        if (bounds && bounds.isValid()) {
            // Suppress parcel fetching when showing proposal contours
            try { window.suppressCameraMoves = true; } catch (_) { }

            // Hide parcel layer if zoomed out too far (to prevent showing all parcels in memory)
            const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
            const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
            if (parcelLayer && wasParcelLayerVisible) {
                // Hide parcel layer temporarily - it will be restored if zoom is appropriate
                try { map.removeLayer(parcelLayer); } catch (_) { }
            }

            // Listen for moveend event to know when centering is complete
            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd); // Remove listener
                window.isApplyingProposalHighlights = false;

                // Check if zoom is appropriate for showing parcels
                const finalZoom = map.getZoom();
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : finalZoom >= 15; // Default threshold

                // Re-enable parcel fetching after centering is complete
                try { window.suppressCameraMoves = false; } catch (_) { }

                // Ensure parcel layer visibility matches zoom appropriateness
                if (parcelLayer) {
                    if (isZoomAppropriate && wasParcelLayerVisible) {
                        // Restore parcel layer only if zoom is appropriate and it was visible before
                        try {
                            if (!map.hasLayer(parcelLayer)) {
                                parcelLayer.addTo(map);
                            }
                        } catch (_) { }
                    } else {
                        // Remove parcel layer if zoom is not appropriate (even if it was added elsewhere)
                        try {
                            if (map.hasLayer(parcelLayer)) {
                                map.removeLayer(parcelLayer);
                            }
                        } catch (_) { }
                    }
                }

                // Apply overlays after centering is complete
                applyProposalHighlights();
            };

            map.on('moveend', onMoveEnd);

            // Calculate bounds and padding, accounting for proposal details panel on desktop
            const isDesktop = window.innerWidth > 768;
            let adjustedBounds = bounds;
            let fitOptions = { padding: [50, 50] }; // Default: [top/bottom, left/right]

            if (isDesktop && showDetails) {
                // If showing details, expand bounds to account for the proposal details panel on the right
                // Panel is 400px wide + 10px margin on each side = 420px total
                const panelWidth = 400;
                const panelMargin = 20;
                const totalPanelSpace = panelWidth + panelMargin;

                // Get map container to calculate expansion ratio
                const mapContainer = map.getContainer();
                const mapWidth = mapContainer ? mapContainer.clientWidth : window.innerWidth;

                // Calculate expansion needed: visible area is (mapWidth - panelSpace)
                // We need to expand bounds so they fit in this smaller visible area
                const visibleWidth = mapWidth - totalPanelSpace;
                const expansionRatio = mapWidth / visibleWidth;

                // Expand bounds using pad() - pad takes a ratio (0.1 = 10% expansion)
                // We need to expand by (expansionRatio - 1) to account for panel
                // Reduced multiplier (0.5 instead of 0.8) to zoom in more
                const padRatio = Math.max(0.1, (expansionRatio - 1) * 0.5);
                adjustedBounds = bounds.pad(padRatio);

                // Use standard padding
                fitOptions = { padding: [50, 50] };
            }

            // Start the map centering
            // Add maxZoom to prevent zooming out too far (where parcels shouldn't be visible)
            fitOptions.maxZoom = 19;
            map.fitBounds(adjustedBounds, fitOptions);
        } else {
            // No bounds from road definition or parcel layers
            window.isApplyingProposalHighlights = false;
            // Fallback: share/import path uses focusMapOnSharedProposal for bbox / geo / stored geometry;
            // list open previously skipped that, so large server-only downloads often never moved the camera.
            try {
                if (typeof focusMapOnSharedProposal === 'function') {
                    focusMapOnSharedProposal(proposal, null);
                }
            } catch (e) {
                console.warn('selectAndHighlightProposal: focusMapOnSharedProposal fallback failed', e);
            }
            applyProposalHighlights();
        }
    } else {
        // Not centering; apply overlays immediately
        applyProposalHighlights();
    }

    // Safety: if proposal UI isn't actually visible, clear any proposal-specific visuals
    try {
        if (!keepHighlightsWithoutUi && typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            clearProposalHighlights();
            clearProposalInfoHoverOverlay();
        }
    } catch (_) { }
}

async function removeProposalFromMap(proposalId, options = {}) {
    if (!proposalId || typeof ProposalManager === 'undefined' || typeof ProposalManager.unapplyProposal !== 'function') {
        return false;
    }

    console.log(`[removeProposalFromMap] Attempting to unapply proposal ${proposalId}...`);
    const proposalSnapshot = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
        ? proposalStorage.getProposal(proposalId)
        : null;
    if (proposalSnapshot) {
        console.log('[removeProposalFromMap] Current proposal status', {
            status: proposalSnapshot.status,
            roadStatus: proposalSnapshot.roadProposal?.status,
            childIds: Array.isArray(proposalSnapshot.childParcelIds) ? proposalSnapshot.childParcelIds.slice() : [],
            parentIds: Array.isArray(proposalSnapshot.parentParcelIds) ? proposalSnapshot.parentParcelIds.slice() : []
        });
    }

    const buttonId = `proposal-action-btn-${proposalId}`;
    const button = document.getElementById(buttonId);
    const original = button ? button.innerHTML : null;

    if (button) {
        button.disabled = true;
        button.style.opacity = '0.6';
        button.style.cursor = 'wait';
        button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${options.removingLabel || 'Removing…'}`;
    }

    try {
        // ProposalManager.unapplyProposal handles everything:
        // - Restores ancestor parcels, removes descendants
        // - Updates proposal status
        // - Refreshes UI indicators
        // - Re-highlights the proposal if it's currently highlighted (via selectAndHighlightProposal)
        const unapplied = await ProposalManager.unapplyProposal(proposalId);
        if (unapplied === false) {
            return false;
        }
        return true;
    } finally {
        if (button) {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const label = t
                ? t('panel.proposal.actions.remove', 'Remove from map')
                : 'Remove from map';
            button.disabled = false;
            button.style.opacity = '';
            button.style.cursor = '';
            button.className = 'btn btn-warning';
            button.innerHTML = original || `<i class="fas fa-eye-slash"></i> ${label}`;
        }
    }
}

function focusOnRemovedParcelLocation(parcelId, parcelItem) {
    if (!parcelId || typeof map === 'undefined' || !map) return;

    let geometry = null;
    let feature = null;

    // Try to get geometry from data attribute first
    if (parcelItem) {
        try {
            const geometryAttr = parcelItem.getAttribute('data-parcel-geometry');
            if (geometryAttr) {
                geometry = JSON.parse(geometryAttr);
            }
        } catch (_) { }
    }

    // If not found, try to get from parentFeatures in the current proposal
    if (!geometry && !feature) {
        try {
            const proposalDetailsContent = document.getElementById('proposal-details-content');
            if (proposalDetailsContent) {
                // Try to find proposal id from any element with data-proposal-id attribute
                const proposalIdElement = proposalDetailsContent.querySelector('[data-proposal-id]');
                if (proposalIdElement) {
                    const proposalId = proposalIdElement.getAttribute('data-proposal-id');
                    if (proposalId && typeof proposalStorage !== 'undefined') {
                        const proposal = proposalStorage.getProposal(proposalId);
                        if (proposal) {
                            // Fetch by ID - no parentFeatures cache
                            // Parent parcels are fetched by ID when needed
                            // Building proposals typically don't store parentFeatures, but we can still try PersistentStorage
                            // which is already handled below
                        }
                    }
                }
            }
        } catch (_) { }
    }

    // If still not found, try PersistentStorage
    if (!geometry && !feature) {
        try {
            const record = readPersistedParcelRecord(parcelId);
            if (record && record.geometry && record.properties) {
                geometry = record.geometry;
                const properties = record.properties;
                feature = ensureParcelIdOnFeature({
                    type: 'Feature',
                    properties,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [geometry]
                    }
                });
            }
        } catch (_) { }
    }

    // Create bounds from geometry and focus map
    if (feature && feature.geometry && typeof L !== 'undefined') {
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [50, 50] });
                    return;
                }
            }
        } catch (error) {
            console.warn('focusOnRemovedParcelLocation: failed to focus on removed parcel', parcelId, error);
        }
    } else if (geometry && Array.isArray(geometry) && geometry.length > 0 && typeof L !== 'undefined') {
        // Try to create bounds from raw geometry coordinates
        try {
            // Geometry is expected to be an array of [lng, lat] pairs
            const coords = geometry;
            if (coords.length > 0) {
                const latlngs = coords.map(coord => [coord[1], coord[0]]); // Convert [lng, lat] to [lat, lng]
                const polygon = L.polygon(latlngs);
                const bounds = polygon.getBounds();
                if (bounds && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [50, 50] });
                    return;
                }
            }
        } catch (error) {
            console.warn('focusOnRemovedParcelLocation: failed to focus on removed parcel from geometry', parcelId, error);
        }
    }
}

function collapseProposalGoalGroup() {
    const group = document.getElementById('proposalGoalGroup');
    if (!group) return;
    const hasSelection = !!group.querySelector('.proposal-type-button[data-proposal-tool].selected');
    group.classList.toggle('is-collapsed', hasSelection);
}

function expandProposalGoalGroup() {
    const group = document.getElementById('proposalGoalGroup');
    if (group) group.classList.remove('is-collapsed');
}

function centerOnProposal(proposalIdOrHash) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) return;

    // Use the first parcel as the selected parcel for highlighting
    const firstParcelId = proposal.parentParcelIds[0];
    if (!firstParcelId) return;

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, firstParcelId, true);
}

function rerenderProposalListIfOpen() {
    try {
        const modal = document.querySelector('.proposal-list-modal');
        if (modal && modal.style.display === 'block' && typeof renderProposalListModal === 'function') {
            renderProposalListModal();
        }
    } catch (_) { }
}

function enableShowProposalsMode() {
    // No-op retained for backward compatibility
}

function findParcelLayerById(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : parcelId;
    if (!normalized) return null;
    try {
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
            const found = multiParcelSelection.findParcelById(normalized);
            if (found) return found;
        }
    } catch (_) { }
    try {
        const layerGroup = window.parcelLayer;
        if (layerGroup && typeof layerGroup.eachLayer === 'function') {
            let match = null;
            layerGroup.eachLayer(layer => {
                if (match || !layer || !layer.feature || !layer.feature.properties) return;
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layerId && layerId.toString() === normalized) {
                    match = layer;
                }
            });
            if (match) return match;
        }
    } catch (error) {
        console.warn('findParcelLayerById failed', error);
    }
    return null;
}

async function focusMapThenMaybeEnter3D(focusFn) {
    const params = (() => {
        try { return new URLSearchParams(window.location.search || ''); } catch (_) { return null; }
    })();

    // Always perform the focus action (unless caller passes a non-function).
    const doFocus = () => {
        try { typeof focusFn === 'function' && focusFn(); } catch (_) { }
    };

    const wants3D = is3DModeRequestedFromUrl(params);
    if (!wants3D || url3DModeHandled) {
        doFocus();
        return false;
    }

    let beforeCenter = null;
    let beforeZoom = null;
    try {
        if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
            beforeCenter = map.getCenter();
        }
        if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') {
            beforeZoom = map.getZoom();
        }
    } catch (_) { }

    const settlePromise = (beforeCenter && Number.isFinite(beforeZoom))
        ? createLeafletViewSettlePromise(beforeCenter, beforeZoom)
        : Promise.resolve();

    doFocus();
    await settlePromise;

    const entered = tryEnterThreeMode({ fromUrl: true });
    if (entered) {
        url3DModeHandled = true;
    }
    return entered;
}

async function waitForParcelLayersReady(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) return;
    const cityId = options.cityId
        || (typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentCityId ? CityConfigManager.getCurrentCityId() : null);
    const scopedIds = ids.filter(id => isInCity(id, cityId));
    if (!scopedIds.length) {
        console.debug('[waitForParcelLayersReady] All parcel IDs filtered out for city', cityId);
        return;
    }
    if (scopedIds.length !== ids.length) {
        console.debug('[waitForParcelLayersReady] Filtering parcels to current city', {
            cityId,
            total: ids.length,
            filtered: scopedIds.length
        });
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 120;

    // Ensure parcelLayer exists and is attached before we start polling; shared route loads can run
    // before map-core wires the layer to the map.
    if (typeof ensureParcelLayerInitialized === 'function') {
        ensureParcelLayerInitialized();
    }
    if (typeof addParcelLayerToMapIfAppropriate === 'function') {
        addParcelLayerToMapIfAppropriate();
    }

    // Try to rehydrate missing parcels from storage BEFORE polling
    // This prevents stalls when parcels exist in storage but not in the layer index
    const missingFromIndex = scopedIds.filter(id => !isParcelLayerReady(id));
    if (missingFromIndex.length > 0) {
        const rehydrated = [];
        for (const id of missingFromIndex) {
            if (typeof readPersistedParcelRecord === 'function') {
                const record = readPersistedParcelRecord(id);
                if (record && record.geometry && record.properties) {
                    rehydrated.push({
                        type: 'Feature',
                        geometry: record.geometry,
                        properties: Object.assign({}, record.properties, { parcelId: id })
                    });
                }
            }
        }
        if (rehydrated.length > 0 && typeof ingestParcelFeatures === 'function') {
            try {
                await ingestParcelFeatures(rehydrated, { replaceExisting: false });
                console.debug(`[waitForParcelLayersReady] Rehydrated ${rehydrated.length} parcels from storage`);
            } catch (e) {
                console.warn('[waitForParcelLayersReady] Failed to ingest rehydrated parcels:', e);
            }
        }
    }

    const pending = new Set(scopedIds);
    const start = Date.now();
    while (pending.size && (Date.now() - start) < timeoutMs) {
        for (const id of Array.from(pending)) {
            if (isParcelLayerReady(id)) {
                pending.delete(id);
                continue;
            }
            // Parcel consumed by an earlier proposal — deliberately off-map, not actually missing.
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) {
                pending.delete(id);
            }
        }
        if (!pending.size) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    if (pending.size) {
        console.warn('waitForParcelLayersReady timed out for parcels', Array.from(pending));
    }
}

function isParcelLayerReady(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : '';
    if (!normalized) {
        return false;
    }
    if (typeof resolveParcelLayerById === 'function') {
        return !!resolveParcelLayerById(normalized);
    }
    try {
        if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
            return false;
        }
        let found = false;
        parcelLayer.eachLayer(layer => {
            if (found) {
                return;
            }
            const candidate = getParcelIdFromFeature(layer?.feature);
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalized) {
                found = true;
            }
        });
        return found;
    } catch (_) {
        return false;
    }
}

async function focusMapForSharedPayload(_payload) { return; }

function waitForMapIdle() {
    return new Promise(resolve => {
        if (typeof map === 'undefined' || !map || typeof map.once !== 'function') {
            resolve();
            return;
        }
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve();
            }
        }, 800);
        map.once('moveend', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve();
            }
        });
    });
}

function renderProposalLoadProgress() {
    if (!proposalLoadProgressBarEl || !proposalLoadProgressFillEl) return;
    const total = Number(proposalLoadProgressTotal) || 0;
    const done = Number(proposalLoadProgressDone) || 0;
    if (total <= 0) {
        proposalLoadProgressBarEl.style.display = 'none';
        proposalLoadProgressFillEl.style.width = '0%';
        if (proposalLoadProgressTextEl) proposalLoadProgressTextEl.textContent = '';
        return;
    }
    const ratio = Math.max(0, Math.min(1, done / total));
    proposalLoadProgressBarEl.style.display = 'block';
    proposalLoadProgressFillEl.style.width = `${(ratio * 100).toFixed(1)}%`;
    if (proposalLoadProgressTextEl) {
        proposalLoadProgressTextEl.textContent = `${done} / ${total}`;
    }
}

function scheduleHighlightRefresh(reason) {
    if (typeof window === 'undefined' || !window.currentlyHighlightedProposal) return;
    if (_proposalHighlightRefreshHandle != null) return;
    _proposalHighlightRefreshHandle = setTimeout(() => {
        _proposalHighlightRefreshHandle = null;
        try {
            if (!window.currentlyHighlightedProposal) return;
            if (window.isApplyingProposalHighlights) return;
            if (typeof reapplyProposalHighlights === 'function') {
                reapplyProposalHighlights();
            }
        } catch (e) {
            console.warn('[scheduleHighlightRefresh] repaint failed', { reason, error: e });
        }
    }, PROPOSAL_HIGHLIGHT_REFRESH_DEBOUNCE_MS);
}

function setupMultiParcelHighlightListeners() {
    if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
        map.on('moveend zoomend', function () {
            if (multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 0) {
                multiParcelSelection.reapplyMultiParcelHighlights();
            }
            scheduleHighlightRefresh('map-move');
        });
        return true;
    }
    return false;
}
