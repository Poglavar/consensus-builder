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
        (descriptor?.parcelIds || draft?.fields?.selectedParcelIds || []).forEach(parcelId => {
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

// A hover usually answers more than one question at once: a proposal's own BODY — the building
// footprint, the corridor surface, the park polygon — is not the same shape as the PARCELS it
// stands on. Painting both in a single colour left a hovered proposal unreadable (a bunch of
// identical borders, with no way to tell which building was meant), so a caller passes one group
// per meaning. Groups are drawn in order, later ones on top; the hover layer is cleared exactly
// once, before the first group, so nothing a caller draws wipes what it drew a moment earlier.
function highlightFeatureGroupsForHover(featureGroups) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.hover || !groups.hoverLabels) return;

    const panes = window.__proposalHighlightPanes || null;

    groups.hover.clearLayers();
    groups.hoverLabels.clearLayers();

    if (!Array.isArray(featureGroups)) return;

    featureGroups.forEach(group => {
        if (!group || !Array.isArray(group.features)) return;
        const {
            features,
            color = '#FFB300',
            weight = 5,
            dashArray = '4 4',
            // Outlines are hollow unless a caller asks for a fill. A filled shape reads as "this
            // object" rather than "this boundary", which is what separates the hovered body from
            // the parcels around it.
            fillColor = null,
            fillOpacity = 0,
            showLabels = false,
            className = 'proposal-hover-outline proposal-hover-outline--animate'
        } = group;

        features.forEach(feature => {
            if (!feature || !feature.geometry) return;
            try {
                const outline = L.geoJSON(feature, {
                    pane: panes?.hover || undefined,
                    style: {
                        color,
                        weight,
                        fillColor: fillColor || color,
                        fillOpacity,
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
    });

    if (groups.hover.bringToFront) groups.hover.bringToFront();
    if (groups.hoverLabels.bringToFront) groups.hoverLabels.bringToFront();
}

// Single-meaning hover: one set of features, one style. Kept as the common case on top of the
// grouped painter.
function highlightFeaturesForHover(features, options = {}) {
    highlightFeatureGroupsForHover([{ ...options, features }]);
}

function getParcelFeaturesForHighlight(parcelId, proposalContext = null, options = {}) {
    const { skipRecovery = false } = options;
    const proposal = proposalContext && proposalContext.proposal ? proposalContext.proposal : proposalContext;
    if (!parcelId) return [];

    try {
        // Proposal highlights are projections of the committed live fabric. A durable cadastral
        // anchor may expand to several live pieces, so that expansion is explicit and set-valued.
        if (typeof window !== 'undefined' && window.ParcelPresenter && window.LiveParcelFabric) {
            let bounds = null;
            try {
                bounds = window.map?.getBounds?.() || null;
                if (bounds && typeof bounds.pad === 'function') bounds = bounds.pad(0.1);
            } catch (_) { bounds = null; }
            const layers = window.ParcelPresenter.resolveLiveLayers([String(parcelId)], {
                bounds,
                includeCorridors: options.includeCorridors === true
            }) || [];
            return layers
                .map(layer => window.LiveParcelFabric.get(window.ParcelPresenter.getIdForLayer(layer)))
                .filter(feature => feature?.geometry);
        }
        void skipRecovery;
        void proposal;
    } catch (error) {
        console.warn('getParcelFeatureForHighlight: unable to locate parcel', parcelId, error);
    }
    return [];
}

function getParcelFeatureForHighlight(parcelId, proposalContext = null, options = {}) {
    return getParcelFeaturesForHighlight(parcelId, proposalContext, options)[0] || null;
}

function collectProposalHighlightFeatures(proposal, { includeParents = false, includeChildren = true } = {}) {
    const features = [];
    const seenParcelIds = new Set();
    if (!proposal) return features;

    const appendResolved = parcelId => {
        getParcelFeaturesForHighlight(parcelId, proposal).forEach(feature => {
            if (!feature || !feature.geometry) return;
            const props = feature.properties || {};
            const featureId = (typeof getParcelIdFromFeature === 'function')
                ? getParcelIdFromFeature(feature)
                : (props.parcelId ?? props.parcel_id ?? props.id ?? null);
            const key = featureId !== undefined && featureId !== null ? String(featureId) : null;
            if (key && seenParcelIds.has(key)) return;
            if (key) seenParcelIds.add(key);
            features.push(feature);
        });
    };

    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadProposal;

    if (isRoadProposal && includeChildren !== false) {
        const proposalId = proposal.proposalId ?? proposal.id;
        const childIds = (proposalId !== undefined && proposalId !== null
            && typeof ProposalManager !== 'undefined'
            && typeof ProposalManager._getProposalChildParcels === 'function')
            ? ProposalManager._getProposalChildParcels(String(proposalId))
            : [];
        const uniqueChildIds = Array.from(new Set(childIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueChildIds.forEach(childId => {
            appendResolved(childId);
        });
    }

    const cadastreParcelIds = Array.isArray(proposal.cadastreParcelIds)
        ? proposal.cadastreParcelIds
        : [];
    if (includeParents && proposal.roadProposal) {
        cadastreParcelIds.forEach(appendResolved);
    }

    if ((!isRoadProposal || features.length === 0) && cadastreParcelIds.length) {
        cadastreParcelIds.forEach(appendResolved);
    }

    return features;
}

function highlightParcelHover(parcelId, options = {}) {
    const proposal = options.proposal || null;
    const features = getParcelFeaturesForHighlight(parcelId, proposal, options);
    if (features.length) {
        highlightFeaturesForHover(features, {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            // Labels are opt-in per surface: panel-driven hovers pass true (the label answers
            // "which shape lit up"); the map-surface hover deliberately does not.
            showLabels: false,
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
            // Apply now (the SVG path exists synchronously after addTo) AND on the next frame so the
            // animation restarts reliably. requestAnimationFrame alone is throttled to a standstill
            // when the tab isn't actively rendering, which left the blink never applied.
            applyBlinkToLayerGroup(layer, blinkClass);
            try { requestAnimationFrame(() => applyBlinkToLayerGroup(layer, blinkClass)); } catch (_) { }
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
        if (window.LiveParcelFabric?.get?.(idStr)) {
            layer = window.ParcelPresenter?.getLayer?.(idStr) || null;
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
    // Building geometry is part of the selection: without it, selecting a building proposal
    // highlighted only its parcels, and on ground shared by several buildings there was no way
    // to see WHICH building was selected.
    const { primaryFeatures } = collectProposalFeatureSets(proposal, { includeBuildingGeometry: true });
    const _tCollect1 = performance.now();

    // A corridor proposal (road or track — the same object) styles its geometry differently from a
    // parcel-shaped one. There is no track branch: rails come from the rail lanes of its cross-section,
    // drawn by the corridor renderer, not from the kind of proposal this is.
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;

    // Applied proposals should always be visible at all zoom levels, even when parcels are not shown
    // This allows users to see applied proposals regardless of zoom level

    // Does the proposal currently STAND on the map? Only a road used to answer this question:
    // everything else kept its solid, filled, applied-looking highlight after being unapplied, so
    // "Remove from map" appeared to do nothing — the shape came back the instant the unapply
    // re-selected the record, and only went away on reload, when nothing is selected any more.
    // Off the map now reads the same for every type: dashed and unfilled, the language a parked
    // road already spoke.
    const standsOnMap = isApplied(proposal);

    // Only geometry-less parcel operations use a live parcel as their selection shape. Proposals
    // with a body are drawn from that body below; their cadastral source parcels are provenance,
    // not part of the visual selection.
    const parcelStyle = {
        color: '#2563EB',
        fillColor: '#2563EB',
        weight: 3,
        opacity: 0.9,
        dashArray: standsOnMap ? null : '10 5',
        fillOpacity: standsOnMap ? 0.2 : 0,
        className: 'proposal-parcel-outline'
    };
    const activeParcelIds = new Set();

    if (isRoadProposal && standsOnMap) {
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
        // Anything not standing on the map — a parked road, an unapplied building/park/square/lake,
        // a reparcellization taken off — is drawn as a proposal: dashed lines and no fill. Only a
        // proposal that IS on the map gets the solid, filled primary outline.
        const primaryStyle = (isRoadProposal || !standsOnMap) ? {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: '10 5',
            fillOpacity: 0,
            className: isRoadProposal ? 'proposal-road-outline' : 'proposal-primary-outline'
        } : {
            color: '#2563EB',
            weight: 4,
            opacity: 1,
            dashArray: null,
            fillOpacity: 0.2,
            className: 'proposal-primary-outline'
        };

        const parcelIdSet = collectProposalSelectionParcelIds(proposal, primaryFeatures);
        forEachProposalParcelInViewport(parcelIdSet, (layer, liveParcelId) => {
            proposalHighlightStyleOverride.apply(layer, parcelStyle);
            if (liveParcelId) activeParcelIds.add(String(liveParcelId));
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
        activeIds: activeParcelIds,
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

}

function reapplyProposalHighlights() {
    if (window.currentlyHighlightedProposal && !window.isApplyingProposalHighlights) {
        // Apply highlights immediately - no delay needed with proper event handling
        applyProposalHighlights();
    }
}

// Close only the secondary parcel panel opened for a proposal-owned live feature. This deliberately
// does not call hideParcelInfoPanel(): that general dismissal also clears the proposal selection,
// while an apply/unapply refresh must keep the proposal card and its highlight selected.
function clearProposalOwnParcelInfo(expectedParcelIds = null) {
    const trackedId = window.__proposalOwnParcelPanelId != null
        ? String(window.__proposalOwnParcelPanelId)
        : null;
    if (!trackedId) return false;

    if (expectedParcelIds != null) {
        const expected = new Set(Array.from(expectedParcelIds || []).map(String));
        if (!expected.has(trackedId)) return false;
    }

    window.__proposalOwnParcelPanelId = null;
    window.__openParcelInfoCollapsed = false;

    const selectedId = window.selectedParcelId != null ? String(window.selectedParcelId) : null;
    const currentId = window.currentParcel?.id != null ? String(window.currentParcel.id) : null;
    // A direct map click may have reused the same panel for a different parcel since the proposal
    // opened it. In that case the direct selection owns the panel now, so only forget our marker.
    if ((selectedId && selectedId !== trackedId) || (currentId && currentId !== trackedId)) {
        return false;
    }

    if (selectedId === trackedId) window.selectedParcelId = null;
    if (currentId === trackedId) {
        window.currentParcel = null;
        window.currentParcelCoordinates = null;
    }
    document.getElementById('parcel-info-panel')?.classList.remove('visible');
    try { window.__drillUi?.hideIfNothingSelected?.(); } catch (_) { }
    return true;
}

// A proposal that produces exactly one live parcel shows that parcel's info alongside the proposal
// card, collapsed to its header so the proposal stays the primary surface. Proposals that currently
// produce no parcel and those that create many (reparcellization) open nothing here.
function showOwnParcelInfoForProposal(proposal) {
    const resolver = window.ProposalOwnParcel;
    const showPanel = window.Parcels?.uiParcelPanel?.showParcelInfoPanel || window.showParcelInfoPanel;
    if (!resolver || typeof showPanel !== 'function') {
        clearProposalOwnParcelInfo();
        return;
    }
    const fabric = window.LiveParcelFabric;
    if (!fabric || typeof fabric.get !== 'function' || typeof fabric.producedBy !== 'function') {
        clearProposalOwnParcelInfo();
        return;
    }
    const lookup = id => fabric.get(String(id));
    let ownId = null;
    try { ownId = resolver.ownParcelId(proposal, fabric.producedBy(proposal.proposalId)); } catch (error) {
        console.error('[selectAndHighlightProposal] own-parcel lookup failed', error);
        clearProposalOwnParcelInfo();
        return;
    }
    const feature = ownId ? lookup(ownId) : null;
    if (!feature) {
        clearProposalOwnParcelInfo();
        return;
    }
    clearProposalOwnParcelInfo();
    window.__openParcelInfoCollapsed = true;
    try {
        showPanel(feature);
        window.__proposalOwnParcelPanelId = String(ownId);
    } catch (error) {
        console.error('[selectAndHighlightProposal] could not open the proposal own parcel', ownId, error);
        window.__openParcelInfoCollapsed = false;
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
    // Share-plan mode: no surface may select a proposal or open its details — the panel's own
    // row hover/click highlight is the only proposal interaction while the plan is being composed.
    if (window.sharePlanMode) return;

    const resolvedId = resolveProposalIdKey(proposalIdOrHash);

    const proposal = getProposalByIdOrHash(resolvedId);
    if (!proposal) {
        console.error('[selectAndHighlightProposal] Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    const proposalKey = getProposalKey(proposal) || resolvedId;
    proposalListState.selectedId = proposalKey;

    // Skip heavy restyle work if the same proposal is already active and we are not recentering
    const alreadySelected = window.currentlyHighlightedProposalId === proposalKey;
    if (alreadySelected && !shouldCenter) {
        window.currentlyHighlightedProposal = proposal;
        window.selectedParcelInProposal = parcelId;
        if (showDetails) {
            window.__openProposalDetailsCollapsed = true;
            showProposalInfo(proposal, parcelId);
            showOwnParcelInfoForProposal(proposal);
        } else {
            hideProposalDetailsPanel();
        }
        updateStatus(`Selected proposal "${proposal.title}" (contains ${(proposal.cadastreParcelIds || []).length} parcels)`);
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
    clearProposalHighlights();

    // Set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.currentlyHighlightedProposalId = proposalKey;
    window.selectedParcelInProposal = parcelId;

    // Show proposal info immediately (no visual changes yet)
    if (showDetails) {
        window.__openProposalDetailsCollapsed = true;
        showProposalInfo(proposal, parcelId);
        showOwnParcelInfoForProposal(proposal);
    } else {
        hideProposalDetailsPanel();
    }

    // Update status
    updateStatus(`Selected proposal "${proposal.title}" (contains ${(proposal.cadastreParcelIds || []).length} parcels)`);

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
            // Use only this formation's current derived parcels; records have no proposal family.
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalChildParcels === 'function') {
                const children = ProposalManager._getProposalChildParcels(proposalKey);
                if (Array.isArray(children) && children.length > 0) return children;
            }
            return Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
        })();

        let bounds = resolveStandaloneProposalFocusBounds(proposal);
        if (!bounds) {
            const parcels = (window.ParcelPresenter?.resolveLiveLayers?.(parcelIdsForCentering, {
                includeCorridors: true
            }) || [])
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
            // Frame the proposal in the VISIBLE map, clear of whichever proposal panel is covering it
            // (the details panel that opens on select, or the list panel when browsing). Asymmetric
            // padding shifts the fit into the visible area, instead of the old symmetric bounds.pad()
            // which centered on the FULL map and left the proposal partly behind the right panel.
            const { paddingTopLeft, paddingBottomRight } = (typeof getProposalPanelFitPadding === 'function')
                ? getProposalPanelFitPadding(50)
                : { paddingTopLeft: [50, 50], paddingBottomRight: [50, 50] };
            // animate:false — instant framing, and it avoids requestAnimationFrame (throttled to a
            // standstill when the tab isn't actively rendering, which silently no-ops an animated fit).
            try {
                window.suppressCameraMoves = true;
                map.fitBounds(bounds, { paddingTopLeft, paddingBottomRight, maxZoom: 19, animate: false });
            } finally {
                window.suppressCameraMoves = false;
                window.isApplyingProposalHighlights = false;
            }
            applyProposalHighlights();
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

    // Proposal browse mode: picking a proposal from any of the clickable map surfaces (a parcel that
    // carries one, a corridor hit target, a building, a station) ends the browse — its details are
    // now open, so the list has done its browsing job and closes. Highlights are kept so the
    // just-selected proposal stays visible on the map.
    //
    // Not passing selectPreviewed is what keeps closeProposalList from selecting the previewed row
    // on top of this one: a selection is already in progress here, and it is this one that wins.
    try {
        if (window.proposalListBrowseMode && showDetails && typeof closeProposalList === 'function') {
            closeProposalList({ clearHighlights: false });
        }
    } catch (_) { }
}

function reconcileProposalMapActionButton(proposalId, fallbackHtml = '') {
    const buttonId = `proposal-action-btn-${proposalId}`;
    const button = document.getElementById(buttonId);
    if (!button) return null;

    const proposal = (typeof getProposalByIdOrHash === 'function')
        ? getProposalByIdOrHash(proposalId)
        : ((typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
            ? proposalStorage.getProposal(proposalId)
            : null);
    if (!proposal) {
        if (fallbackHtml) button.innerHTML = fallbackHtml;
        button.disabled = false;
        button.style.opacity = '';
        button.style.cursor = '';
        return button;
    }

    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const applied = (typeof isProposalApplied === 'function')
        ? isProposalApplied(proposal)
        : (typeof isApplied === 'function' ? isApplied(proposal) : proposal.applied === true);
    return ProposalMapAction.renderButton(button, proposalId, applied, t);
}

function proposalUnapplyPhaseLabel(event, t) {
    const phase = String(event?.phase || '');
    if (phase === 'unapply-start') {
        return t ? t('panel.proposal.actions.unapplying', 'Unapplying…') : 'Unapplying…';
    }
    if (phase.startsWith('ground-')) {
        return t
            ? t('panel.proposal.actions.restoringGround', 'Restoring local terrain…')
            : 'Restoring local terrain…';
    }
    if (phase === 'unapply-remove-output') {
        return t ? t('panel.proposal.actions.unapplying', 'Unapplying…') : 'Unapplying…';
    }
    if (phase === 'unapply-restore-ground' || phase.startsWith('fabric-')) {
        return t
            ? t('panel.proposal.actions.restoringGround', 'Restoring local terrain…')
            : 'Restoring local terrain…';
    }
    if (phase === 'save') {
        return t ? t('panel.proposal.actions.saving', 'Saving…') : 'Saving…';
    }
    return null;
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
            lifecycleStatus: getLifecycleStatus(proposalSnapshot),
            applied: isApplied(proposalSnapshot),
            materializedParcelIds: (typeof ProposalManager._getProposalChildParcels === 'function')
                ? ProposalManager._getProposalChildParcels(proposalId)
                : [],
            cadastreParcelIds: Array.isArray(proposalSnapshot.cadastreParcelIds)
                ? proposalSnapshot.cadastreParcelIds.slice()
                : []
        });
    }

    const buttonId = `proposal-action-btn-${proposalId}`;
    const button = document.getElementById(buttonId);
    const original = button ? button.innerHTML : null;
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const proposalLabel = proposalSnapshot?.title || proposalSnapshot?.name || String(proposalId);
    let succeeded = false;

    if (button) {
        button.disabled = true;
        button.style.opacity = '0.6';
        button.style.cursor = 'wait';
        const initialLabel = options.removingLabel
            || (t ? t('panel.proposal.actions.unapplying', 'Unapplying…') : 'Unapplying…');
        button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${initialLabel}`;
        // …and let the browser DRAW it. The spinner has been set here all along and was never seen:
        // unapply awaits a chain whose promises are usually already settled, so everything below runs
        // in microtasks, which complete before any frame is painted. Without a macrotask boundary the
        // button goes from "Stash" to "Stash" with a frozen second in between.
        if (typeof window !== 'undefined' && typeof window.yieldToBrowser === 'function') {
            await window.yieldToBrowser();
        }
    }

    try {
        // Unapply commits authored state first; the local fabric system then restores this record's
        // flat cadastral scope without making map geometry a precondition for the state change.
        const unapplied = await ProposalManager.unapplyProposal(proposalId, {
            onProgress: event => {
                const phaseLabel = proposalUnapplyPhaseLabel(event, t);
                if (!phaseLabel) return;
                const liveButton = document.getElementById(buttonId);
                if (liveButton) {
                    liveButton.disabled = true;
                    liveButton.style.opacity = '0.6';
                    liveButton.style.cursor = 'wait';
                    liveButton.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${phaseLabel}`;
                }
                try { if (typeof updateStatus === 'function') updateStatus(`${proposalLabel} — ${phaseLabel}`); } catch (_) { }
            }
        });
        if (unapplied === false) {
            return false;
        }
        succeeded = true;
        return true;
    } finally {
        // The manager may have re-rendered the details panel while the await was in flight, so the
        // `button` captured above may now be detached. Resolve it again and render from the record's
        // authoritative applied state. Restoring the old "Unapply" HTML after success made the next
        // action look like a second unapply even though the proposal was already parked.
        reconcileProposalMapActionButton(proposalId, original || '');
        if (succeeded) {
            const message = t
                ? t('panel.proposal.actions.unappliedStatus', 'Unapplied “{{name}}”. The proposal remains in your proposals list.', { name: proposalLabel })
                : `Unapplied “${proposalLabel}”. The proposal remains in your proposals list.`;
            try { if (typeof updateStatus === 'function') updateStatus(message, { proposalId: String(proposalId) }); } catch (_) { }
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
                if (geometry?.type && Array.isArray(geometry.coordinates)) {
                    feature = {
                        type: 'Feature',
                        properties: { parcelId: String(parcelId) },
                        geometry
                    };
                }
            }
        } catch (_) { }
    }

    // A removed cadastral row can be located from the immutable repository. Generated identities
    // have no durable geometry and must carry it in the row's data attribute if they need focus.
    if (!geometry && !feature) {
        try {
            const stored = window.CadastralParcelRepository?.get?.(parcelId) || null;
            if (stored?.geometry) {
                feature = stored;
                geometry = stored.geometry;
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
    const firstParcelId = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds[0] : null;
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

function findParcelLayerById(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : parcelId;
    if (!normalized) return null;
    if (!window.LiveParcelFabric?.get?.(normalized)) return null;
    return window.ParcelPresenter?.getLayer?.(normalized) || null;
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

    // A proposal-link load owns its own 3D entry (passing the link's proposalIds as camera
    // focus). Entering here — mid-apply, with no focus ids — won the race, marked the URL as
    // handled, and the route's focused entry was skipped: the camera framed EVERY applied
    // proposal instead of the link's. Same rule handleStandalone3DModeFromUrl already applies.
    const hasProposalParams = params && (params.has('proposalShare') || params.has('shared')
        || window.location.pathname.startsWith('/proposals/')
        || window.location.pathname.startsWith('/plans/'));
    if (hasProposalParams) {
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

    const pending = new Set(scopedIds);
    const start = Date.now();
    while (pending.size && (Date.now() - start) < timeoutMs) {
        for (const id of Array.from(pending)) {
            if (isParcelLayerReady(id)) {
                pending.delete(id);
                continue;
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
    return !!window.ParcelPresenter?.getLayer?.(normalized);
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
            scheduleHighlightRefresh('map-move');
        });
        return true;
    }
    return false;
}
