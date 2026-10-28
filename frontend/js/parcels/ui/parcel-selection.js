(function (global) {
    'use strict';

    const uiParcelPanel = (global.Parcels && global.Parcels.uiParcelPanel) ? global.Parcels.uiParcelPanel : (global.ParcelsUIParcelPanel || {});

    // A tool or editor that owns map clicks while it is open; a parcel click (and a box selection,
    // ui/box-select.js) then does nothing.
    function parcelClicksOwnedElsewhere() {
        if (global.roadDrawingMode) return true;
        if (global.measureMode) return true;
        // Pinpoint owns the click: it reports what is on the ground there ("At this spot"); a parcel
        // menu opening on top of that answer was noise.
        if (typeof global.pinpointToolIsActive === 'function' && global.pinpointToolIsActive()) return true;
        if (typeof global.isParcelDrawingModeActive === 'function' && global.isParcelDrawingModeActive()) return true;
        // An editing mode owns the map while open — clicks belong to it (placing furniture, moving
        // a node), never to the parcel underneath.
        if (global.__mapEditLock?.isHeld()) return true;
        if (typeof global.isStructureGeometryEditorActive === 'function' && global.isStructureGeometryEditorActive()) return true;
        return !!(global.AreaMonitorPaint && global.AreaMonitorPaint.isActive());
    }

    function onParcelClick(e) {
        if (parcelClicksOwnedElsewhere()) return;
        const targetLayer = e && e.target ? e.target : null;
        const parcelId = global.ParcelPresenter?.getIdForLayer?.(targetLayer) || null;
        if (!parcelId) return;
        if (global.ParcelEstimates?.consumeRemovalClick?.(parcelId)) {
            if (e) L.DomEvent.stopPropagation(e);
            return;
        }
        const feature = global.LiveParcelFabric?.get?.(parcelId) || null;
        const presentedLayer = global.ParcelPresenter?.getLayer?.(parcelId) || null;
        // A click from an old Leaflet layer can arrive while an atomic fabric commit replaces the
        // presentation. It has no authority to select geometry or identity after that commit.
        if (!feature || presentedLayer !== targetLayer) return;
        if (global.multiParcelSelection?.isActive) {
            if (e) L.DomEvent.stopPropagation(e);
            if (e?.latlng) global.ClickStack.handleClick(e.latlng);
            return;
        }
        const isRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;

        // Applied corridor parcels are both parcels and proposal surfaces. Remember the proposal now;
        // after the ordinary parcel-selection flow finishes, open its details compactly as well.
        const appliedRoadProposal = (typeof global.appliedRoadProposalForFeature === 'function')
            ? global.appliedRoadProposalForFeature(feature, id => (
                typeof global.getProposalByIdOrHash === 'function' ? global.getProposalByIdOrHash(id) : null
            ))
            : null;

        // Which applied proposal is standing on the clicked parcel, if any. Shared by the two modes
        // that answer a map click with a proposal rather than with parcel details.
        const proposalOnThisParcel = () => {
            if (appliedRoadProposal) return appliedRoadProposal;
            try {
                const parcelProposals = global.proposalStorage?.getProposalsForParcel?.(parcelId) || [];
                const found = parcelProposals.find(p => !p.roadProposal
                    && typeof global.isProposalApplied === 'function' && global.isProposalApplied(p));
                if (found) return found;
            } catch (_) { }
            return null;
        };

        // A surface picks designs on the map (js/map-pick.js: the share panel, the agreement editor):
        // the map is pan/zoom only, and a click on ordinary fabric stays inert. A click on an applied
        // DESIGN is handed to that surface. The design is the topmost one at the point, as a normal
        // click selects it (the drill's stack: a building standing on a layout's plot is the
        // building), else the one standing on this parcel.
        if (global.MapPick?.active()) {
            const top = (e && e.latlng && global.__drillUi ? global.__drillUi.stackAt(e.latlng) || [] : [])
                .find(entry => entry.kind === 'proposal');
            const picked = top ? top.proposal : proposalOnThisParcel();
            if (picked) {
                const pickedKey = (typeof global.getProposalKey === 'function' && global.getProposalKey(picked)) || picked.proposalId;
                global.MapPick.pick(pickedKey, { parcelId });
            }
            if (e) L.DomEvent.stopPropagation(e);
            return;
        }

        // Proposal browse mode (the proposals list is open): the map is inert to everything EXCEPT
        // proposals. A click on a parcel carrying an applied proposal selects that proposal (which
        // opens its details and closes the list — see selectAndHighlightProposal); a click on any
        // other parcel is a no-op. Pan/zoom stay live because only the click action is suppressed.
        if (global.proposalListBrowseMode) {
            const browseProposal = proposalOnThisParcel();
            if (browseProposal && typeof global.selectAndHighlightProposal === 'function') {
                const proposalKey = (typeof global.getProposalKey === 'function' && global.getProposalKey(browseProposal))
                    || browseProposal.proposalId;
                global.selectAndHighlightProposal(proposalKey, parcelId, true, true); // center + details; its tail closes the list
            }
            if (e) L.DomEvent.stopPropagation(e);
            return;
        }

        // Shift+click enters multi-select on the fly — same as pressing the Manual
        // selection button (updateUI syncs it). The currently viewed parcel is preserved as the
        // seed, and the shift-clicked parcel joins the selection below.
        const shiftHeld = !!(e && e.originalEvent && e.originalEvent.shiftKey);
        if (shiftHeld && typeof global.multiParcelSelection !== 'undefined'
            && !global.multiParcelSelection.isActive
            && typeof global.multiParcelSelection.toggle === 'function') {
            global.multiParcelSelection.toggle();
            if (global.multiParcelSelection.selectedParcels
                && global.multiParcelSelection.selectedParcels.has(parcelId)) {
                // Shift+click on the already-selected parcel: it is the seed — keep it selected
                // instead of letting toggleParcel immediately deselect it.
                L.DomEvent.stopPropagation(e);
                return;
            }
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive) {
            L.DomEvent.stopPropagation(e);
            if (e?.latlng) global.ClickStack.handleClick(e.latlng);
            return;
        }

        // An ordinary click: the click stack shows everything under the point (click-stack.md).
        // The parcel itself is selected when the stack expands its section (selectParcelFromStack).
        if (e) L.DomEvent.stopPropagation(e);
        if (e && e.latlng) global.ClickStack.handleClick(e.latlng);
        try { if (typeof global.updateBlockButtonStates === 'function') global.updateBlockButtonStates(); } catch (_) { }
    }

    // The click stack's parcel section expanded: select this live parcel (its map style, the
    // current parcel, its block) and open its info panel, which the stack then hosts.
    function selectParcelFromStack(parcelId) {
        const feature = global.LiveParcelFabric?.get?.(parcelId) || null;
        const targetLayer = global.ParcelPresenter?.getLayer?.(parcelId) || null;
        if (!feature || !targetLayer) return false;
        const isRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;
        if (global.splitLayer && global.map.hasLayer(global.splitLayer)) {
            global.map.removeLayer(global.splitLayer);
            global.splitLayer = null;
        }

        if (!isRoad && feature.properties.geometries) {
            const splitFeatures = feature.properties.geometries;
            if (splitFeatures && splitFeatures.length > 0) {
                const style = global.MapHighlight.style({ fillOpacity: 0.3 });
                global.splitLayer = L.layerGroup().addTo(global.map);
                splitFeatures.forEach(geom => {
                    const layer = L.geoJSON(geom, { style });
                    global.splitLayer.addLayer(layer);
                });
                const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
                if (typeof showParcelInfoPanel === 'function') {
                    showParcelInfoPanel(splitFeatures[0]);
                }
                return true;
            }
        }
        global.currentParcelCoordinates = feature.geometry.coordinates;
        const previousSelectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        const previousLayer = global.currentParcel && global.currentParcel.layer ? global.currentParcel.layer : null;
        if (previousLayer && previousSelectedId && previousSelectedId !== parcelId.toString()) {
            const keepHighlighted = typeof global.multiParcelSelection !== 'undefined' &&
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
        const isTrackSelected = feature.properties?.isTrack === true || Boolean(targetLayer?._trackStyle);
        if (isTrackSelected) {
            const styleFn = typeof global.getParcelStyle === 'function' ? global.getParcelStyle : global.getParcelBaseStyle;
            const trackStyle = styleFn ? styleFn(parcelId, targetLayer, { isTrack: true }) : (global.trackStyle || {});
            targetLayer.setStyle({ ...trackStyle, weight: 4 });
        } else {
            targetLayer.setStyle(global.selectedParcelStyle);
        }
        targetLayer.bringToFront();

        global.window.selectedParcelId = global.selectedParcelId;

        const blockName = typeof global.parcelBlockNameForId === 'function'
            ? global.parcelBlockNameForId(parcelId)
            : null;
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

        // Road status outlived the "is road" checkbox: it is still set by road auto-detection and by
        // applying a road proposal, and consumers read it off currentParcel.
        const currentIsRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(parcelId) : false;
        global.currentParcel = {
            id: parcelId,
            layer: targetLayer,
            isRoad: currentIsRoad
        };
        global.window.currentParcel = global.currentParcel;

        const showParcelInfoPanel = uiParcelPanel.showParcelInfoPanel || global.showParcelInfoPanel;
        showParcelInfoPanel(feature);

        try { if (typeof global.updateBlockButtonStates === 'function') global.updateBlockButtonStates(); } catch (_) { }
        return true;
    }

    // Escape stops Manual picking and keeps the selected land. Guard tools that bind their
    // own cancel action — never hijack it while typing, inside a modal, or while the road/measure
    // tools (which drive multi-select programmatically) are active.
    function handleMultiSelectEscape(event) {
        if (!event || event.key !== 'Escape' || event.defaultPrevented) return;
        if (typeof global.multiParcelSelection === 'undefined' || !global.multiParcelSelection.isActive) return;
        if (typeof global.isEditableTarget === 'function' && global.isEditableTarget(event.target)) return;
        if (typeof global.isAnyModalOpen === 'function' && global.isAnyModalOpen()) return;
        if (global.roadDrawingMode || global.measureMode) return;
        if (typeof global.multiParcelSelection.finish !== 'function') return;
        event.preventDefault();
        global.multiParcelSelection.finish();
    }
    global.document.addEventListener('keydown', handleMultiSelectEscape);

    global.onParcelClick = onParcelClick;
    global.ParcelsUISelection = Object.assign({}, global.ParcelsUISelection, { onParcelClick, parcelClicksOwnedElsewhere, selectParcelFromStack });
})(typeof window !== 'undefined' ? window : globalThis);
