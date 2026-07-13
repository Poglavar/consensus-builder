// proposals/dialog-create.js — extracted from proposals.js (behavior-preserving relocation).

function clearProposalPreviewLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) groups.preview.clearLayers();
    if (groups.border) groups.border.clearLayers();
    if (groups.buildingPreview) groups.buildingPreview.clearLayers();
}

function renderProposalBuildingPreview(proposal) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.buildingPreview) return;
    groups.buildingPreview.clearLayers();

    const panes = window.__proposalHighlightPanes || null;

    if (!proposal || !collectProposalBuildingFeatures) return;
    const buildingFeatures = collectProposalBuildingFeatures(proposal);
    if (!buildingFeatures.length) return;

    buildingFeatures.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            L.geoJSON(feature, {
                pane: panes?.highlight || undefined,
                style: {
                    color: '#6c63ff',
                    weight: 2,
                    dashArray: '6 4',
                    fillOpacity: 0
                },
                interactive: false
            }).addTo(groups.buildingPreview);
        } catch (error) {
            console.warn('renderProposalBuildingPreview failed for feature', error);
        }
    });

    if (groups.buildingPreview.bringToFront) groups.buildingPreview.bringToFront();
}

function renderPreviewOverlay(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.preview) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    groups.preview.clearLayers();

    if (!proposal) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    const { parcelFeatures, primaryFeatures } = collectProposalFeatureSets(proposal);
    const hasPrimary = primaryFeatures.length > 0;

    // Check if this is a corridor proposal, to style its geometry differently. Track-ness is a fact
    // about the cross-section (does it carry rail lanes), not a flag on the proposal.
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;
    const corridorDefinition = proposal?.roadProposal?.definition || proposal?.definition;
    const isTrack = isRoadProposal && typeof corridorIsTrack === 'function' && corridorIsTrack(corridorDefinition);

    // CRITICAL: Check zoom level before rendering parcel features
    // When zoomed out (below parcel display threshold), we should NOT render individual parcel outlines
    const isZoomWithinRange = isTrack
        ? true // Always show parcel outlines for tracks so borders are visible in preview
        : (typeof window !== 'undefined' && typeof window.isZoomWithinParcelRange === 'function')
            ? window.isZoomWithinParcelRange()
            : (typeof map !== 'undefined' && map ? map.getZoom() >= 17 : true);

    const parcelStyle = {
        color: '#2563EB',
        weight: 3,
        opacity: 1,
        dashArray: '4 6',
        fillOpacity: 0,
        className: 'proposal-preview-parcel'
    };

    // For road proposals, style road geometry with dashed lines and no fill
    // For other proposals, use the standard primary style
    const primaryStyle = isTrack ? {
        color: '#FF8A00',
        weight: 4,
        opacity: 0.95,
        dashArray: '8 6',
        fillOpacity: 0,
        className: 'proposal-preview-track-outline'
    } : isRoadProposal ? {
        color: '#2563EB',
        weight: 4,
        opacity: 0.95,
        dashArray: '10 5',
        fillOpacity: 0,
        className: 'proposal-preview-road-outline'
    } : {
        color: '#8E24AA',
        weight: 4,
        opacity: 0.95,
        dashArray: '2 8',
        fillOpacity: 0.25,
        className: 'proposal-preview-outline'
    };

    // Only render parcel outlines if zoom is within parcel display range
    if (isZoomWithinRange) {
        parcelFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, parcelStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    // For road proposals, always show the road geometry (primaryFeatures) even when zoomed out
    // For non-road proposals without primary features, show parcel outlines if zoom is appropriate
    const featuresToDraw = hasPrimary ? primaryFeatures : (isZoomWithinRange ? parcelFeatures : []);

    if (isRoadProposal || isZoomWithinRange) {
        featuresToDraw.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, primaryStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    // A previewed corridor lays one pair of rails per RAIL LANE of its cross-section — the same rule
    // the map itself uses, so a proposed tram street shows its rails here too, not just a track.
    if (isRoadProposal && typeof renderCorridorRails === 'function') {
        const profile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(corridorDefinition) : null;
        const centerlines = (typeof corridorCenterlineOf === 'function') ? corridorCenterlineOf(corridorDefinition) : [];
        if (profile && centerlines.length) {
            renderCorridorRails(centerlines, profile, groups.preview, {
                railColor: '#FF8A00',
                sleeperColor: '#FFC266',
                pane: groups.preview?.__paneName || (window.__proposalHighlightPanes && window.__proposalHighlightPanes.preview) || undefined
            });
        }
    }

    if (groups.preview.bringToFront) {
        groups.preview.bringToFront();
    }

    return { parcelFeatures, primaryFeatures };
}

function clearProposalPreview() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) {
        groups.preview.clearLayers();
    }
    currentProposalPreviewId = null;
}

function previewProposalOnMap(proposalIdOrHash, { center = true, blink = true } = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return;
    }

    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        return;
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);
    currentProposalPreviewId = proposalKey;

    const { parcelFeatures, primaryFeatures } = renderPreviewOverlay(proposal, { blink });

    if (!center || typeof map === 'undefined' || !map) {
        return;
    }

    const featuresForBounds = primaryFeatures.length > 0 ? primaryFeatures : parcelFeatures;
    let bounds = computeBoundsFromFeatures(featuresForBounds);

    if (!bounds && Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0) {
        const calculated = calculateProposalBounds(proposal.parentParcelIds, { proposal });
        if (calculated && calculated.north !== undefined && calculated.west !== undefined) {
            try {
                bounds = L.latLngBounds(
                    [calculated.south, calculated.west],
                    [calculated.north, calculated.east]
                );
            } catch (_) {
                bounds = null;
            }
        }
    }

    if (bounds && bounds.isValid && bounds.isValid()) {
        // Suppress parcel fetching when showing proposal contours
        try { window.suppressCameraMoves = true; } catch (_) { }

        // Hide parcel layer if zoomed out too far (to prevent showing all parcels in memory)
        const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
        const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
        if (parcelLayer && wasParcelLayerVisible) {
            try { map.removeLayer(parcelLayer); } catch (_) { }
        }

        map.fitBounds(bounds.pad(0.08), { maxZoom: 19 });

        // Re-enable after map movement completes
        const onMoveEnd = () => {
            map.off('moveend', onMoveEnd);
            try { window.suppressCameraMoves = false; } catch (_) { }

            // Restore parcel layer only if zoom is appropriate
            const finalZoom = map.getZoom();
            const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                ? isZoomWithinParcelRange()
                : finalZoom >= 15; // Default threshold

            if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                try {
                    if (!map.hasLayer(parcelLayer)) {
                        parcelLayer.addTo(map);
                    }
                } catch (_) { }
            }
        };
        map.on('moveend', onMoveEnd);
    } else if (proposal.bounds && proposal.bounds.center) {
        const { lat, lng } = proposal.bounds.center;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Suppress parcel fetching when showing proposal contours
            try { window.suppressCameraMoves = true; } catch (_) { }

            // Hide parcel layer if zoomed out too far
            const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
            const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
            if (parcelLayer && wasParcelLayerVisible) {
                try { map.removeLayer(parcelLayer); } catch (_) { }
            }

            map.setView([lat, lng], map.getZoom());

            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd);
                try { window.suppressCameraMoves = false; } catch (_) { }

                // Restore parcel layer only if zoom is appropriate
                const finalZoom = map.getZoom();
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : finalZoom >= 15;

                if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                    try {
                        if (!map.hasLayer(parcelLayer)) {
                            parcelLayer.addTo(map);
                        }
                    } catch (_) { }
                }
            };
            map.on('moveend', onMoveEnd);
        }
    }
}

function setProposalModalDimmed(dimmed) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    if (dimmed) {
        modal.classList.add('dimmed-behind-overlay');
    } else {
        modal.classList.remove('dimmed-behind-overlay');
    }
}

function openConstrainedCorridorModal() {
    const selection = (typeof getCurrentParcelSelectionContext === 'function')
        ? getCurrentParcelSelectionContext()
        : { layers: [], ids: [] };
    const parcelIds = Array.isArray(selection.ids) ? selection.ids.filter(Boolean) : [];
    const parcels = Array.isArray(selection.layers) ? selection.layers.filter(Boolean) : [];
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const tCorridor = getConstrainedCorridorTranslator(t);

    if (!parcels.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusSelectParcels', 'Select parcels before opening the constrained corridor tool.'));
        }
        return;
    }

    const contiguity = (typeof areParcelsContiguous === 'function')
        ? areParcelsContiguous(parcels)
        : { contiguous: true };

    if (!contiguity.contiguous) {
        const message = (typeof t === 'function')
            ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
            : tCorridor('statusContiguity', 'Parcels must be contiguous to draw a constrained corridor.');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('parcels_not_contiguous', message);
        } else if (typeof alert === 'function') {
            alert(message);
        }
        return;
    }

    const superGeometry = (typeof buildGeometryFromParcels === 'function')
        ? buildGeometryFromParcels(parcels)
        : null;

    if (!superGeometry) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusBoundaryFailed', 'Could not build a corridor boundary from the selected parcels.'));
        }
        return;
    }

    const superFeature = { type: 'Feature', properties: {}, geometry: superGeometry };
    const superTurfFeature = (typeof turf !== 'undefined' && turf.feature)
        ? turf.feature(superGeometry)
        : superFeature;

    // Clone parcel features to avoid mutating the live map layers
    const parcelFeatures = parcels
        .map(layer => {
            const feature = layer?.feature;
            if (!feature || !feature.geometry) return null;
            try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
        })
        .filter(Boolean);

    if (!parcelFeatures.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusGeometryFailed', 'Could not resolve parcel geometries for the constrained corridor modal.'));
        }
        return;
    }

    // Remove any existing modal before opening a new one
    if (constrainedCorridorState && constrainedCorridorState.close) {
        constrainedCorridorState.close();
    }

    const overlay = document.createElement('div');
    overlay.className = 'constrained-corridor-overlay';

    const mapId = `constrained-corridor-map-${Date.now()}`;
    const corridorText = {
        ariaLabel: tCorridor('ariaLabel', 'Constrained corridor'),
        title: tCorridor('title', 'Constrained corridor'),
        closeLabel: tCorridor('closeLabel', 'Close'),
        mapAriaLabel: tCorridor('mapAriaLabel', 'Constrained corridor map'),
        modeAriaLabel: tCorridor('modeAriaLabel', 'Corridor mode'),
        modeFull: tCorridor('modeFull', 'Full parcel'),
        modeDraw: tCorridor('modeDraw', 'Draw'),
        typeAriaLabel: tCorridor('typeAriaLabel', 'Corridor type'),
        typeRoad: tCorridor('typeRoad', 'Road'),
        typeTrack: tCorridor('typeTrack', 'Track'),
        panelHeader: tCorridor('panelHeader', 'Road Info'),
        undo: tCorridor('undo', '(U)ndo'),
        finish: tCorridor('finish', '(F)inish'),
        metricLength: tCorridor('metricLength', 'Length'),
        metricArea: tCorridor('metricArea', 'Area'),
        hintFullMode: tCorridor('hintFullMode', 'Full parcel mode will use the merged parcel outline as the corridor geometry.'),
        hintDrawMode: tCorridor('hintDrawMode', 'Draw a road or track inside the merged parcels.'),
        widthHeaderRoad: tCorridor('widthHeaderRoad', 'Choose road width'),
        widthHeaderTrack: tCorridor('widthHeaderTrack', 'Choose track width'),
        sidewalkWidth: tCorridor('sidewalkWidth', 'Sidewalk width'),
        trackWidth: tCorridor('trackWidth', 'Track width'),
        done: tCorridor('done', 'Done')
    };

    overlay.innerHTML = `
        <div class="constrained-corridor-modal" role="dialog" aria-modal="true" aria-label="${corridorText.ariaLabel}">
            <div class="corridor-header">
                <div class="corridor-title">${corridorText.title}</div>
                <button type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${corridorText.closeLabel}" data-corridor-close>&times;</button>
            </div>
            <div class="corridor-layout">
                <div class="corridor-map-panel">
                    <div id="${mapId}" class="corridor-map" aria-label="${corridorText.mapAriaLabel}"></div>
                </div>
                <div class="corridor-sidebar">
                    <div class="corridor-toggle-row" role="group" aria-label="${corridorText.modeAriaLabel}">
                        <button type="button" class="btn proposal-type-button selected" data-corridor-mode="full">${corridorText.modeFull}</button>
                        <button type="button" class="btn proposal-type-button" data-corridor-mode="draw">${corridorText.modeDraw}</button>
                    </div>
                    <div class="corridor-toggle-row" role="group" aria-label="${corridorText.typeAriaLabel}" data-corridor-type-row>
                        <button type="button" class="btn proposal-type-button selected" data-corridor-type="road">${corridorText.typeRoad}</button>
                        <button type="button" class="btn proposal-type-button" data-corridor-type="track">${corridorText.typeTrack}</button>
                    </div>
                    <div class="corridor-draw-controls" data-corridor-draw-controls>
                        <div class="corridor-width-picker" data-corridor-width-picker style="display:flex; flex-direction:column; gap:6px;">
                            <div class="corridor-width-header" data-corridor-width-header>${corridorText.widthHeaderRoad}</div>
                            <div class="roadwidth-grid" data-corridor-road-grid style="max-height:160px; overflow:auto;"></div>
                            <label class="corridor-sidewalk" data-corridor-sidewalk style="display:flex; align-items:center; gap:8px;">
                                <span data-corridor-sidewalk-label>${corridorText.sidewalkWidth}</span>
                                <input type="range" min="0" max="5" step="0.1" value="1" data-corridor-sidewalk-slider style="flex:1;">
                                <span data-corridor-sidewalk-value>1.0 m</span>
                            </label>
                            <div class="corridor-track-controls" data-corridor-track-controls style="display:none; gap:8px; flex-direction:column; max-height:220px; overflow:auto;">
                                <div class="roadwidth-grid" data-corridor-track-grid></div>
                                <label class="corridor-track-width" style="display:flex; align-items:center; gap:8px;">
                                    <span data-corridor-track-label>${corridorText.trackWidth}</span>
                                    <input type="range" min="3" max="15" step="0.1" value="3" data-corridor-track-slider style="flex:1;">
                                    <span data-corridor-track-value>3.0 m</span>
                                </label>
                            </div>
                        </div>
                        <div class="corridor-panel">
                            <div class="corridor-panel__header">${corridorText.panelHeader}</div>
                            <div class="corridor-undo-row">
                                <button type="button" class="btn btn-secondary" data-corridor-undo disabled>${corridorText.undo}</button>
                                <button type="button" class="btn btn-secondary" data-corridor-finish disabled>${corridorText.finish}</button>
                            </div>
                            <div class="corridor-metrics" aria-live="polite">
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricLength}</div>
                                    <div class="corridor-metric__value" data-corridor-length>0 m</div>
                                </div>
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricArea}</div>
                                    <div class="corridor-metric__value" data-corridor-area>0 m²</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="corridor-hint" data-corridor-hint>${corridorText.hintFullMode}</div>
                    <div class="corridor-actions">
                        <button type="button" class="btn btn-proposal" data-corridor-done>${corridorText.done}</button>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    const map = (typeof L !== 'undefined' && L.map) ? L.map(mapId, { zoomControl: true, scrollWheelZoom: true }) : null;
    if (!map) {
        overlay.remove();
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusMapUnavailable', 'Map library unavailable.'));
        }
        return;
    }

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const parcelLayer = L.geoJSON(parcelFeatures, {
        style: () => ({
            color: '#1f2937',
            weight: 1.4,
            fillColor: '#e5e7eb',
            fillOpacity: 0.12
        })
    }).addTo(map);

    const boundaryLayer = L.geoJSON(superFeature, {
        style: () => ({
            color: '#0f172a',
            weight: 6,
            dashArray: '8 6',
            fillOpacity: 0
        })
    }).addTo(map);

    const bounds = parcelLayer.getBounds();
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1));
    }

    let drawMode = 'full';
    let corridorType = 'road';
    let corridorWidth = DEFAULT_CORRIDOR_WIDTHS.road;
    const drawnPoints = [];
    let drawingFinalized = false;
    let lineLayer = null;
    let polygonLayer = null;
    let previewLine = null;
    let previewPolygon = null;

    const drawControls = overlay.querySelector('[data-corridor-draw-controls]');
    const modeButtons = overlay.querySelectorAll('[data-corridor-mode]');
    const typeButtons = overlay.querySelectorAll('[data-corridor-type]');
    const undoButton = overlay.querySelector('[data-corridor-undo]');
    const finishButton = overlay.querySelector('[data-corridor-finish]');
    const doneButton = overlay.querySelector('[data-corridor-done]');
    const lengthEl = overlay.querySelector('[data-corridor-length]');
    const areaEl = overlay.querySelector('[data-corridor-area]');
    const hintEl = overlay.querySelector('[data-corridor-hint]');
    const widthPicker = overlay.querySelector('[data-corridor-width-picker]');
    const widthHeader = overlay.querySelector('[data-corridor-width-header]');
    const roadGrid = overlay.querySelector('[data-corridor-road-grid]');
    const trackControls = overlay.querySelector('[data-corridor-track-controls]');
    const trackGrid = overlay.querySelector('[data-corridor-track-grid]');
    const trackSlider = overlay.querySelector('[data-corridor-track-slider]');
    const trackValue = overlay.querySelector('[data-corridor-track-value]');
    const trackLabel = overlay.querySelector('[data-corridor-track-label]');
    const sidewalkControls = overlay.querySelector('[data-corridor-sidewalk]');
    const sidewalkSlider = overlay.querySelector('[data-corridor-sidewalk-slider]');
    const sidewalkValue = overlay.querySelector('[data-corridor-sidewalk-value]');
    const sidewalkLabel = overlay.querySelector('[data-corridor-sidewalk-label]');

    const closeModal = () => {
        map.off('click', handleMapClick);
        map.off('mousemove', handleMouseMove);
        if (lineLayer) map.removeLayer(lineLayer);
        if (polygonLayer) map.removeLayer(polygonLayer);
        if (previewLine) map.removeLayer(previewLine);
        if (previewPolygon) map.removeLayer(previewPolygon);
        map.removeLayer(parcelLayer);
        map.removeLayer(boundaryLayer);
        map.remove();
        overlay.removeEventListener('click', handleOverlayClick);
        overlay.removeEventListener('keydown', handleKeydown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        constrainedCorridorState = null;
    };

    constrainedCorridorState = {
        close: closeModal,
        overlay
    };

    // Corridor width picker (inline, mirrors road/track width dialogs)
    const persistGet = (key, fallback) => {
        try {
            const val = (typeof PersistentStorage !== 'undefined' && PersistentStorage.getItem)
                ? PersistentStorage.getItem(key)
                : null;
            return val !== null && val !== undefined && val !== '' ? val : fallback;
        } catch (_) {
            return fallback;
        }
    };
    const persistSet = (key, val) => {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage.setItem) {
                PersistentStorage.setItem(key, String(val));
            }
        } catch (_) { /* ignore */ }
    };

    const roadWidthOptions = [
        { id: 'roadwidth6', label: tCorridor('roadWidths.alley', 'Alley ~7.5 m'), width: 7.5 },
        { id: 'roadwidth5', label: tCorridor('roadWidths.local', 'Local ~10 m'), width: 10 },
        { id: 'roadwidth4', label: tCorridor('roadWidths.collector', 'Collector ~18 m'), width: 18 },
        { id: 'roadwidth3', label: tCorridor('roadWidths.mainStreet', 'Main street ~26 m'), width: 26 },
        { id: 'roadwidth2', label: tCorridor('roadWidths.avenue', 'Avenue ~40 m'), width: 40 },
        { id: 'roadwidth1', label: tCorridor('roadWidths.boulevard', 'Boulevard ~80 m'), width: 80 }
    ];

    const trackSpeedOptions = [
        { id: 'trackspeed1', speed: 50, label: '50 km/h', minRadius: 300 },
        { id: 'trackspeed2', speed: 80, label: '80 km/h', minRadius: 500 },
        { id: 'trackspeed3', speed: 120, label: '120 km/h', minRadius: 1000 },
        { id: 'trackspeed4', speed: 160, label: '160 km/h', minRadius: 2000 },
        { id: 'trackspeed5', speed: 200, label: '200 km/h', minRadius: 3500 },
        { id: 'trackspeed6', speed: 250, label: '250 km/h', minRadius: 5000 }
    ];

    let selectedRoadWidthId = persistGet('lastRoadWidthId', 'roadwidth6');
    let selectedTrackSpeedId = persistGet('lastTrackSpeedId', 'trackspeed1');
    let corridorSidewalkWidth = parseFloat(persistGet('lastSidewalkWidth', 1));
    if (!Number.isFinite(corridorSidewalkWidth)) corridorSidewalkWidth = 1;
    let roadBaseWidth = (roadWidthOptions.find(o => o.id === selectedRoadWidthId) || roadWidthOptions[0]).width;
    let trackWidthValue = parseFloat(persistGet('lastTrackWidth', DEFAULT_CORRIDOR_WIDTHS.track));
    if (!Number.isFinite(trackWidthValue)) trackWidthValue = DEFAULT_CORRIDOR_WIDTHS.track;

    const getRoadThumb = (id) => {
        if (typeof getRoadWidthThumbDataURI === 'function') {
            try { return getRoadWidthThumbDataURI(id); } catch (_) { }
        }
        // Fallback simple placeholder
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#cfd8dc"/><rect x="20" y="40" width="160" height="40" rx="6" fill="#616161"/><rect x="20" y="58" width="160" height="4" fill="#ffffff"/></svg>`);
    };

    function setCorridorWidth(newWidth) {
        if (!Number.isFinite(newWidth)) return;
        corridorWidth = newWidth;
        updatePreview();
    }

    function syncSidewalkUI() {
        if (sidewalkSlider) sidewalkSlider.value = corridorSidewalkWidth;
        if (sidewalkValue) sidewalkValue.textContent = `${Number(corridorSidewalkWidth).toFixed(1)} m`;
    }

    if (sidewalkLabel) sidewalkLabel.textContent = corridorText.sidewalkWidth;
    syncSidewalkUI();
    if (sidewalkSlider) {
        sidewalkSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!Number.isFinite(val)) return;
            corridorSidewalkWidth = val;
            persistSet('lastSidewalkWidth', val);
            syncSidewalkUI();
            if (corridorType === 'road') {
                setCorridorWidth(roadBaseWidth); // Sidewalk is contained within road width
            }
        });
    }

    function renderRoadWidthGrid() {
        if (!roadGrid) return;
        roadGrid.innerHTML = '';
        roadGrid.style.display = 'grid';
        roadGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
        roadGrid.style.gap = '8px';
        roadWidthOptions.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedRoadWidthId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.width = String(opt.width);

            const img = document.createElement('img');
            img.className = 'roadwidth-thumb';
            img.alt = opt.label;
            img.src = getRoadThumb(opt.id);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = opt.label;

            card.appendChild(img);
            card.appendChild(lbl);

            const selectFn = () => {
                selectedRoadWidthId = opt.id;
                persistSet('lastRoadWidthId', opt.id);
                roadBaseWidth = opt.width;
                roadGrid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                if (corridorType === 'road') {
                    setCorridorWidth(roadBaseWidth); // Sidewalk is contained within road width
                }
            };

            card.addEventListener('click', selectFn);
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectFn();
                }
            });

            roadGrid.appendChild(card);
        });
    }

    function renderTrackGrid() {
        if (!trackGrid) return;
        trackGrid.innerHTML = '';
        trackGrid.style.display = 'grid';
        trackGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
        trackGrid.style.gap = '8px';
        trackSpeedOptions.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedTrackSpeedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.speed = String(opt.speed);
            card.dataset.minRadius = String(opt.minRadius);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label} (min radius: ${opt.minRadius}m)`;
            card.appendChild(lbl);

            const selectFn = () => {
                selectedTrackSpeedId = opt.id;
                persistSet('lastTrackSpeedId', opt.id);
                trackGrid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
            };

            card.addEventListener('click', selectFn);
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectFn();
                }
            });

            trackGrid.appendChild(card);
        });
    }

    function syncTrackWidthUI() {
        if (!trackSlider || !trackValue) return;
        trackSlider.value = trackWidthValue;
        trackValue.textContent = `${Number(trackWidthValue).toFixed(1)} m`;
    }

    if (trackSlider) {
        syncTrackWidthUI();
        trackSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!Number.isFinite(val)) return;
            trackWidthValue = val;
            persistSet('lastTrackWidth', val);
            syncTrackWidthUI();
            if (corridorType === 'track') {
                setCorridorWidth(trackWidthValue);
            }
        });
    }

    // Build pickers once
    renderRoadWidthGrid();
    renderTrackGrid();

    function applyMode(mode) {
        drawMode = mode;
        modeButtons.forEach(btn => {
            const isActive = btn.getAttribute('data-corridor-mode') === mode;
            btn.classList.toggle('selected', isActive);
        });
        if (drawControls) {
            drawControls.style.display = mode === 'draw' ? 'flex' : 'none';
        }
        if (hintEl) {
            hintEl.textContent = mode === 'draw' ? corridorText.hintDrawMode : corridorText.hintFullMode;
        }
        const mapContainer = map.getContainer();
        if (mapContainer) {
            mapContainer.style.cursor = mode === 'draw' ? 'crosshair' : '';
            mapContainer.classList.toggle('corridor-draw-mode', mode === 'draw');
        }
        drawingFinalized = false;
        if (mode === 'full') {
            clearDrawnGeometry();
        }
        updateButtons();
    }

    function applyType(type) {
        corridorType = type === 'track' ? 'track' : 'road';
        if (widthHeader) {
            widthHeader.textContent = corridorType === 'track' ? corridorText.widthHeaderTrack : corridorText.widthHeaderRoad;
        }
        if (trackControls) trackControls.style.display = corridorType === 'track' ? 'flex' : 'none';
        if (roadGrid) roadGrid.style.display = corridorType === 'road' ? 'grid' : 'none';
        if (trackLabel) trackLabel.textContent = corridorText.trackWidth;
        if (sidewalkControls) sidewalkControls.style.display = corridorType === 'road' ? 'flex' : 'none';
        if (sidewalkLabel) sidewalkLabel.textContent = corridorText.sidewalkWidth;

        if (corridorType === 'track') {
            corridorWidth = Number.isFinite(trackWidthValue) ? trackWidthValue : DEFAULT_CORRIDOR_WIDTHS.track;
        } else {
            const sel = roadWidthOptions.find(o => o.id === selectedRoadWidthId) || roadWidthOptions[0];
            roadBaseWidth = sel?.width || DEFAULT_CORRIDOR_WIDTHS.road;
            corridorWidth = roadBaseWidth; // Sidewalk sits inside road width
        }
        typeButtons.forEach(btn => {
            const active = btn.getAttribute('data-corridor-type') === corridorType;
            btn.classList.toggle('selected', active);
        });
        updatePreview();
    }

    function handleOverlayClick(event) {
        if (event.target && event.target.matches('[data-corridor-close]')) {
            closeModal();
        }
    }

    function handleKeydown(event) {
        const targetTag = (event.target?.tagName || '').toLowerCase();
        const isFormField = targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select';
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (isFormField) return;
        if ((event.key === 'u' || event.key === 'U') && !undoButton?.disabled) {
            event.preventDefault();
            handleUndo();
        }
        if ((event.key === 'f' || event.key === 'F') && !finishButton?.disabled) {
            event.preventDefault();
            finalizeCorridorDrawing();
        }
    }

    function pointInsideSuperparcel(latlng) {
        if (!latlng) return false;
        if (typeof turf === 'undefined') return true;
        try {
            return turf.booleanPointInPolygon(turf.point([latlng.lng, latlng.lat]), superTurfFeature);
        } catch (_) {
            return true;
        }
    }

    function clearDrawnGeometry() {
        drawnPoints.length = 0;
        drawingFinalized = false;
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        setMetrics(0, 0);
    }

    function handleMapClick(event) {
        if (drawMode !== 'draw' || !event || !event.latlng) return;
        if (drawingFinalized) {
            clearDrawnGeometry();
        }
        if (!pointInsideSuperparcel(event.latlng)) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_point_outside', 'Clicks must stay within the selected parcels.');
            }
            return;
        }
        drawnPoints.push(event.latlng);
        updatePreview();
    }

    function handleMouseMove(event) {
        if (drawMode !== 'draw' || drawingFinalized || !event || !event.latlng) return;
        updatePreview(event.latlng);
    }

    function toClosedRing(latlngs) {
        if (!Array.isArray(latlngs) || !latlngs.length) return [];
        const ring = latlngs.map(pt => [pt.lng, pt.lat]);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            ring.push([first[0], first[1]]);
        }
        return ring;
    }

    function computeMetrics(points, polygonLatLngs) {
        let length = 0;
        let area = 0;
        if (typeof turf !== 'undefined') {
            if (points && points.length >= 2) {
                try {
                    const line = turf.lineString(points.map(pt => [pt.lng, pt.lat]));
                    length = turf.length(line, { units: 'kilometers' }) * 1000;
                } catch (_) { }
            }
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                try {
                    const ring = toClosedRing(polygonLatLngs);
                    if (ring.length >= 4) {
                        const poly = turf.polygon([ring]);
                        area = turf.area(poly);
                    }
                } catch (_) { }
            }
        }
        return { length, area };
    }

    function setMetrics(length, area) {
        if (lengthEl) lengthEl.textContent = `${length.toFixed(1)} m`;
        if (areaEl) areaEl.textContent = `${area.toFixed(1)} m²`;
    }

    function updatePreview(hoverPoint) {
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }

        const points = drawnPoints.slice();
        const useHover = hoverPoint && !drawingFinalized;
        if (useHover) points.push(hoverPoint);

        if (!points.length) {
            setMetrics(0, 0);
            updateButtons();
            return;
        }

        const line = L.polyline(points, { color: '#2563eb', weight: 3 }).addTo(map);
        if (drawingFinalized) {
            lineLayer = line;
        } else {
            previewLine = line;
        }

        let polygonLatLngs = null;
        if (points.length >= 2) {
            polygonLatLngs = (typeof calculateRoadPolygon === 'function')
                ? calculateRoadPolygon(points, corridorWidth)
                : null;
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                const polygon = L.polygon(polygonLatLngs, {
                    color: '#34d399',
                    weight: 2,
                    fillColor: '#34d399',
                    fillOpacity: 0.25
                }).addTo(map);
                if (drawingFinalized) {
                    polygonLayer = polygon;
                } else {
                    previewPolygon = polygon;
                }
            }
        }

        const metrics = computeMetrics(points, polygonLatLngs);
        setMetrics(metrics.length, metrics.area);
        updateButtons();
    }

    function updateButtons() {
        const hasLine = drawnPoints.length >= 2;
        const drawDisabled = drawMode !== 'draw';
        if (undoButton) {
            undoButton.disabled = drawnPoints.length === 0 || drawDisabled;
        }
        if (finishButton) {
            finishButton.disabled = !hasLine || drawDisabled;
        }
        if (doneButton) {
            doneButton.disabled = (drawMode === 'draw' && !hasLine);
        }
    }

    function handleUndo() {
        if (!drawnPoints.length || drawMode !== 'draw') return;
        drawnPoints.pop();
        drawingFinalized = false;
        updatePreview();
    }

    function finalizeCorridorDrawing() {
        if (drawMode !== 'draw' || drawnPoints.length < 2) return;
        drawingFinalized = true;
        updatePreview();
    }

    function persistGeometryAndClose() {
        if (drawMode === 'full') {
            pendingConstrainedCorridor = {
                mode: 'full',
                type: corridorType,
                width: corridorWidth,
                parentParcelIds: parcelIds.slice(),
                superGeometry: superGeometry,
                polygon: superGeometry,
                centerline: []
            };
            if (typeof window !== 'undefined') {
                window.pendingConstrainedCorridor = pendingConstrainedCorridor;
            }
            if (typeof setGeometryStatus === 'function') {
                const submittedLabel = (typeof t === 'function')
                    ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                    : '✔️ geometry submitted';
                setGeometryStatus(submittedLabel, { submitted: true });
            }
            closeModal();
            return;
        }

        if (drawnPoints.length < 2) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_draw_more_points', 'Add at least two points to draw a corridor.');
            }
            return;
        }

        const polygonLatLngs = (typeof calculateRoadPolygon === 'function')
            ? calculateRoadPolygon(drawnPoints, corridorWidth)
            : null;

        if (!polygonLatLngs || !polygonLatLngs.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        const ring = toClosedRing(polygonLatLngs);
        if (!ring.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        if (typeof turf !== 'undefined') {
            try {
                const corridorPoly = turf.polygon([ring]);
                const paddedSuper = turf.buffer(superTurfFeature, 0.15, { units: 'meters' }) || superTurfFeature;
                const within = turf.booleanWithin(corridorPoly, paddedSuper);
                let outsideArea = 0;
                if (!within && typeof turf.difference === 'function' && typeof turf.area === 'function') {
                    const outside = turf.difference(corridorPoly, paddedSuper);
                    outsideArea = outside ? turf.area(outside) : 0;
                }
                if (!within && outsideArea > 0.5) {
                    if (typeof showProposalAlertMessage === 'function') {
                        showProposalAlertMessage('corridor_outside_bounds', 'The corridor must stay within the selected parcels.');
                    }
                    return;
                }
            } catch (_) { /* best effort */ }
        }

        const geoPolygon = { type: 'Polygon', coordinates: [ring] };
        const centerline = drawnPoints.map(pt => [pt.lng, pt.lat]);

        pendingConstrainedCorridor = {
            mode: 'draw',
            type: corridorType,
            width: corridorWidth,
            parentParcelIds: parcelIds.slice(),
            superGeometry: superGeometry,
            polygon: geoPolygon,
            centerline
        };

        if (typeof window !== 'undefined') {
            window.pendingConstrainedCorridor = pendingConstrainedCorridor;
        }

        if (typeof setGeometryStatus === 'function') {
            const submittedLabel = (typeof t === 'function')
                ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                : '✔️ geometry submitted';
            setGeometryStatus(submittedLabel, { submitted: true });
        }

        closeModal();
    }

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyMode(btn.getAttribute('data-corridor-mode') === 'draw' ? 'draw' : 'full'));
    });

    typeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyType(btn.getAttribute('data-corridor-type')));
    });

    if (undoButton) {
        undoButton.addEventListener('click', handleUndo);
    }

    if (finishButton) {
        finishButton.addEventListener('click', finalizeCorridorDrawing);
    }

    if (doneButton) {
        doneButton.addEventListener('click', persistGeometryAndClose);
    }

    if (map) {
        map.on('click', handleMapClick);
        map.on('mousemove', handleMouseMove);
    }

    overlay.addEventListener('click', handleOverlayClick);
    overlay.addEventListener('keydown', handleKeydown, true);

    // Initialize state
    applyMode('full');
    applyType('road');
    setTimeout(() => {
        try { map.invalidateSize(); } catch (_) { }
    }, 50);
}

function setProposalModalInteractivity(enabled) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const controls = modal.querySelectorAll('input, textarea, select, button');

    controls.forEach(control => {
        const isCloseButton = control.classList && control.classList.contains('proposal-modal-close');
        if (enabled) {
            if (control.dataset.disabledByCreate === '1') {
                control.disabled = false;
                delete control.dataset.disabledByCreate;
            }
        } else {
            if (!isCloseButton && !control.disabled) {
                control.dataset.disabledByCreate = '1';
                control.disabled = true;
            }
        }
    });

    modal.classList.toggle('proposal-modal-disabled', !enabled);
}

function showProposalDialog(overrides = null) {
    // Gate: require personalized profile to create proposals
    if (requirePersonalizedUser()) {
        return;
    }

    // Stash overrides for this session
    proposalDialogOverrides = overrides || null;

    // Lineage for "Copy into new proposal". Set (or cleared) on every dialog open, so a plain
    // create can never inherit a stale source from an earlier copy.
    if (typeof window !== 'undefined') {
        window.pendingProposalCopySource = (overrides && overrides.copySource) ? overrides.copySource : null;
    }

    // Remove any existing create-proposal modal so re-opening the dialog (e.g. after editing a
    // proposal's geometry, which calls showProposalDialog() again) replaces it instead of stacking
    // a second modal on top of the first.
    document.querySelectorAll('.create-proposal-modal').forEach(m => m.remove());

    const t = getProposalI18nHelper();
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const noParcelsMessage = t(
        'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
        'Please select at least one parcel to create a proposal.'
    );
    const modalTitle = t('modal.createProposal.title', 'Create Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const proposalTypeLabel = t('modal.createProposal.proposalTypeLabel', 'Proposal Type:');
    const proposalGoalLabel = t('modal.createProposal.proposalGoalLabel', 'Proposal Goal:');
    const proposalTypologyLabel = t('modal.createProposal.typologyLabel', 'Typology');
    const acquisitionLabel = t('modal.createProposal.acquisitionLabel', 'Acquisition strategy');
    const acquisitionOptions = {
        full: t('modal.createProposal.acquisitionOptions.full', 'Full acquisition'),
        partial: t('modal.createProposal.acquisitionOptions.partial', 'Partial acquisition'),
        partialPreferred: t('modal.createProposal.acquisitionOptions.partialPreferred', 'Partial acquisition preferred')
    };
    const ownershipLabel = t('modal.createProposal.ownershipLabel', 'Ownership');
    const ownershipOptions = {
        single: t('modal.createProposal.ownershipOptions.single', 'Single owner'),
        multiple: t('modal.createProposal.ownershipOptions.multiple', 'Multiple owners')
    };
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const namePlaceholder = t('modal.createProposal.namePlaceholderProposal', 'Proposal name');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const unknownOwnerLabel = t('modal.createProposal.ownerUnknown', 'Unknown');
    const formatOwnerTooltip = (name) => t('modal.createProposal.ownerTooltip', 'Owner: {{name}}', { name });
    const proposalTypeLabels = {
        Purchase: t('modal.createProposal.proposalTypeOptions.purchase', 'Purchase'),
        'Urban Rule': t('modal.createProposal.proposalTypeOptions.urbanRule', 'Urban Rule'),
        Reparcellization: t('modal.createProposal.proposalTypeOptions.reparcellization', 'Reparcellization'),
        'Joint Investment': t('modal.createProposal.proposalTypeOptions.jointInvestment', 'Joint Investment')
    };
    const goalLabels = {
        buildings: t('modal.createProposal.goalOptions.buildings', 'Buildings'),
        single: t('modal.createProposal.goalOptions.single', 'Building(s)'),
        park: t('modal.createProposal.goalOptions.park', 'Park'),
        square: t('modal.createProposal.goalOptions.square', 'Square'),
        lake: t('modal.createProposal.goalOptions.lake', 'Lake'),
        roadTrack: t('modal.createProposal.goalOptions.roadTrack', 'Road/Track'),
        decideLater: t('modal.createProposal.goalOptions.decideLater', 'Decide later'),
        urbanRule: t('modal.createProposal.goalOptions.urbanRule', 'Urban Rule'),
        reparcellization: t('modal.createProposal.goalOptions.reparcellization', 'Reparcellization'),
        ownershipTransfer: t('modal.createProposal.goalOptions.ownershipTransfer', 'Ownership transfer')
    };
    const goalSectionLabels = {
        landUse: t('modal.createProposal.goalSections.landUse', 'Land use'),
        parcels: t('modal.createProposal.goalSections.parcels', 'Parcels'),
        ownership: t('modal.createProposal.goalSections.ownership', 'Ownership')
    };
    const asIsLandUseLabel = t('modal.createProposal.goalOptions.asIs', 'As is');
    const parcelsOptions = {
        asIs: t('modal.createProposal.parcelsOptions.asIs', 'As is'),
        merge: t('modal.createProposal.parcelsOptions.merge', 'Merge'),
        readjust: t('modal.createProposal.parcelsOptions.readjust', 'Readjust')
    };
    const ownershipRecipients = {
        noChange: t('modal.createProposal.ownershipRecipients.noChange', 'No change'),
        toMe: t('modal.createProposal.ownershipRecipients.toMe', 'To me'),
        toCity: t('modal.createProposal.ownershipRecipients.toCity', 'To city'),
        thirdParty: t('modal.createProposal.ownershipRecipients.thirdParty', 'Third party'),
        perSlice: t('modal.createProposal.ownershipRecipients.perSlice', 'Per slice')
    };
    const recipientPlaceholder = t('modal.createProposal.recipientPlaceholder', 'Recipient name or 0x address');
    const recipientScopeLabels = {
        specific: t('modal.createProposal.recipientScope.specific', 'Specific address'),
        any: t('modal.createProposal.recipientScope.any', 'Anyone')
    };
    const ownershipTransferLabels = {
        toMe: t('modal.createProposal.ownershipTransfer.toMe', 'To me'),
        fromMe: t('modal.createProposal.ownershipTransfer.fromMe', 'From me')
    };
    proposalAcquisitionLabels = {
        full: acquisitionOptions.full,
        partial: acquisitionOptions.partial,
        partialPreferred: acquisitionOptions.partialPreferred
    };
    const typologyOptions = {
        block: t('modal.createProposal.typologyOptions.block', 'Block'),
        row: t('modal.createProposal.typologyOptions.row', 'Row'),
        parcelBased: t('modal.createProposal.typologyOptions.parcelBased', 'Parcel-based')
    };
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholder', 'Describe your proposal...');
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    // Title for the collapsible "Options" section that hides Offer + advanced settings by default.
    const optionsSectionTitle = t('modal.createProposal.optionsSectionTitle', 'Options');
    const conditionalLabel = t('modal.createProposal.options.conditional', 'Conditional');
    const conditionalHelperOnText = t('modal.createProposal.options.conditionalHelperOn', 'Pay reward only if/when all owners accept');
    const conditionalHelperOffText = t('modal.createProposal.options.conditionalHelperOff', 'Payout only when all parcels accept');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryTitle = t('modal.createProposal.summary.title', 'Proposal Summary');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summaryOwnersLabel = t('modal.createProposal.summary.owners', 'Total owners:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const similarTitle = t('modal.createProposal.similar.title', 'Similar proposals:');
    const similarUnknownTitle = t('modal.createProposal.similar.unknownTitle', 'Untitled proposal');
    const similarUnknownAuthor = t('modal.createProposal.similar.unknownAuthor', 'Unknown');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const overrideGoal = normalizeGoalKey(proposalDialogOverrides?.goal) || null;
    const overrideAcquisition = proposalDialogOverrides?.acquisitionMode || null;
    const overridePrefill = proposalDialogOverrides?.prefill || {};
    const overrideSummaryStats = proposalDialogOverrides?.summaryStats || null;
    const overrideGeometryPreset = proposalDialogOverrides?.geometryPreset || null;
    const goalLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockGoal);
    const ownershipOnly = !!(proposalDialogOverrides && proposalDialogOverrides.ownershipOnly);
    const acquisitionLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockAcquisition);

    const selection = getCurrentParcelSelectionContext();
    const selectedParcels = selection.layers;
    const parcelIds = selection.ids;
    const isSingleParcelSelection = selectedParcels.length === 1;
    const roadScreenshotContext = ((typeof window !== 'undefined' && window.pendingRoadDrawingProposal)
        ? window.pendingRoadDrawingProposal
        : pendingRoadDrawingProposal) || null;
    // The preview context is expensive to build (it walks the parcel cache for neighbour outlines), and
    // it is only needed to draw a thumbnail. Building it here would hold the dialog closed while the
    // user waits, so it is deferred until after the modal has painted; the container is reserved now and
    // removed later if there turns out to be nothing to preview.
    const hasScreenshotCandidate = selectedParcels.length > 0 || !!roadScreenshotContext;

    // Which chain this proposal will be minted on, if any. Minting is implicit — it follows whichever
    // wallet is connected or whether Canton mode is on — so the dialog has to say so out loud.
    const offchainLabel = t('modal.createProposal.mintTarget.offchain', 'Off-chain (this browser only)');
    const mintTarget = (typeof getActiveMintTarget === 'function')
        ? getActiveMintTarget()
        : { chain: null, label: offchainLabel, onchain: false };
    const mintsOnLabel = t('modal.createProposal.mintTarget.mintsOn', 'Mints on');
    const noWalletTooltip = t('modal.createProposal.mintTarget.noWalletTooltip', 'No wallet connected; the proposal stays in this browser.');
    const mintChainHtml = `
        <div class="proposal-mint-target ${mintTarget.onchain ? 'proposal-mint-target--onchain' : 'proposal-mint-target--offchain'}"
             title="${mintTarget.identity ? String(mintTarget.identity) : noWalletTooltip}">
            <i class="fas ${mintTarget.onchain ? 'fa-link' : 'fa-link-slash'}" aria-hidden="true"></i>
            <span>${mintTarget.onchain ? mintsOnLabel : ''} <b>${mintTarget.label}</b></span>
        </div>`;

    currentProposalTool = null;

    if (!selectedParcels.length) {
        updateStatus(noParcelsMessage);
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    const ownershipStats = computeOwnershipStatsFromSelection(selection);
    const totalOwners = ownershipStats.ownerCount || selectedParcels.length;
    const ownershipMode = ownershipStats.mode;
    currentOwnershipMode = ownershipMode;
    proposalSingleParcelSelection = isSingleParcelSelection;

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId || unknownParcelLabel) || unknownParcelLabel;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    const ownerName = owner.name || unknownOwnerLabel;
                    const ownerTooltip = formatOwnerTooltip(ownerName);
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 20px; height: 20px; border-radius: 50%; border: 2px solid #007bff; margin-right: 6px;" title="${ownerTooltip}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item" style="display: flex; align-items: center;">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">${parcelLabel} ${parcelNumber}</span>
                </div>
            </div>
        `;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                ${mintChainHtml}
                ${hasScreenshotCandidate ? '<div class="form-group proposal-screenshot-loading" id="proposalScreenshotContainer" style="margin-bottom: 15px;"><div class="proposal-screenshot-spinner" aria-label="Preparing preview"></div></div>' : ''}
                <div class="form-group proposal-author-row">
                    <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                    <input type="text" id="proposalAuthor" class="proposal-author-name" placeholder="${authorPlaceholder}" disabled>
                </div>
                <div class="form-group" id="proposalMainTypeGroup" style="display:none;">
                    <label>${proposalTypeLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button selected" data-proposal-main-type="Purchase" onclick="setProposalMainType('Purchase')">${proposalTypeLabels.Purchase}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Urban Rule" onclick="handleUrbanRuleMainTypeClick()">${proposalTypeLabels['Urban Rule']}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Reparcellization" onclick="setProposalMainType('Reparcellization')">${proposalTypeLabels.Reparcellization}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Joint Investment" disabled>${proposalTypeLabels['Joint Investment']}</button>
                    </div>
                </div>
                <input type="hidden" id="proposalMainType" value="Purchase">
                <div class="form-group" id="proposalGoalGroup">
                    <div class="proposal-goal-section" data-goal-section="land-use">
                        <span class="proposal-goal-subhead">${goalSectionLabels.landUse}</span>
                        <div class="proposal-radio-group" id="proposalLandUseGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="as-is" checked onchange="onProposalLandUseChange()"><span>${asIsLandUseLabel}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="square" onchange="onProposalLandUseChange()"><span>⛲️ ${goalLabels.square}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="park" onchange="onProposalLandUseChange()"><span>🌳 ${goalLabels.park}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="lake" onchange="onProposalLandUseChange()"><span>🐟 ${goalLabels.lake}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="single" onchange="onProposalLandUseChange()"><span>🏠 ${goalLabels.single}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="road-track" onchange="onProposalLandUseChange()"><span>🛣️ ${goalLabels.roadTrack}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="urban-rule" onchange="onProposalLandUseChange()"><span>📜 ${goalLabels.urbanRule}</span></label>
                        </div>
                    </div>
                    <div class="proposal-goal-section" data-goal-section="parcels">
                        <span class="proposal-goal-subhead">${goalSectionLabels.parcels}</span>
                        <div class="proposal-radio-group" id="proposalParcelsGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="as-is" checked onchange="onProposalParcelsChange()"><span>${parcelsOptions.asIs}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="merge" onchange="onProposalParcelsChange()"><span>🪡 ${parcelsOptions.merge}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="readjust" onchange="onProposalParcelsChange()"><span>✂️ ${parcelsOptions.readjust}</span></label>
                        </div>
                        <div class="proposal-facet-static" id="proposalParcelsStatic" style="display:none;"></div>
                    </div>
                    <div class="proposal-goal-section" data-goal-section="ownership">
                        <span class="proposal-goal-subhead">${goalSectionLabels.ownership}</span>
                        <div class="proposal-radio-group" id="proposalOwnershipGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="no-change" checked onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.noChange}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="to-me" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toMe}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="to-city" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toCity}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="third-party" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.thirdParty}</span></label>
                            <label class="proposal-radio proposal-ownership-perslice" style="display:none;"><input type="radio" name="proposalOwnership" value="per-slice" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.perSlice}</span></label>
                        </div>
                        <div class="proposal-facet-static" id="proposalOwnershipStatic" style="display:none;"></div>
                        <div class="proposal-inset" id="proposalRecipientOptions" style="display:none;">
                            <div class="proposal-radio-group">
                                <label class="proposal-radio"><input type="radio" name="proposalRecipientScope" value="any" checked onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.any}</span></label>
                                <label class="proposal-radio"><input type="radio" name="proposalRecipientScope" value="specific" onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.specific}</span></label>
                            </div>
                            <input type="text" id="proposalRecipientAddress" class="proposal-recipient-input" placeholder="${recipientPlaceholder}" oninput="onProposalOwnershipChange()">
                        </div>
                    </div>
                </div>
                <div class="form-group" id="proposalOwnershipTransferGroup" style="display:none;">
                    <label>${t('modal.createProposal.ownershipTransfer.label', 'Transfer direction:')}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-ownership-transfer-button selected" data-transfer-direction="to-me" onclick="setOwnershipTransferDirection('to-me')">${ownershipTransferLabels.toMe}</button>
                        <button type="button" class="btn proposal-type-button proposal-ownership-transfer-button" data-transfer-direction="from-me" onclick="setOwnershipTransferDirection('from-me')">${ownershipTransferLabels.fromMe}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalAcquisitionGroup">
                    <span class="proposal-goal-subhead">${acquisitionLabel}</span>
                    <div class="proposal-radio-group">
                        <label class="proposal-radio"><input type="radio" name="proposalAcquisition" value="full" checked onchange="setProposalAcquisitionMode('full')"><span>${acquisitionOptions.full}</span></label>
                        <label class="proposal-radio"><input type="radio" name="proposalAcquisition" value="partial" onchange="setProposalAcquisitionMode('partial')"><span class="proposal-acquisition-partial-label">${acquisitionOptions.partial}</span></label>
                    </div>
                </div>
                <div class="form-group proposal-inset" id="proposalTypologyGroup" style="display:none;">
                    <label>${proposalTypologyLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="block" onclick="handleUrbanRuleTypologyClick('block', { skipLaunch: true })">${typologyOptions.block}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="row" onclick="handleUrbanRuleTypologyClick('row', { skipLaunch: true })">${typologyOptions.row}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="parcelBased" onclick="handleUrbanRuleTypologyClick('parcelBased', { skipLaunch: true })">${typologyOptions.parcelBased}</button>
                    </div>
                </div>
                <div class="form-group proposal-inset" id="proposalGeometryGroup" style="display:none;">
                    <div id="proposalGeometryStatus" class="proposal-geometry-status" style="font-size:12px; color:#4b5563; margin-bottom:6px;">${t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry')}</div>
                    <div class="proposal-type-group proposal-geometry-buttons" id="proposalGeometryButtons" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px;"></div>
                </div>
                <input type="hidden" id="proposalType" value="">
                <input type="hidden" id="proposalAcquisitionMode" value="full">
                <input type="hidden" id="proposalBoundaryMode" value="multiple">
                <hr class="proposal-section-divider">
                <div class="form-group">
                    <label for="proposalName" style="display: flex; align-items: center; gap: 8px;">
                        <span>${nameLabel}</span>
                        <input type="text" id="proposalName" style="flex: 1;" placeholder="${namePlaceholder}">
                    </label>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <input type="text" id="proposalDescription" class="proposal-description-input" placeholder="${descriptionPlaceholder}">
                </div>
                <div class="proposal-options-collapsible collapsible collapsed" id="proposalOptionsSection" style="margin-top:8px;">
                    <div class="collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalOptionsContent" onclick="(function(){
                        var section = document.getElementById('proposalOptionsSection');
                        var content = document.getElementById('proposalOptionsContent');
                        var icon = document.getElementById('proposalOptionsChevron');
                        section.classList.toggle('collapsed');
                        if (section.classList.contains('collapsed')) {
                            content.style.display = 'none';
                            icon.classList.remove('fa-chevron-up');
                            icon.classList.add('fa-chevron-down');
                            section.setAttribute('aria-expanded', 'false');
                        } else {
                            content.style.display = '';
                            icon.classList.remove('fa-chevron-down');
                            icon.classList.add('fa-chevron-up');
                            section.setAttribute('aria-expanded', 'true');
                        }
                    })()">
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">${optionsSectionTitle}</h3>
                        <i id="proposalOptionsChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalOptionsContent" style="display:none;">
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <div class="proposal-option-row" id="proposalOptionConditional" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalConditionalCheckbox" checked>
                            <label for="proposalConditionalCheckbox" style="margin:0; cursor:pointer;">${conditionalLabel}</label>
                        </div>
                        <div id="proposalConditionalHelperText" style="${optionHelperStyle} flex:1;">
                            ${conditionalHelperOnText}
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionExpire" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionDecay" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" id="proposalOptionDecayInputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionDeposit" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionAreaProportional" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary collapsible collapsed" id="proposalSummarySection">
                    <div class="collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalSummaryContent" onclick="(function(e){
                        var section = document.getElementById('proposalSummarySection');
                        var content = document.getElementById('proposalSummaryContent');
                        var icon = document.getElementById('proposalSummaryChevron');
                        var expanded = section.classList.toggle('collapsed');
                        if (section.classList.contains('collapsed')) {
                            content.style.display = 'none';
                            icon.classList.remove('fa-chevron-up');
                            icon.classList.add('fa-chevron-down');
                            section.setAttribute('aria-expanded', 'false');
                        } else {
                            content.style.display = '';
                            icon.classList.remove('fa-chevron-down');
                            icon.classList.add('fa-chevron-up');
                            section.setAttribute('aria-expanded', 'true');
                        }
                    })(event)">
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">${summaryTitle}</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                            <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong>${summaryOwnersLabel}</strong> ${totalOwners}</p>
                        </div>
                        <div class="parcel-list">
                            <h4>${summarySelectedLabel}</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
                <div class="proposal-similar-section" id="proposalSimilarSection" style="margin-top:12px; display:none;">
                    <h4 style="margin-bottom:6px;">${similarTitle}</h4>
                    <div id="proposalSimilarList" class="proposal-similar-list" style="display:flex; flex-direction:column; gap:6px;"></div>
                </div>
                    </div>
                </div>
            </div>
            <div class="proposal-modal-footer lens-footer-layout">
                <div class="lens-footer-row">
                    <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; width:100%;">
                    <button id="createProposalSubmitButton" class="btn btn-proposal" onclick="createProposal()">${submitLabel}</button>
                    <div id="proposalGeometryRequirementHint" style="font-size:11px; color:#c00; min-height:14px; text-align:right;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Reset stored screenshot
    proposalModalScreenshotDataUrl = null;
    proposalModalScreenshotPromise = null;

    // Deliberately a timeout rather than requestAnimationFrame: rAF does not fire while the tab is not
    // rendering, and the preview would then never appear.
    if (hasScreenshotCandidate) setTimeout(() => renderProposalScreenshotPreview(modal, selectedParcels, overrideGoal, roadScreenshotContext), 0);

    function renderProposalScreenshotPreview(modal, selectedParcels, overrideGoal, roadScreenshotContext) {
        const screenshotContainer = modal.querySelector('#proposalScreenshotContainer');
        if (!screenshotContainer) return;

        const screenshotContext = buildProposalScreenshotContext(selectedParcels, {
            goal: overrideGoal,
            roadContext: roadScreenshotContext
        });

        if (!screenshotContext || !screenshotContext.polygon
            || !window.MapScreenshot || typeof window.MapScreenshot.renderPolygonPreview !== 'function') {
            screenshotContainer.remove(); // nothing to preview after all
            return;
        }

        screenshotContainer.classList.remove('proposal-screenshot-loading');
        screenshotContainer.innerHTML = '';

        {
            (async () => {
                try {
                    const previewWrapper = document.createElement('div');
                    previewWrapper.className = 'map-screenshot-container';
                    previewWrapper.style.margin = '0 auto';
                    screenshotContainer.appendChild(previewWrapper);

                    const resolveGoalBadge = () => getProposalGoalBadge(currentProposalTool || 'square');
                    updateProposalScreenshotGoalIcon(currentProposalTool || 'square');

                    window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                        polygon: screenshotContext.polygon,
                        bounds: screenshotContext.bounds || null,
                        padding: 0.05,
                        parcelPolygons: screenshotContext.parcelPolygons,
                        neighbours: screenshotContext.neighbours || [],
                        fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly,
                        polygonOrder: screenshotContext.polygonOrder || 'auto',
                        parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto'
                    });

                    // Capture the screenshot after tiles have loaded and store it for minting
                    const captureScreenshot = () => {
                        if (proposalModalScreenshotPromise) return proposalModalScreenshotPromise;
                        if (!previewWrapper._leafletPreviewMap) {
                            console.warn('[proposal-modal] Preview map not ready for capture');
                            return null;
                        }
                        if (!window.MapScreenshot.captureViaTileStitch || !screenshotContext?.polygon) {
                            console.warn('[proposal-modal] Tile stitch capture unavailable; skipping preview capture');
                            return null;
                        }

                        if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                            console.debug('[proposal-modal] capturing screenshot', {
                                polygonLength: screenshotContext.polygon?.length,
                                parcelPolygonsCount: screenshotContext.parcelPolygons?.length,
                                hasBounds: !!screenshotContext.bounds,
                                fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                            });
                        }

                        const stitchStart = (performance && performance.now) ? performance.now() : Date.now();
                        const capturePromise = (async () => {
                            try {
                                const dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                    polygon: screenshotContext.polygon,
                                    parcelPolygons: screenshotContext.parcelPolygons || [],
                                    neighbours: screenshotContext.neighbours || [],
                                    bounds: screenshotContext.bounds || null,
                                    padding: 0.12,
                                    zoom: 19,
                                    badge: resolveGoalBadge(),
                                    polygonOrder: screenshotContext.polygonOrder || 'auto',
                                    parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto',
                                    fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                                });
                                const stitchMs = ((performance && performance.now ? performance.now() : Date.now()) - stitchStart).toFixed(1);

                                let byteSize = 0;
                                if (dataUrl && dataUrl.startsWith('data:image/')) {
                                    const base64Part = dataUrl.split(',')[1];
                                    byteSize = base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                                }

                                if (byteSize >= 5000) {
                                    proposalModalScreenshotDataUrl = dataUrl;
                                    console.debug('[proposal-modal] Tile stitch captured', { byteSize, stitchMs });
                                    return dataUrl;
                                }

                                console.warn('[proposal-modal] Tile stitch produced small image:', byteSize, 'bytes');
                                return null;
                            } catch (err) {
                                console.warn('[proposal-modal] Failed to capture screenshot for storage:', err);
                                return null;
                            }
                        })();

                        proposalModalScreenshotPromise = capturePromise;
                        return capturePromise;
                    };

                    // Wait for map to be ready and tiles to load
                    let waitForMapAttempts = 0;
                    const waitForMapAndCapture = () => {
                        waitForMapAttempts++;
                        const map = previewWrapper._leafletPreviewMap;
                        if (!map) {
                            if (waitForMapAttempts > 100) {
                                console.error('[proposal-modal] Gave up waiting for map after 100 attempts');
                                return;
                            }
                            // Map not set yet, try again shortly
                            setTimeout(waitForMapAndCapture, 100);
                            return;
                        }

                        // Find tile layer and wait for it to load
                        let tileLayer = null;
                        map.eachLayer(layer => {
                            if (layer._url && !tileLayer) {
                                tileLayer = layer;
                            }
                        });

                        if (tileLayer) {
                            // Listen for tile load completion
                            let captured = false;
                            const onLoad = () => {
                                if (captured) return;
                                captured = true;
                                tileLayer.off('load', onLoad);
                                // Small delay after load event to ensure rendering is complete
                                setTimeout(captureScreenshot, 300);
                            };
                            tileLayer.on('load', onLoad);
                            // Timeout fallback - capture after 4 seconds regardless
                            setTimeout(() => {
                                if (!captured) {
                                    captured = true;
                                    tileLayer.off('load', onLoad);
                                    captureScreenshot();
                                }
                            }, 4000);
                        } else {
                            // No tile layer found, just wait and capture
                            setTimeout(captureScreenshot, 2000);
                        }
                    };

                    // Start waiting for map
                    setTimeout(waitForMapAndCapture, 50);
                } catch (error) {
                    console.warn('Failed to render proposal screenshot preview', error);
                    screenshotContainer.innerHTML = '';
                    const fallbackDiv = document.createElement('div');
                    fallbackDiv.className = 'map-screenshot-container';
                    fallbackDiv.style.color = '#999';
                    fallbackDiv.textContent = 'Preview unavailable';
                    screenshotContainer.appendChild(fallbackDiv);
                }
            })();
        }
    }

    // Lock secondary selectors that are derived from the selected goal.
    // Urban Rule typology is a user choice and must remain selectable because the Geometry → Edit action
    // opens different modals depending on the selected typology (block/row/parcelBased).
    const lockSecondarySelectors = () => {
        const secondaryGroupIds = ['proposalAcquisitionGroup', 'proposalBoundaryGroup'];
        secondaryGroupIds.forEach(groupId => {
            const groupEl = modal.querySelector(`#${groupId}`);
            if (!groupEl) return;
            groupEl.classList.add('proposal-secondary-locked');
            const buttons = groupEl.querySelectorAll('.proposal-type-button, input[type="radio"]');
            buttons.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('proposal-selection-static');
                btn.setAttribute('aria-disabled', 'true');
            });
        });
    };

    lockSecondarySelectors();

    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    const initialGoal = overrideGoal || 'as-is';
    // Initialize the three facets (Land use / Parcels / Ownership). Defaults to
    // As is / As is / No change unless a goal was preset (e.g. from a road drawing).
    // This drives the legacy goal-key machinery via syncProposalFacets().
    initProposalFacets(overrideGoal);
    setProposalAcquisitionMode(overrideAcquisition || 'full', { force: true });
    setProposalBoundaryMode(ownershipMode || 'multiple', { lock: true });

    if (goalLocked) {
        // The three facets are now radio groups; lock them all to the preset selection.
        modal.querySelectorAll('#proposalGoalGroup input[type="radio"]').forEach(r => {
            r.disabled = true;
            r.setAttribute('aria-disabled', 'true');
        });
    }

    if (ownershipOnly) {
        // The Offer palette entry: building/land-use and parcel changes have their own palette
        // tools, so this dialog only negotiates ownership. Land use and parcels lock to
        // "no change" (greyed); the ownership radios stay live.
        modal.querySelectorAll('[data-goal-section="land-use"] input[type="radio"], [data-goal-section="parcels"] input[type="radio"]').forEach(radio => {
            radio.checked = radio.value === 'as-is';
            radio.disabled = true;
            radio.setAttribute('aria-disabled', 'true');
        });
        modal.querySelectorAll('[data-goal-section="land-use"], [data-goal-section="parcels"]')
            .forEach(section => section.classList.add('proposal-goal-section--locked'));
    }

    if (acquisitionLocked) {
        const desired = overrideAcquisition === 'partial-preferred' ? 'partial' : (overrideAcquisition || null);
        modal.querySelectorAll('#proposalAcquisitionGroup input[type="radio"]').forEach(radio => {
            if (desired) radio.checked = (radio.value === desired);
            radio.disabled = true;
            radio.classList.add('proposal-selection-static');
            radio.setAttribute('aria-disabled', 'true');
        });
        if (overrideAcquisition === 'partial-preferred') {
            const partialLabel = modal.querySelector('.proposal-acquisition-partial-label');
            if (partialLabel) partialLabel.textContent = proposalAcquisitionLabels.partialPreferred || partialLabel.textContent;
        }
        const acquisitionInput = document.getElementById('proposalAcquisitionMode');
        if (acquisitionInput) {
            acquisitionInput.value = overrideAcquisition || acquisitionInput.value || 'full';
        }
    }

    // Check contiguity and disable buttons that require contiguous parcels
    applyContiguityConstraints();

    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    const conditionalHelper = document.getElementById('proposalConditionalHelperText');
    const conditionalRow = conditionalCheckbox ? conditionalCheckbox.closest('.proposal-option-row') : null;
    const updateConditionalHelper = () => {
        if (!conditionalHelper || !conditionalCheckbox) return;
        conditionalHelper.textContent = conditionalCheckbox.checked
            ? conditionalHelperOnText
            : conditionalHelperOffText;
    };
    if (conditionalCheckbox) {
        const disableConditional = isSingleParcelSelection;
        conditionalCheckbox.checked = !disableConditional;
        conditionalCheckbox.disabled = disableConditional;
        if (conditionalRow) {
            conditionalRow.style.opacity = disableConditional ? '0.6' : '';
            conditionalRow.style.cursor = '';
        }
        conditionalCheckbox.addEventListener('change', updateConditionalHelper);
    }
    updateConditionalHelper();

    if (overrideGeometryPreset) {
        const geometryStatusText = overrideGeometryPreset.statusText
            || (t ? t('modal.createProposal.geometry.status.drawing', 'Geometry created by drawing') : 'Geometry created by drawing');
        // Ensure geometry is treated as submitted when coming from a preset (e.g. road drawing)
        proposalGeometrySubmitted = overrideGeometryPreset.submitted !== false;
        setGeometryStatus(geometryStatusText, { submitted: proposalGeometrySubmitted });
        const buttonsRow = document.getElementById('proposalGeometryButtons');
        if (buttonsRow) {
            const preferredAction = overrideGeometryPreset.selectedAction || 'upload';
            const disableButtons = overrideGeometryPreset.disableButtons !== false;
            buttonsRow.querySelectorAll('button').forEach(btn => {
                const action = btn.getAttribute('data-geometry-action') || btn.dataset.geometryAction;
                if (action === preferredAction) {
                    btn.classList.add('selected');
                } else {
                    btn.classList.remove('selected');
                }
                if (disableButtons) {
                    btn.disabled = true;
                    btn.classList.add('proposal-selection-static');
                    btn.setAttribute('aria-disabled', 'true');
                }
            });
            if (disableButtons) {
                buttonsRow.style.pointerEvents = 'none';
            }
        }
        // Re-run submit state guard after presetting geometry to avoid stale "No geometry" hint
        updateCreateProposalSubmitState();
    }

    if (overrideSummaryStats) {
        const summarySection = document.getElementById('proposalSummarySection');
        const summaryContent = document.getElementById('proposalSummaryContent');
        if (summarySection && summaryContent) {
            summarySection.classList.remove('collapsed');
            summaryContent.style.display = '';
            const chevron = document.getElementById('proposalSummaryChevron');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-up');
            }

            const labelMap = {
                individual: 'Individuals',
                company: 'Companies',
                government: 'Government',
                institution: 'Institutions',
                mixed: 'Mixed'
            };
            const formatNumber = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? Math.round(num).toLocaleString('hr-HR') : value;
            };

            const lines = [];
            if (overrideSummaryStats.individualOwners !== null && overrideSummaryStats.individualOwners !== undefined) {
                lines.push(`<p><strong>Individual owners:</strong> ${formatNumber(overrideSummaryStats.individualOwners)}</p>`);
            }
            const counts = overrideSummaryStats.ownershipCounts || {};
            const countEntries = Object.entries(counts).filter(([, value]) => value !== null && value !== undefined);
            if (countEntries.length) {
                const countText = countEntries
                    .map(([key, value]) => `${labelMap[key] || key}: ${formatNumber(value)}`)
                    .join(' • ');
                lines.push(`<p><strong>Ownership mix:</strong> ${countText}</p>`);
            }
            if (overrideSummaryStats.totalMarketPrice !== null && overrideSummaryStats.totalMarketPrice !== undefined) {
                lines.push(`<p><strong>Total market price:</strong> ${formatNumber(overrideSummaryStats.totalMarketPrice)} EUR</p>`);
            }
            if (overrideSummaryStats.totalAcquiringDifficulty !== null && overrideSummaryStats.totalAcquiringDifficulty !== undefined) {
                lines.push(`<p><strong>Acquiring difficulty:</strong> ${formatNumber(overrideSummaryStats.totalAcquiringDifficulty)}</p>`);
            }

            if (lines.length) {
                const statsBlock = document.createElement('div');
                statsBlock.className = 'proposal-summary-extra';
                statsBlock.style.marginTop = '8px';
                statsBlock.innerHTML = `
                    <div class="summary-stats">
                        <h4 style="margin: 6px 0 4px;">Ownership & Acquisition Stats</h4>
                        ${lines.join('')}
                    </div>
                `;
                summaryContent.appendChild(statsBlock);
            }
        }
    }

    // Pre-fill the offer amount with a random value between 1 and 1,000,000 EUR
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1;
        const maxOfferEur = 1000000;
        const randomOffer = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
        offerInput.value = window.formatProposalOfferValue(randomOffer);
    }

    // Apply user-provided defaults when available
    const authorInput = document.getElementById('proposalAuthor');
    if (authorInput && overridePrefill.author) {
        authorInput.value = overridePrefill.author;
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Pre-fill name and description with default text (facets already set it for a chosen goal;
    // this only fills the empty do-nothing default).
    updateProposalNameAndDescription(DEFAULT_PROPOSAL_TYPE);

    const nameInputEl = document.getElementById('proposalName');
    const descriptionInputEl = document.getElementById('proposalDescription');
    if (nameInputEl && overridePrefill.name) {
        nameInputEl.value = overridePrefill.name;
    }
    if (descriptionInputEl && overridePrefill.description) {
        descriptionInputEl.value = overridePrefill.description;
    }
    if (offerInput && Number.isFinite(overridePrefill.offer)) {
        offerInput.value = window.formatProposalOfferValue ? window.formatProposalOfferValue(overridePrefill.offer) : overridePrefill.offer;
    }

    // Restore the currency + the advanced Options toggles. Used by "Copy into new proposal" so a
    // fork starts from the source's terms, not the defaults. Each toggle drives its own enable
    // handler, so flip the checkbox first and then let that handler unlock the inputs.
    const currencySelectEl = document.getElementById('proposalCurrency');
    if (currencySelectEl && overridePrefill.offerCurrency) {
        currencySelectEl.value = overridePrefill.offerCurrency;
    }
    if (typeof overridePrefill.isConditional === 'boolean') {
        const conditionalCb = document.getElementById('proposalConditionalCheckbox');
        if (conditionalCb) {
            conditionalCb.checked = overridePrefill.isConditional;
            updateConditionalHelper();
        }
    }
    if (overridePrefill.expiryTime) {
        const expireCb = document.getElementById('proposalExpireCheckbox');
        const expiryInput = document.getElementById('proposalExpiryTime');
        if (expireCb && expiryInput) {
            expireCb.checked = true;
            if (typeof toggleExpiryInput === 'function') toggleExpiryInput();
            expiryInput.value = overridePrefill.expiryTime;
        }
    }
    if (overridePrefill.decayEnabled) {
        const decayCb = document.getElementById('proposalDecayCheckbox');
        if (decayCb) {
            decayCb.checked = true;
            if (typeof toggleDecayInput === 'function') toggleDecayInput();
            const decayPercentInput = document.getElementById('proposalDecayPercent');
            const decayTimeInput = document.getElementById('proposalDecayTime');
            if (decayPercentInput && Number.isFinite(overridePrefill.decayPercent)) decayPercentInput.value = overridePrefill.decayPercent;
            if (decayTimeInput && overridePrefill.decayTime) decayTimeInput.value = overridePrefill.decayTime;
        }
    }
    if (overridePrefill.depositEnabled) {
        const depositCb = document.getElementById('proposalDepositCheckbox');
        if (depositCb) {
            depositCb.checked = true;
            if (typeof toggleDepositInput === 'function') toggleDepositInput();
            const depositPercentInput = document.getElementById('proposalDepositPercent');
            if (depositPercentInput && Number.isFinite(overridePrefill.depositPercent)) depositPercentInput.value = overridePrefill.depositPercent;
        }
    }

    // If the prefill restored anything the user wouldn't otherwise see, open the collapsed
    // Options section — silently carrying non-default terms would be a nasty surprise.
    const restoredNonDefaultOptions = !!overridePrefill.expiryTime
        || !!overridePrefill.decayEnabled
        || !!overridePrefill.depositEnabled
        || overridePrefill.isConditional === false;
    if (restoredNonDefaultOptions) {
        const optionsHeader = document.querySelector('#proposalOptionsSection .collapsible-header');
        const optionsSection = document.getElementById('proposalOptionsSection');
        if (optionsHeader && optionsSection && optionsSection.classList.contains('collapsed')) {
            optionsHeader.click();
        }
    }

    // Update description when name changes
    const nameInputField = document.getElementById('proposalName');
    const descriptionInputField = document.getElementById('proposalDescription');
    if (nameInputField && descriptionInputField) {
        nameInputField.addEventListener('input', () => {
            const proposalType = document.getElementById('proposalType')?.value || DEFAULT_PROPOSAL_TYPE;
            const proposalName = nameInputField.value.trim() || generateDefaultProposalName(proposalType);
            descriptionInputField.value = generateDefaultProposalDescription(proposalType, proposalName);
        });
    }

    attachProposalCurrencyHandlers();

    // Focus the default Land use radio (not a text input) to avoid triggering mobile keyboards
    const defaultLandUseRadio = modal.querySelector('input[name="proposalLandUse"]:checked')
        || modal.querySelector('input[name="proposalLandUse"]');
    if (defaultLandUseRadio) {
        defaultLandUseRadio.focus();
    }

    updateCreateProposalSubmitState();

    // Show similar proposals for the selected parcel set
    const similarSection = document.getElementById('proposalSimilarSection');
    const similarList = document.getElementById('proposalSimilarList');
    if (similarSection && similarList && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getSimilarProposalsByParcelIds === 'function') {
        const similarProposals = proposalStorage.getSimilarProposalsByParcelIds(parcelIds);
        if (similarProposals && similarProposals.length > 0) {
            similarSection.style.display = '';
            const itemsHtml = similarProposals.map(p => {
                const proposalId = p.proposalId || '';
                const title = typeof escapeHtml === 'function' ? escapeHtml(p.title || similarUnknownTitle) : (p.title || similarUnknownTitle);
                const author = typeof escapeHtml === 'function' ? escapeHtml(p.author || similarUnknownAuthor) : (p.author || similarUnknownAuthor);
                const goalKey = resolveProposalGoalKey ? resolveProposalGoalKey(p, null) : (p.goal || p.type || 'other');
                const typeLabel = typeof formatProposalTypeLabel === 'function'
                    ? formatProposalTypeLabel(goalKey)
                    : (goalKey || '');
                const createdDate = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
                return `
                    <div class="proposal-similar-item" data-proposal-id="${proposalId}" style="display:flex; flex-direction:column; gap:2px; padding:8px; border:1px solid #ddd; border-radius:6px; cursor:pointer; background:#fafafa;">
                        <span style="font-weight:600;">${title}</span>
                        <span style="font-size:12px; color:#555;">${author}${createdDate ? ` • ${createdDate}` : ''}</span>
                        <span style="font-size:12px; color:#555;">${typeLabel}</span>
                    </div>
                `;
            }).join('');
            similarList.innerHTML = itemsHtml;
            similarList.querySelectorAll('.proposal-similar-item').forEach(item => {
                const proposalId = item.getAttribute('data-proposal-id');
                item.addEventListener('click', () => {
                    if (proposalId && typeof openProposalFromList === 'function') {
                        openProposalFromList(proposalId, {
                            closeProposalList: false,
                            closeParcelInfo: false,
                            collapseSidebar: false
                        });
                    }
                });
            });
        } else {
            similarSection.style.display = 'none';
        }
    }
}

function closeProposalDialog() {
    const closingDraftId = (typeof window !== 'undefined' && window.pendingProposalDraftId)
        ? String(window.pendingProposalDraftId)
        : null;
    clearProposalBalanceWatcher();
    // If this dialog seeded multi-select for its parcel context, disarm it — a cancelled
    // Propose must not leave the "Multiparcel selection" panel armed for later clicks.
    try { if (typeof window !== 'undefined') window.releaseEditorSeededMultiSelection?.(); } catch (_) { }
    const modal = document.querySelector('.create-proposal-modal');
    if (modal) {
        modal.remove();
    }
    currentProposalTool = null;
    proposalModalScreenshotDataUrl = null; // Clear stored screenshot
    proposalModalScreenshotPromise = null;
    // Drop the "Copy into new proposal" lineage once the dialog is gone. createProposal() has
    // already stamped it by this point (it closes the dialog only after building the proposal).
    if (typeof window !== 'undefined') {
        window.pendingProposalCopySource = null;
        if (closingDraftId && window.proposalDraftStore?.getDraft?.(closingDraftId)) {
            const draft = window.proposalDraftStore.getDraft(closingDraftId);
            if (draft.state !== 'publishing' && draft.state !== 'error') {
                window.proposalDraftStore.setDraftState(closingDraftId, 'review');
            }
        }
        window.pendingProposalDraftId = null;
        window.pendingProposalReplacementSource = null;
    }

    // If this was a road/track proposal, the multi-parcel selection was seeded just for the modal;
    // disable it now so we don't leave the UI stuck in multi-select mode.
    const wasRoadTrackProposal = !!pendingRoadDrawingProposal || !!(typeof window !== 'undefined' && window.pendingRoadDrawingProposal);
    if (wasRoadTrackProposal && typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.isActive) {
        try {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            multiParcelSelection.isActive = false;
            if (typeof multiParcelSelection.updateUI === 'function') {
                multiParcelSelection.updateUI();
            }
            if (typeof syncMultiSelectCheckboxes === 'function') {
                syncMultiSelectCheckboxes(false);
            }
        } catch (_) { /* ignore */ }
    }

    proposalDialogOverrides = null;
    pendingRoadDrawingProposal = null;
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = null;
    }
    setProposalModalDimmed(false);
    if (typeof setPendingBuildingProposalContext === 'function') {
        setPendingBuildingProposalContext(null);
    } else if (typeof window !== 'undefined') {
        window.pendingBuildingProposalContext = null;
        window.pendingBuildingFromBlockify = null;
    }
    if (typeof window !== 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    if (typeof clearSingleBuildingPendingState === 'function') {
        clearSingleBuildingPendingState();
    } else if (typeof window !== 'undefined') {
        window.pendingSingleBuildingFeature = null;
        window.pendingSingleBuildingFeatures = null;
    }
}

function showStructureProposalDialog({ kind, parcelIds, geometry, blockName }) {
    const t = getProposalI18nHelper();
    const parcelLookupError = t('modal.createProposal.errors.couldNotDetermineParcels', 'Could not determine parcels for this block.');
    const parcelsNotContiguous = t('modal.createProposal.errors.parcelsNotContiguous', 'Parcels not contiguous');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const validKind = (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square';
    const selectedParcels = (parcelIds || []).map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
    if (selectedParcels.length === 0) {
        updateStatus(parcelLookupError);
        return;
    }

    if (validKind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selectedParcels) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', parcelsNotContiguous);
            } else {
                updateStatus(parcelsNotContiguous);
            }
            return;
        }
    }

    const totalArea = selectedParcels.reduce((sum, layer) => sum + (layer?.feature?.properties?.calculatedArea || 0), 0);
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const parcelListHTML = selectedParcels.map(parcel => {
        const number = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, unknownParcelLabel) || unknownParcelLabel;
        const area = Math.round(parcel.feature?.properties?.calculatedArea || 0).toLocaleString('hr-HR');
        return `<div class="proposal-parcel-item"><span class="parcel-number">${parcelLabel} ${number}</span> <span class="parcel-area">(${area} m²)</span></div>`;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    const modalTitle = validKind === 'park'
        ? t('modal.createProposal.titlePark', 'Create Park Proposal')
        : validKind === 'square'
            ? t('modal.createProposal.titleSquare', 'Create Square Proposal')
            : t('modal.createProposal.titleLake', 'Create Lake Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const typeLabel = t('modal.createProposal.typeLabel', 'Type:');
    const typeDisplay = validKind === 'park'
        ? t('modal.createProposal.typePark', 'Park')
        : validKind === 'square'
            ? t('modal.createProposal.typeSquare', 'Square')
            : t('modal.createProposal.typeLake', 'Lake');
    const namePlaceholder = t('modal.createProposal.namePlaceholder', 'Name your {{kind}}', { kind: typeDisplay.toLowerCase() });
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholderStructure', 'Describe your {{kind}}...', { kind: typeDisplay.toLowerCase() });
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    const defaultName = generateStructureName(validKind);
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <div class="proposal-author-row">
                        <label for="proposalAuthor">${authorLabel}</label>
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                        <input type="text" id="proposalAuthor" placeholder="${authorPlaceholder}" disabled>
                    </div>
                </div>
                <div class="form-group">
                    <label for="proposalName">${nameLabel}</label>
                    <input type="text" id="proposalName" value="${defaultName}" placeholder="${namePlaceholder}">
                </div>
                <div class="form-group">
                    <label for="proposalType">${typeLabel}</label>
                    <input type="text" id="proposalType" value="${typeDisplay}" disabled>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <textarea id="proposalDescription" class="proposal-description-input" rows="2" placeholder="${descriptionPlaceholder}"></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>${optionsLabel}</label>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary">
                    <div class="summary-stats">
                        <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                        <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                    </div>
                    <div class="parcel-list">
                        <h4>${summarySelectedLabel}</h4>
                        ${parcelListHTML}
                    </div>
                </div>
                <div class="proposal-actions-block">
                    <div class="lens-inline-control lens-footer-control lens-footer-row">
                        <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                    </div>
                    <button type="button" class="btn btn-proposal" id="create-structure-proposal-btn">${submitLabel}</button>
                </div>
            </div>
        </div>`;

    document.body.appendChild(modal);
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }

    // Prefill author and random offer
    populateProposalAuthorUI();

    // Pre-fill description with default text
    const proposalTypeName = typeDisplay;
    updateProposalDescription(proposalTypeName);
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1000, maxOfferEur = 100000;
        offerInput.value = window.formatProposalOfferValue(Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur);
    }
    attachProposalCurrencyHandlers();
    document.getElementById('proposalName').focus();

    const confirmButton = document.getElementById('create-structure-proposal-btn');
    if (confirmButton) {
        confirmButton.addEventListener('click', () => {
            createStructureProposalFromDialog(
                validKind,
                Array.isArray(parcelIds) ? parcelIds : [],
                geometry || null,
                blockName || ''
            );
        });
    }
}

function showWalkUploadGateModal(options = {}) {
    try {
        if (typeof proposalStorage === 'undefined' || typeof showSimpleShareModal !== 'function') return null;
        const onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;

        const isUploaded = (proposal) => {
            try { return !!getSerialProposalId(proposal); } catch (_) { return false; }
        };

        const allApplied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        const initialNonUploaded = allApplied.filter(p => !isUploaded(p));
        if (initialNonUploaded.length === 0) {
            if (onComplete) { try { onComplete(); } catch (_) { } }
            return null;
        }

        const proposalsByKey = new Map();
        initialNonUploaded.forEach(p => {
            const key = (p && p.proposalId) ? String(p.proposalId) : getProposalKey(p);
            if (!key) return;
            proposalsByKey.set(String(key), p);
        });

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        const intro = document.createElement('div');
        intro.style.fontSize = '13px';
        intro.style.color = '#475569';
        intro.textContent = 'These applied proposals are not yet on the server. The walk view loads proposals by their server ID, so they need to be uploaded first. The dialog will close and the walk will start as soon as they all have a server ID.';
        container.appendChild(intro);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);
        const setStatus = (msg) => { statusLine.textContent = msg || ''; };

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '320px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.border = '1px solid #d8ddf0';
        listWrap.style.borderRadius = '8px';
        listWrap.style.padding = '8px';
        listWrap.style.background = '#f9fafb';
        container.appendChild(listWrap);

        const uploadAllRow = document.createElement('div');
        uploadAllRow.style.display = 'flex';
        uploadAllRow.style.justifyContent = 'flex-end';
        uploadAllRow.style.marginTop = '4px';
        const uploadAllBtn = document.createElement('button');
        uploadAllBtn.type = 'button';
        uploadAllBtn.className = 'btn share-modal-primary';
        uploadAllBtn.textContent = 'Upload all';
        uploadAllRow.appendChild(uploadAllBtn);
        container.appendChild(uploadAllRow);

        const modalApi = showSimpleShareModal({
            title: 'Upload before walking',
            body: container
        });

        const rowControls = new Map(); // key -> { row, uploadBtn }
        const rowState = new Map();    // key -> { uploading, uploaded }

        const checkAllUploaded = () => {
            const remaining = Array.from(rowState.values()).filter(s => !s.uploaded);
            if (remaining.length === 0) {
                if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                if (onComplete) {
                    try { onComplete(); } catch (e) { console.warn('walk gate onComplete failed', e); }
                }
            }
        };

        const updateRowVisual = (key) => {
            const ctrl = rowControls.get(key);
            const state = rowState.get(key) || {};
            if (!ctrl) return;
            if (state.uploaded) {
                ctrl.row.style.opacity = '0.55';
                ctrl.uploadBtn.disabled = true;
                ctrl.uploadBtn.textContent = 'Uploaded';
                return;
            }
            ctrl.uploadBtn.disabled = !!state.uploading;
            ctrl.uploadBtn.textContent = state.uploading ? 'Uploading…' : 'Upload';
        };

        const uploadOne = async (key) => {
            const proposal = proposalsByKey.get(key);
            if (!proposal) return false;
            const state = rowState.get(key) || {};
            if (state.uploading || state.uploaded) return !!state.uploaded;

            const gate = await ensureAncestorProposalsUploaded(proposal);
            if (!gate.ok) {
                const missingList = gate.missing.map(e => e.id || (e.hash ? e.hash.slice(0, 8) : '?')).filter(Boolean);
                setStatus(`Upload ancestor proposals first: ${missingList.join(', ')}`);
                return false;
            }

            rowState.set(key, { uploading: true, uploaded: false });
            updateRowVisual(key);
            try {
                const result = await uploadProposalToServer(proposal);
                if (!result || !result.ok) throw new Error((result && result.message) || 'Upload failed');
                const serverId = result.id ? String(result.id) : (result.proposalId ? String(result.proposalId) : null);
                if (!serverId || !/^\d+$/.test(serverId)) throw new Error('Server did not return a numeric id');
                rowState.set(key, { uploading: false, uploaded: true });
                updateRowVisual(key);
                setStatus('');
                return true;
            } catch (error) {
                console.error('walk gate upload failed', error);
                rowState.set(key, { uploading: false, uploaded: false });
                updateRowVisual(key);
                setStatus(error.message || 'Upload failed');
                return false;
            }
        };

        const renderRow = (key, proposal) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '6px 4px';
            row.style.borderBottom = '1px solid #e7e9f0';

            const left = document.createElement('div');
            left.style.flex = '1';
            left.style.minWidth = '0';
            const title = document.createElement('div');
            title.style.fontSize = '13px';
            title.style.fontWeight = '600';
            title.style.color = '#212744';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.style.whiteSpace = 'nowrap';
            title.textContent = proposal.name || proposal.title || (proposal.proposalId || key);
            left.appendChild(title);

            const meta = document.createElement('div');
            meta.style.fontSize = '11px';
            meta.style.color = '#64748b';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            left.appendChild(meta);

            const right = document.createElement('div');
            right.style.flexShrink = '0';
            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn share-modal-secondary';
            uploadBtn.textContent = 'Upload';
            uploadBtn.addEventListener('click', async () => {
                const ok = await uploadOne(key);
                if (ok) checkAllUploaded();
            });
            right.appendChild(uploadBtn);

            row.appendChild(left);
            row.appendChild(right);
            listWrap.appendChild(row);

            rowControls.set(key, { row, uploadBtn });
            rowState.set(key, { uploading: false, uploaded: false });
        };

        proposalsByKey.forEach((p, k) => renderRow(k, p));

        uploadAllBtn.addEventListener('click', async () => {
            uploadAllBtn.disabled = true;
            try {
                const pending = Array.from(rowState.entries())
                    .filter(([, s]) => !s.uploaded && !s.uploading)
                    .map(([k]) => k);
                for (const key of pending) {
                    if (!rowState.get(key).uploaded) await uploadOne(key);
                }
            } finally {
                uploadAllBtn.disabled = false;
            }
            checkAllUploaded();
        });

        return modalApi;
    } catch (error) {
        console.error('showWalkUploadGateModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to open upload dialog.', 5000, 'error');
        }
        return null;
    }
}

function appendModalBody(container, content) {
    if (!container || !content) return;
    if (content instanceof Node) {
        container.appendChild(content);
    } else if (typeof content === 'string') {
        const paragraph = document.createElement('p');
        paragraph.innerHTML = content;
        container.appendChild(paragraph);
    }
}
