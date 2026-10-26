// Freeform-building editing on the main map. Starts from a square footprint, then lets the user move the
// whole polygon, reshape its vertices, add vertices from edges, and rotate it in fixed steps.

(function () {
    let singleEditor = null;
    let singleSession = null;
    let singleUploadOnConfirm = null;
    let singleMap = null;
    let singleBlockLayer = null;
    let singleParcelBorderLayer = null;
    let singleRectGroup = null;
    let singleRectLayer = null;
    let singleActivePolygonLayer = null;
    let singlePolygonEditors = [];
    let singlePendingVertexActionIndex = null;
    let singleDragMarker = null; // legacy marker; not rendered anymore
    let singleBlockFeature = null; // starting site, retained as an optional placement guide
    let singleGroundBoundary = null;
    let singleHistory = null;
    let rectDragStartDesign = null;
    let rectDragHistoryRecorded = false;
    const singleBuildingLayers = new Map();
    let lastValidCenter = null; // LatLng of the last valid active-footprint centre
    let singleRectFeature = null;
    let rectDragActive = false;
    let rectDragStartPointerPt = null;
    let rectDragStartCenterPt = null;
    let rectDragStartFeature = null;
    let rectDragLastValidFeature = null;
    const EDIT_LOCK_OWNER = 'single-building';
    const EDIT_PANE = 'onMapEditorPane';
    const HANDLE_PANE = 'onMapEditorHandles';
    let dragMapHandlers = null;
    let singleGroundPreviewLayer = null;
    let singleGroundPreviewSuspended = false;
    let singleLandTakeReview = null;
    let singleBuildingSeedLandTake = null;

    // Rotation state
    let currentRotationDeg = 0; // current rotation in degrees

    // Surroundings: one treatment per proposal for the whole merged parcel area around the
    // buildings — sidewalk paving or grass, independently of the land-take choice. See building-ground.js.
    let currentGroundTreatment = 'paved';
    let currentGroundDecorationDesign = null;
    let singleBuildingSeedDecorationDesign = null;
    let singleBuildingSeedGroundTreatment = null;

    function buildingGroundApi() {
        return (typeof window !== 'undefined' && window.BuildingGround) ? window.BuildingGround : null;
    }

    function normalizeGroundTreatment(value) {
        const api = buildingGroundApi();
        return api ? api.normalizeTreatment(value) : 'paved';
    }

    // The polygon the proposal will pave or green: the block minus every building footprint on it.
    function currentGroundSurface() {
        const api = buildingGroundApi();
        if (!api) return null;
        const buildings = buildingEntries.filter(entry => entry?.feature).map(entry => entry.feature);
        return api.buildSurface(currentGroundTreatment, singleGroundBoundary || singleBlockFeature, buildings, currentGroundDecorationDesign);
    }

    function currentPlacementSite(buildings = null) {
        const features = buildings ? buildings.slice() : buildingEntries.filter(entry => entry?.feature).map(entry => entry.feature);
        if (singleLandTakeReview?.take) features.unshift(singleLandTakeReview.take);
        if (singleGroundBoundary) features.unshift(singleGroundBoundary);
        let combined = null;
        for (const feature of features) combined = combined ? turf.union(combined, feature) : cloneSingleFeature(feature);
        if (!combined?.geometry) return null;
        return combined.geometry.type === 'MultiPolygon' ? combined.geometry
            : { type: 'MultiPolygon', coordinates: [combined.geometry.coordinates] };
    }

    function captureSingleBuildingDesign() {
        return cloneSingleFeature({ buildings: buildingEntries, activeId: activeBuildingId,
            groundBoundary: singleGroundBoundary, groundTreatment: currentGroundTreatment, groundDecorationDesign: currentGroundDecorationDesign,
            landTake: singleLandTakeReview?.snapshot() || null });
    }

    function ensureSingleBuildingHistory() {
        if (!singleHistory) {
            singleHistory = window.GeometryEditHistory.create({
                capture: captureSingleBuildingDesign,
                restore(snapshot) {
                    buildingEntries = cloneSingleFeature(snapshot.buildings);
                    singleGroundBoundary = cloneSingleFeature(snapshot.groundBoundary);
                    currentGroundTreatment = snapshot.groundTreatment;
                    currentGroundDecorationDesign = snapshot.groundDecorationDesign || null;
                    singleLandTakeReview?.restore(snapshot.landTake);
                    setActiveBuilding(snapshot.activeId, { refreshUI: true });
                    const ground = document.getElementById('single-ground-treatment');
                    if (ground) ground.value = currentGroundTreatment;
                }
            });
            singleHistory.bindKeyboard(document, { enabled: () => singleSession?.active === true && !rectDragActive });
            singleHistory.bindButton(document.getElementById('single-building-undo'));
        }
        return singleHistory;
    }

    function resolveParcelId(feature) {
        if (!feature || typeof feature !== 'object') return null;
        try {
            if (typeof ensureParcelId === 'function') {
                const ensured = ensureParcelId(feature);
                if (ensured !== undefined && ensured !== null) return ensured.toString();
            }
        } catch (_) { }
        const props = feature.properties || {};
        const candidates = [props.parcelId];
        for (const candidate of candidates) {
            if (candidate !== undefined && candidate !== null) {
                try { return candidate.toString(); } catch (_) { return String(candidate); }
            }
        }
        return null;
    }

    // Initial square dimensions in metres. Once placed, its GeoJSON polygon is canonical; there are
    // deliberately no width, length, or chamfer parameters in the freeform editor.
    const DEFAULT_LENGTH_M = 20; // along Y; enough room between the initial vertex handles
    const DEFAULT_WIDTH_M = 20;  // along X
    const DEFAULT_HEIGHT_M = 10; // meters
    let currentHeightM = DEFAULT_HEIGHT_M;
    let singleBuildingOverrideContext = null;
    let buildingEntries = [];
    let activeBuildingId = null;
    let nextBuildingId = 1;
    // Buildings to restore when the editor next opens, instead of one default building. Set by
    // openSingleBuildingForParcels({ initialBuildings }); consumed once by showSingleBuildingMapEditor().
    let singleBuildingSeedBuildings = null;
    let singleBuildingSeedGroundBoundary = null;

    // Centre of a stored building feature, as a Leaflet LatLng. Position isn't in `parameters`,
    // so a fork has to recover it from the geometry.
    function featureCenterLatLng(feature) {
        try {
            if (typeof turf === 'undefined' || !turf || !feature || !feature.geometry) return null;
            const [lng, lat] = turf.centroid(feature).geometry.coordinates;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return L.latLng(lat, lng);
        } catch (_) {
            return null;
        }
    }
    const BUILDING_COLORS = ['#0d6efd', '#d63384', '#198754', '#fd7e14', '#20c997', '#6f42c1', '#0dcaf0', '#e83e8c'];

    const formatSingleBuildingText = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };

    const translateSingleBuildingText = (key, fallback, params = {}) => {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            { const translated = api.t(key, params); if (translated !== key) return translated; }
        }
        return formatSingleBuildingText(fallback, params);
    };

    const refreshSingleBuildingDensityStats = () => {
        const api = (typeof window !== 'undefined') ? window.BuildingDensityStats : null;
        const container = document.getElementById('single-building-density-stats');
        if (!api || !container || typeof turf === 'undefined') return;
        let stats = null;
        try {
            stats = api.summarizeDensity({
                parcelFeature: singleLandTakeReview?.take || singleBlockFeature,
                buildings: buildingEntries,
                turf,
                floorHeightM: 3,
                preferHeight: true
            });
        } catch (_) { }

        const setValue = (suffix, value) => {
            const element = document.getElementById(`single-building-density-${suffix}`);
            if (element) element.textContent = value;
        };
        const area = value => stats && Number.isFinite(value) ? CbFormat.formatArea(value) : '\u2014';
        setValue('parcel', stats?.parcelAreaM2 > 0 ? area(stats.parcelAreaM2) : '\u2014');
        setValue('footprint', stats ? area(stats.footprintAreaM2) : '\u2014');
        const summary = document.getElementById('single-building-footprint-summary');
        if (summary) summary.textContent = stats ? area(stats.footprintAreaM2) : '\u2014';
        setValue('coverage', stats?.parcelAreaM2 > 0 ? CbFormat.formatPercent(stats.siteCoveragePercent, { ofHundred: true, maxFractionDigits: 1, missing: '\u2014' }) : '\u2014');
        setValue('gbp', stats ? area(stats.aboveGroundGbpM2) : '\u2014');
        setValue('kin', stats?.parcelAreaM2 > 0 ? CbFormat.formatNumber(stats.kin, { maxFractionDigits: 3, missing: '\u2014' }) : '\u2014');

        const hint = document.getElementById('single-building-density-hint');
        if (hint) {
            const height = CbFormat.formatNumber(3, { maxFractionDigits: 1, minFractionDigits: 1 });
            hint.textContent = translateSingleBuildingText(
                'densityStats.floorHeightHint',
                'Calculated from the drawn footprints and height \u00f7 {{height}} m per storey.',
                { height }
            );
        }
    };

    const showSingleBuildingEditorAlert = (key, fallback) => {
        const message = translateSingleBuildingText(`modal.singleBuilding.${key}`, fallback);
        window.CbDialog.alert(message);
        return message;
    };

    const setSingleBuildingStatus = (key, fallback, params = {}) => {
        if (typeof updateStatus === 'function') {
            updateStatus(translateSingleBuildingText(`status.messages.${key}`, fallback, params));
        }
    };

    function pickBuildingColor(idx) {
        if (!BUILDING_COLORS.length) return '#0d6efd';
        return BUILDING_COLORS[idx % BUILDING_COLORS.length];
    }

    function getActiveBuilding() {
        return buildingEntries.find(b => b.id === activeBuildingId) || null;
    }

    function setActiveBuilding(buildingId, { refreshUI = true } = {}) {
        const target = buildingEntries.find(b => b.id === buildingId) || buildingEntries[0];
        if (!target) return;
        singlePendingVertexActionIndex = null;
        activeBuildingId = target.id;
        singleRectFeature = target.feature || null;
        lastValidCenter = target.lastValidCenter || null;
        currentHeightM = target.height;
        currentRotationDeg = target.rotation || 0;
        if (refreshUI) {
            syncSlidersFromActive();
            updateRectangleLayers();
        }
    }

    function syncSlidersFromActive() {
        const hEl = document.getElementById('single-height-slider');
        if (hEl) { hEl.value = currentHeightM; const v = document.getElementById('single-height-value'); if (v) v.textContent = CbFormat.formatNumber(Number(currentHeightM), { maxFractionDigits: 0, minFractionDigits: 0 }); }
    }

    function markAsEditablePolygon(feature, heightM, rotationDeg = 0) {
        if (!feature || !feature.geometry) return feature;
        feature.properties = { ...(feature.properties || {}) };
        delete feature.properties.width;
        delete feature.properties.length;
        delete feature.properties.chamfer;
        feature.properties.height = Math.max(3, Number(heightM) || DEFAULT_HEIGHT_M);
        feature.properties.rotation = Number(rotationDeg) || 0;
        feature.properties.footprintMode = 'polygon';
        feature.properties.type = 'proposedBuildingSingle';
        return feature;
    }

    function buildInitialBuildingFeature(centerLatLng, widthM, lengthM, heightM, rotationDeg = 0) {
        // The starting site is a guide, not a lock. Shrinking to a narrow parcel made the initial
        // handles overlap; imported dimensions must also survive placement unchanged.
        return markAsEditablePolygon(buildRectangleFeature(centerLatLng, widthM, lengthM, heightM, rotationDeg), heightM, rotationDeg);
    }

    function addNewBuildingEntry(centerLatLng, options = {}) {
        const placement = computeInitialPlacement(singleBlockFeature);
        const center = centerLatLng || placement.center;
        const width = Number(options.width) || placement.width || DEFAULT_WIDTH_M;
        const length = Number(options.length) || placement.length || DEFAULT_LENGTH_M;
        const height = Number(options.height) || DEFAULT_HEIGHT_M;
        const rotation = Number(options.rotation) || 0;
        let feature = null;
        if (options.feature && options.feature.geometry) {
            try { feature = JSON.parse(JSON.stringify(options.feature)); } catch (_) { feature = null; }
            markAsEditablePolygon(feature, height, rotation);
        } else {
            feature = buildInitialBuildingFeature(center, width, length, height, rotation);
        }
        if (!feature) return null;
        const id = nextBuildingId++;
        const savedName = String(options.name || feature.properties?.name || '').trim();
        const savedColor = options.color || feature.properties?.color || pickBuildingColor(buildingEntries.length);
        const entry = {
            id,
            name: savedName || translateSingleBuildingText('modal.singleBuilding.defaultName', 'Building'),
            color: savedColor,
            feature,
            height,
            rotation,
            lastValidCenter: featureCenterLatLng(feature) || center
        };
        buildingEntries.push(entry);
        activeBuildingId = id;
        return entry;
    }

    // Proposed building collection shares the same layer/array as blockify
    if (typeof window !== 'undefined') {
        try { if (!Array.isArray(window.proposedBuildings)) window.proposedBuildings = []; } catch (_) { }
    }

    function getSingleBuildingContext() {
        if (singleBuildingOverrideContext && Array.isArray(singleBuildingOverrideContext.parcels) && singleBuildingOverrideContext.parcels.length) {
            return singleBuildingOverrideContext;
        }
        if (typeof selectedBlockName === 'undefined' || !selectedBlockName) return null;
        if (typeof blockStorage === 'undefined' || !blockStorage || !blockStorage.blocks || !blockStorage.blocks.has(selectedBlockName)) return null;
        const blk = blockStorage.blocks.get(selectedBlockName);
        const parcelIds = Array.from(new Set((blk?.parcelIds || []).map(String).filter(Boolean)));
        const parcels = singleBuildingParcelsForIds(parcelIds);
        if (!parcelIds.length || parcels.length !== parcelIds.length) return null;
        return { blockName: selectedBlockName, parcels, parcelIds };
    }

    function describeSingleBuildingSelection(ids = []) {
        if (!ids || ids.length === 0) return 'Selected Parcels';
        if (ids.length === 1) return `Parcel ${ids[0]}`;
        return `${ids.length} Parcels`;
    }

    function singleBuildingParcelsForIds(parcelIds) {
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        return ids.map(id => {
            // Live parcels, or the synthetic design parcels of a site on bare ground
            // (js/site-drawing.js: the site as one superparcel, or plots cut along a frontage).
            const feature = (typeof window.resolveDesignParcelFeature === 'function'
                ? window.resolveDesignParcelFeature(id)
                : window.LiveParcelFabric?.get?.(id)) || null;
            return feature ? { id, feature } : null;
        }).filter(Boolean);
    }

    function getSelectedBlockFeature() {
        try {
            const context = getSingleBuildingContext();
            const authoredSite = context?.site;
            const siteGeometry = authoredSite?.type === 'Feature' ? authoredSite.geometry : authoredSite;
            if (['Polygon', 'MultiPolygon'].includes(siteGeometry?.type)) {
                return authoredSite?.type === 'Feature'
                    ? cloneSingleFeature(authoredSite)
                    : { type: 'Feature', properties: {}, geometry: cloneSingleFeature(siteGeometry) };
            }
            if (!context || !Array.isArray(context.parcels) || context.parcels.length === 0) return null;
            const parcelFeatures = context.parcels.map(p => p.feature);
            // Use robust union and reduce to largest polygon if available from building-blocks.js.
            // A union the clipper cannot do is a ClipFailure (footprint-geometry.js) and refuses
            // the site; it used to fall back to a sequential union that skipped the parcel that
            // threw, i.e. a site with a parcel silently missing.
            let unioned = robustUnion(parcelFeatures);
            if (!unioned) {
                // Fallback to manual union via turf.union sequentially
                let acc = parcelFeatures[0];
                for (let i = 1; i < parcelFeatures.length; i++) {
                    let merged = null;
                    try { merged = turf.union(acc, parcelFeatures[i]); } catch (error) {
                        throw singleBuildingClipFailure('union', error, 'single-building.selectedBlock', [acc, parcelFeatures[i]]);
                    }
                    if (!merged) throw singleBuildingClipFailure('union', new Error('union came back empty'), 'single-building.selectedBlock', [acc, parcelFeatures[i]]);
                    acc = merged;
                }
                unioned = acc;
            }
            try { unioned = toSingleLargestPolygon(unioned) || unioned; } catch (_) { }
            return unioned;
        } catch (error) {
            if (error && error.code === 'clip-failed') {
                console.error(`[${new Date().toISOString()}] [single-building] the selected parcels could not be merged into one site`, error);
                setSingleBuildingStatus('parcels_could_not_be_merged', 'Could not merge the selected parcels into one site: {{reason}}', { reason: error.message });
                throw error;
            }
            return null;
        }
    }

    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function singleBuildingClipFailure(operation, error, site, operands) {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        return api ? api.clipFailure(operation, error, { site }, operands) : error;
    }

    function ensureClosed(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return ring;
        const a = ring[0], b = ring[ring.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) {
            return [...ring, [a[0], a[1]]];
        }
        return ring;
    }

    function cloneSingleFeature(feature) {
        if (!feature) return null;
        try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
    }

    function featureWithGeometry(feature, geometry) {
        const next = cloneSingleFeature(feature);
        if (!next || !geometry) return null;
        next.geometry = geometry;
        return next;
    }

    function editableFootprintValid(feature) {
        try {
            if (!window.SingleBuildingGeometry.validFootprint(feature, turf)) return false;
            return !singleSession?.placement || singleSession.placement.accepts(feature);
        } catch (_) {
            return false;
        }
    }

    function setActiveFeature(feature, { updateCenter = true } = {}) {
        if (!feature?.geometry) return;
        const active = getActiveBuilding();
        markAsEditablePolygon(feature, active?.height ?? currentHeightM, active?.rotation ?? currentRotationDeg);
        singleRectFeature = feature;
        if (active) active.feature = feature;
        if (updateCenter) {
            const center = featureCenterLatLng(feature);
            if (center) {
                lastValidCenter = center;
                if (active) active.lastValidCenter = center;
            }
        }
    }

    function getSingleProjector() {
        const crs = (singleMap && singleMap.options && singleMap.options.crs) || L.CRS.EPSG3857;
        if (!crs || typeof crs.project !== 'function' || typeof crs.unproject !== 'function') return null;
        return {
            project: (ll) => {
                const p = crs.project(L.latLng(ll.lat, ll.lng));
                return [p.x, p.y];
            },
            unproject: (xy) => {
                const llOut = crs.unproject(L.point(xy[0], xy[1]));
                return [llOut.lat, llOut.lng];
            }
        };
    }

    function computeInitialPlacement(blockFeature) {
        const initialSquareSize = Math.max(DEFAULT_WIDTH_M, DEFAULT_LENGTH_M);
        if (!blockFeature) return { center: null, width: initialSquareSize, length: initialSquareSize };

        // Prefer a point on the selected land even for concave sites or courtyard holes.
        const [lng, lat] = turf.pointOnFeature(blockFeature).geometry.coordinates;
        return { center: L.latLng(lat, lng), width: initialSquareSize, length: initialSquareSize };
    }

    function singleBuildingPreview() {
        if (!singleEditor) return null;
        return {
            draftPreview: { kind: 'buildings', features: buildingEntries.map(entry => cloneSingleFeature(entry.feature)).filter(Boolean) },
            boundary: cloneSingleFeature(singleBlockFeature),
            groundSurface: currentGroundSurface(),
            ...(singleLandTakeReview?.preview || {})
        };
    }

    function updateSingleBuildingPreview() {
        refreshSingleBuildingDensityStats();
        singleSession?.setPreview(singleBuildingPreview());
        singleLandTakeReview?.schedule();
        positionSingleBuildingToolbar();
    }

    function positionSingleBuildingToolbar() {
        let center = featureCenterLatLng(singleRectFeature);
        if (center && !window.isThreeModeActive?.()) {
            // Put rotation controls beyond the footprint, leaving its lower vertex handles free.
            const [west, south, east] = turf.bbox(singleRectFeature);
            center = { lat: south, lng: (west + east) / 2 };
        }
        singleSession?.setAnchor(center ? { lat: center.lat, lng: center.lng, height: currentHeightM } : null);
    }

    function syncSingleBuildingView() {
        if (!singleEditor) return;
        renderSharedPolygonEditor();
        updateSingleBuildingPreview();
    }

    function tryStartDragFromMap(event) {
        if (!singleSession?.active) return;
        if (event?.latlng && pointInsideRect(event.latlng)) handleRectDragStart(event);
    }

    function buildRectangleFeature(centerLatLng, widthM, lengthM, heightM, rotationDeg = 0) {
        // Built in ground metres in a frame on its centre (single-building-geometry.js, tested).
        const ring = window.SingleBuildingGeometry.buildRectangleRing(
            { lat: centerLatLng.lat, lng: centerLatLng.lng },
            { widthM, lengthM, rotationDeg }
        );
        if (!ring) throw new Error('single-building: the rectangle could not be built');

        const closed = ensureClosed(ring);

        const context = getSingleBuildingContext();
        const blockLabel = context && context.blockName ? context.blockName : null;

        return {
            type: 'Feature',
            properties: {
                type: 'proposedBuildingSingle',
                width: widthM,
                length: lengthM,
                height: heightM || DEFAULT_HEIGHT_M,
                rotation: rotationDeg || 0,
                block: blockLabel
            },
            geometry: { type: 'Polygon', coordinates: [closed] }
        };
    }

    function bindRectangleLayerEvents() {
        if (!singleRectLayer) return;
        singleRectLayer.off('mousedown', handleRectDragStart);
        singleRectLayer.off('touchstart', handleRectDragStart);
        singleRectLayer.on('mousedown', handleRectDragStart);
        singleRectLayer.on('touchstart', handleRectDragStart);
        singleRectLayer.eachLayer(layer => {
            layer.off('mousedown', handleRectDragStart);
            layer.off('touchstart', handleRectDragStart);
            layer.on('mousedown', handleRectDragStart);
            layer.on('touchstart', handleRectDragStart);
            try { layer.bringToFront(); } catch (_) { }
        });
    }

    function autosaveSingleBuildingDraft() {
        const activeDraft = window.getActiveProposalDesignDraft?.();
        const context = getSingleBuildingContext();
        if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
            || !context?.parcels?.length || !buildingEntries.some(entry => entry?.feature)
            || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
        const parcelIds = [];
        const parentDetails = [];
        context.parcels.forEach(parcel => {
            let parcelId = null;
            try { parcelId = resolveParcelId(parcel?.feature); } catch (_) { }
            if (!parcelId) return;
            const id = String(parcelId);
            if (/^site(-plot)?:/.test(id)) return;
            parcelIds.push(id);
            parentDetails.push({ id, number: String(parcel?.feature?.properties?.BROJ_CESTICE || id) });
        });
        const buildings = buildingEntries.filter(entry => entry?.feature).map(entry => {
            const feature = JSON.parse(JSON.stringify(entry.feature));
            feature.properties = {
                ...(feature.properties || {}),
                height: Math.max(3, Number(entry.height) || DEFAULT_HEIGHT_M),
                rotation: Number(entry.rotation) || 0,
                footprintMode: 'polygon',
                type: 'proposedBuildingSingle'
            };
            delete feature.properties.width;
            delete feature.properties.length;
            delete feature.properties.chamfer;
            return feature;
        });
        window.syncActiveProposalDraftFromEditor('building', {
            parcelIds,
            parentDetails,
            blockName: context.blockName || describeSingleBuildingSelection(parcelIds),
            parameters: {
                typology: 'single',
                height: buildings[0]?.properties?.height ?? null,
                rotation: buildings[0]?.properties?.rotation ?? null,
                footprintMode: 'polygon'
            },
            buildingFeature: buildings[0] || null,
            buildings,
            groundSurface: currentGroundSurface(),
            groundBoundary: cloneSingleFeature(singleGroundBoundary),
            landTake: cloneSingleFeature(singleLandTakeReview?.take),
            placement: { site: currentPlacementSite(), free: true }
        }, { coalesceKey: 'single-building-live' });
    }

    function updateRectangleLayers() {
        if (!singleMap || !buildingEntries.length) return;
        if (!singleRectGroup) {
            singleRectGroup = L.featureGroup().addTo(singleMap);
        } else {
            singleRectGroup.clearLayers();
        }
        singleRectLayer = null;
        singleActivePolygonLayer = null;
        singleBuildingLayers.clear();

        buildingEntries.forEach(entry => {
            if (!entry.feature) return;
            const isActive = entry.id === activeBuildingId;
            const layer = L.geoJSON(entry.feature, {
                pane: EDIT_PANE,
                style: {
                    color: entry.color,
                    weight: isActive ? 3 : 2,
                    fillColor: entry.color,
                    fillOpacity: isActive ? 0.4 : 0.2,
                    className: isActive ? 'single-building-fill single-building-fill--active'
                        : 'single-building-fill single-building-fill--selectable'
                },
                // Every footprint is interactive: the active one drags, the rest select on click.
                interactive: true,
                bubblingMouseEvents: false
            }).addTo(singleRectGroup);
            singleBuildingLayers.set(entry.id, layer);
            if (isActive) {
                singleRectLayer = layer;
                layer.eachLayer(polygonLayer => {
                    if (!singleActivePolygonLayer && typeof polygonLayer.setLatLngs === 'function') {
                        singleActivePolygonLayer = polygonLayer;
                    }
                });
            } else {
                // Click an imported footprint on the map to select it for editing.
                const selectThisBuilding = (e) => {
                    if (e && e.originalEvent && L.DomEvent) L.DomEvent.stop(e.originalEvent);
                    setActiveBuilding(entry.id, { refreshUI: true });
                };
                layer.on('click', selectThisBuilding);
                layer.eachLayer(subLayer => subLayer.on('click', selectThisBuilding));
            }

            if (entry.name) {
                layer.bindTooltip(entry.name, {
                    permanent: true,
                    direction: 'center',
                    className: 'single-building-label-tooltip',
                    opacity: 0.9
                });
            }
        });

        if (singleParcelBorderLayer) {
            try { singleParcelBorderLayer.bringToFront(); } catch (_) { }
        }
        try { singleRectGroup.bringToFront(); } catch (_) { }
        updateGroundPreview();
        bindRectangleLayerEvents();
        renderSharedPolygonEditor();
        syncRotationButtons();
        autosaveSingleBuildingDraft();
        singleSession?.placement?.update(currentPlacementSite());
        updateSingleBuildingPreview();
    }

    // Paint the surroundings the proposal would create, under the footprints, so the choice is
    // visible while placing rather than only after applying.
    function updateGroundPreview() {
        if (!singleMap) return;
        if (singleGroundPreviewLayer) {
            try { singleMap.removeLayer(singleGroundPreviewLayer); } catch (_) { }
            singleGroundPreviewLayer = null;
        }
        // The surroundings child editor owns the only live copy while it is open. Land-take
        // review can finish asynchronously during that time, so clearing once on open is not
        // enough: its refresh must not recreate the parent preview underneath editable furniture.
        if (singleGroundPreviewSuspended) return;
        // The preview only degrades (no paint) when the surround cannot be cut; saving the proposal
        // computes the same surface and refuses on the same failure.
        let surface = null;
        try { surface = currentGroundSurface(); } catch (error) {
            if (!error || error.code !== 'clip-failed') throw error;
            (window.__parcelArrangement || null)?.reportClipFailure('difference', error, { site: 'single-building.groundPreview' }, []);
            return;
        }
        const edit = document.getElementById('single-ground-treatment-edit');
        if (edit) edit.disabled = !surface;
        const style = surface ? buildingGroundApi()?.SURFACE_STYLE_2D[surface.treatment] : null;
        if (!surface || !style) return;
        try {
            singleGroundPreviewLayer = L.featureGroup().addTo(singleMap);
            window.drawBuildingGroundSurface(singleGroundPreviewLayer, surface, EDIT_PANE);
            singleGroundPreviewLayer.bringToBack();
        } catch (error) {
            console.warn('[single-building] ground preview failed', error);
        }
    }

    // A reviewed take updates land-dependent previews without replacing authored ground surroundings.
    function refreshSingleLandTakePreview() {
        updateGroundPreview();
        refreshSingleBuildingDensityStats();
        singleSession?.placement?.update(currentPlacementSite());
        singleSession?.setPreview(singleBuildingPreview());
        autosaveSingleBuildingDraft();
    }

    function destroySinglePolygonEditor() {
        singlePolygonEditors.forEach(editor => editor.destroy());
        singlePolygonEditors = [];
    }

    function commitSharedPolygonRing(ring, polygonIndex, ringIndex) {
        const candidate = window.SingleBuildingGeometry.withFootprintRing(singleRectFeature, polygonIndex, ringIndex, ring);
        if (!candidate || !editableFootprintValid(candidate)) {
            // The shared handle followed the pointer freely. Only now, on release, restore the last
            // valid footprint if any ring crosses itself or violates an explicitly locked site.
            updateRectangleLayers();
            return false;
        }
        if (JSON.stringify(candidate.geometry) !== JSON.stringify(singleRectFeature.geometry)) ensureSingleBuildingHistory().record();
        setActiveFeature(candidate);
        updateRectangleLayers();
        return true;
    }

    function importedBuildingFeatures(data) {
        return window.PolygonGeometryEditor.polygonFeaturesFromGeoJSON(data).map(feature => {
            if (!window.SingleBuildingGeometry.validFootprint(feature, turf)) throw new Error('Invalid building footprint.');
            return markAsEditablePolygon(feature,
                window.SingleBuildingGeometry.importedHeight(feature.properties, currentHeightM || DEFAULT_HEIGHT_M), 0);
        });
    }

    // Import into the selected footprint without ending the current design or dropping its siblings.
    function useUploadedBuildingModel({ width, length, height, footprint, modelName, modelUrl }) {
        const active = getActiveBuilding();
        if (!singleEditor || !active || ![width, length, height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return false;
        const center = featureCenterLatLng(active.feature);
        const feature = window.SingleBuildingGeometry.placeModelFootprint(footprint, center, active.rotation);
        if (feature) markAsEditablePolygon(feature, height, active.rotation);
        if (!editableFootprintValid(feature)) {
            showSingleBuildingEditorAlert('uploadInvalid', 'The uploaded geometry is invalid or outside the locked site.');
            return false;
        }
        feature.properties.source = 'upload';
        if (modelName) feature.properties.modelName = String(modelName).slice(0, 120);
        if (modelUrl) feature.properties.modelUrl = String(modelUrl);
        ensureSingleBuildingHistory().record();
        active.feature = feature;
        active.height = feature.properties.height;
        active.lastValidCenter = center;
        setActiveBuilding(active.id);
        autosaveSingleBuildingDraft();
        return true;
    }

    async function openSingleBuildingModelUpload() {
        const session = singleSession;
        if (!session || !window.BuildingUpload) return;
        await window.BuildingUpload.open({}, {
            onUse: model => singleSession === session && useUploadedBuildingModel(model)
        });
    }

    function loadSingleBuildingGeoJSON(file) {
        if (!file || !window.PolygonGeometryEditor) return;
        const reader = new FileReader();
        reader.onload = () => {
            let features;
            try {
                features = importedBuildingFeatures(JSON.parse(reader.result));
                if (features.some(feature => !editableFootprintValid(feature))) throw new Error('Footprint outside locked site.');
            } catch (error) {
                console.error('Freeform-building GeoJSON import failed', error);
                showSingleBuildingEditorAlert('uploadInvalid', 'The uploaded geometry is invalid or outside the locked site.');
                return;
            }
            ensureSingleBuildingHistory().record();
            const activeIndex = buildingEntries.findIndex(entry => entry.id === activeBuildingId);
            const imported = features.map(feature => addNewBuildingEntry(featureCenterLatLng(feature), {
                feature, height: feature.properties.height, name: feature.properties.name, rotation: 0
            }));
            // Replace the selected footprint, keeping the other authored buildings. A collection
            // adds all its buildings; Done saves each as its own ordinary Freeform proposal.
            buildingEntries.splice(activeIndex, 1);
            setActiveBuilding(imported[0].id);
            singleSession?.fitFeature({ type: 'FeatureCollection', features });
        };
        reader.onerror = () => showSingleBuildingEditorAlert('uploadError', 'Could not read that file.');
        reader.readAsText(file);
    }

    // Fixed footprints uploaded from a rule use the ordinary Freeform editor. The same design
    // session continues, so X/Esc still discards and Done still follows the ordinary edit policy.
    function openFreeformGeoJSONBuildings(data, { closeSource, blockName } = {}) {
        const features = importedBuildingFeatures(data);
        const site = features.reduce((combined, feature) => combined ? turf.union(combined, feature) : feature, null).geometry;
        const result = window.stageActiveFreeformBuildings({ buildings: [{
            building: features[0], site: cloneSingleFeature(features[0].geometry)
        }] });
        if (!result.ok) throw new Error(result.reason);
        closeSource();
        return openSingleBuildingForParcels({ blockName, parcelIds: [], site, initialBuildings: features });
    }

    function renderSharedPolygonEditor() {
        const selection = singlePendingVertexActionIndex;
        singlePendingVertexActionIndex = null;
        destroySinglePolygonEditor();
        if (!singleMap || !singleRectFeature?.geometry || window.__mapModeState?.desired === 'model' || window.__mapModeState?.desired === 'photo') return;
        if (!window.PolygonGeometryEditor || typeof window.PolygonGeometryEditor.create !== 'function') {
            console.error('Shared polygon geometry editor is unavailable.');
            return;
        }
        const geometry = singleRectFeature.geometry;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        polygons.forEach((rings, polygonIndex) => rings.forEach((ring, ringIndex) => {
            const selected = selection?.polygonIndex === polygonIndex && selection?.ringIndex === ringIndex;
            singlePolygonEditors.push(window.PolygonGeometryEditor.create({
                map: singleMap,
                pane: HANDLE_PANE,
                leaflet: L,
                turf,
                ring,
                boundary: () => singleSession?.placement?.locked ? singleBlockFeature : null,
                snapCoordinate: (coordinate, event) => singleSession.placement.snapCoordinate(coordinate, event),
                undo: false,
                initialSelectedVertexIndex: selected ? selection.vertexIndex : null,
                showInitialDeleteAction: selected,
                vertexTitle: translateSingleBuildingText('modal.singleBuilding.vertexLabel', 'Drag to reshape'),
                deleteTitle: translateSingleBuildingText('modal.singleBuilding.deleteVertexLabel', 'Delete selected vertex'),
                onCommit: ({ ring: committedRing, reason, vertexIndex }) => {
                    singlePendingVertexActionIndex = reason === 'move' ? { polygonIndex, ringIndex, vertexIndex } : null;
                    const committed = commitSharedPolygonRing(committedRing, polygonIndex, ringIndex);
                    // A normal commit consumes this synchronously while recreating the editor. If a host
                    // update exits early, do not let a stale selection leak into a later redraw.
                    singlePendingVertexActionIndex = null;
                    return committed;
                }
            }));
        }));
    }

    function rotatedFootprintCandidate(deltaDeg) {
        const active = getActiveBuilding();
        if (!active?.feature?.geometry) return null;
        const geometry = window.SingleBuildingGeometry.rotateGeometry(active.feature.geometry, deltaDeg);
        const candidate = featureWithGeometry(active.feature, geometry);
        return candidate && editableFootprintValid(candidate) ? candidate : null;
    }

    function syncRotationButtons() {
        const counterclockwise = document.getElementById('single-rotate-counterclockwise');
        const clockwise = document.getElementById('single-rotate-clockwise');
        if (counterclockwise) counterclockwise.disabled = !rotatedFootprintCandidate(5);
        if (clockwise) clockwise.disabled = !rotatedFootprintCandidate(-5);
    }

    function rotateActiveFootprint(deltaDeg) {
        const active = getActiveBuilding();
        const candidate = rotatedFootprintCandidate(deltaDeg);
        if (!active || !candidate) return;
        ensureSingleBuildingHistory().record();
        singlePendingVertexActionIndex = null;
        const nextRotation = ((Number(active.rotation || 0) + deltaDeg) % 360 + 360) % 360;
        active.rotation = nextRotation;
        currentRotationDeg = nextRotation;
        candidate.properties = { ...(candidate.properties || {}), rotation: nextRotation };
        setActiveFeature(candidate);
        updateRectangleLayers();
    }

    function pointInsideRect(latlng) {
        if (!singleRectFeature || !latlng) return false;
        try {
            const pt = turf.point([latlng.lng, latlng.lat]);
            return turf.booleanPointInPolygon(pt, singleRectFeature);
        } catch (_) {
            return false;
        }
    }

    function handleRectDragEnd() {
        const wasActive = rectDragActive;
        const finalFeature = rectDragLastValidFeature || rectDragStartFeature;
        if (rectDragHistoryRecorded && JSON.stringify(captureSingleBuildingDesign()) === JSON.stringify(rectDragStartDesign)) {
            singleHistory?.discardLast();
        }
        rectDragStartDesign = null;
        rectDragHistoryRecorded = false;
        rectDragActive = false;
        rectDragStartPointerPt = null;
        rectDragStartCenterPt = null;
        rectDragStartFeature = null;
        rectDragLastValidFeature = null;

        if (singleMap) {
            singleMap.off('mousemove', handleRectDragMove);
            singleMap.off('touchmove', handleRectDragMove);
            singleMap.off('mouseup', handleRectDragEnd);
            singleMap.off('touchend', handleRectDragEnd);
            if (wasActive && dragMapHandlers) {
                Object.entries(dragMapHandlers).forEach(([name, enabled]) => {
                    if (enabled) singleMap[name]?.enable();
                });
            }
            dragMapHandlers = null;
        }
        document.removeEventListener('mouseup', handleRectDragEnd);
        document.removeEventListener('touchend', handleRectDragEnd);

        if (wasActive && finalFeature) {
            setActiveFeature(finalFeature);
            updateRectangleLayers();
        }
        bindRectangleLayerEvents();
    }

    function handleRectDragMove(e) {
        if (!rectDragActive || !rectDragStartPointerPt || !rectDragStartCenterPt) return;
        if (!e || !e.latlng) return;

        const currentPt = singleMap.latLngToLayerPoint(e.latlng);
        const delta = currentPt.subtract(rectDragStartPointerPt);
        const newCenterPt = rectDragStartCenterPt.add(delta);
        const newCenter = singleMap.layerPointToLatLng(newCenterPt);
        const startCenter = singleMap.layerPointToLatLng(rectDragStartCenterPt);
        if (!rectDragStartFeature?.geometry) return;
        // Move only the active footprint; surroundings and their furniture stay on their ground.
        if (Math.abs(delta.x) + Math.abs(delta.y) < 1 && !rectDragHistoryRecorded) return;
        const target = singleSession.placement.moveTarget(rectDragStartFeature.geometry, startCenter, newCenter, e);
        const geometry = window.SingleBuildingGeometry.moveGeometry(rectDragStartFeature.geometry, startCenter, target);
        const candidate = featureWithGeometry(rectDragStartFeature, geometry);
        if (!candidate || !editableFootprintValid(candidate)) return;
        const movedEntries = rectDragStartDesign.buildings.map(entry => {
            if (entry.id !== activeBuildingId) return cloneSingleFeature(entry);
            const moved = cloneSingleFeature(entry);
            moved.feature.geometry = window.SingleBuildingGeometry.moveGeometry(entry.feature.geometry, startCenter, target);
            moved.lastValidCenter = featureCenterLatLng(moved.feature);
            return moved;
        });
        if (movedEntries.some(entry => !singleSession.placement.accepts(entry.feature))) return;
        if (!rectDragHistoryRecorded) {
            ensureSingleBuildingHistory().record();
            rectDragHistoryRecorded = true;
        }
        buildingEntries = movedEntries;
        rectDragLastValidFeature = candidate;
        setActiveFeature(candidate);
        buildingEntries.forEach(entry => {
            const layer = singleBuildingLayers.get(entry.id);
            layer?.eachLayer(polygon => {
                if (typeof polygon.setLatLngs !== 'function') return;
                const convert = coordinates => typeof coordinates[0] === 'number'
                    ? L.latLng(coordinates[1], coordinates[0]) : coordinates.map(convert);
                polygon.setLatLngs(convert(entry.feature.geometry.coordinates));
            });
            const center = featureCenterLatLng(entry.feature);
            if (center) layer?.getTooltip?.()?.setLatLng(center);
        });
        updateGroundPreview();
        singleSession.placement.update(currentPlacementSite());
        updateSingleBuildingPreview();
        if (singleDragMarker) {
            try { singleDragMarker.setLatLng(newCenter); } catch (_) { }
        }
    }

    function handleRectDragStart(e) {
        if (!singleMap || !singleBlockFeature || !e || !e.latlng) return;
        if (rectDragActive) return;
        const originalTarget = e.originalEvent && e.originalEvent.target;
        if (originalTarget && typeof originalTarget.closest === 'function'
            && originalTarget.closest('.polygon-geometry-editor__vertex, .polygon-geometry-editor__delete-marker')) return;
        // Only start a building drag when the touch is over the active building; otherwise let the map pan.
        if (!pointInsideRect(e.latlng)) return;
        singlePendingVertexActionIndex = null;
        try {
            if (e.originalEvent) {
                // Stop Leaflet's map drag from starting on this touch
                L.DomEvent.stop(e.originalEvent);
            } else {
                L.DomEvent.stop(e);
            }
        } catch (_) { }
        const centerLL = lastValidCenter
            || (singleDragMarker && typeof singleDragMarker.getLatLng === 'function' ? singleDragMarker.getLatLng() : null)
            || e.latlng;
        rectDragStartCenterPt = singleMap.latLngToLayerPoint(centerLL);
        rectDragStartPointerPt = singleMap.latLngToLayerPoint(e.latlng);
        rectDragStartDesign = captureSingleBuildingDesign();
        rectDragHistoryRecorded = false;
        rectDragStartFeature = cloneSingleFeature(singleRectFeature);
        rectDragLastValidFeature = cloneSingleFeature(singleRectFeature);
        rectDragActive = true;
        destroySinglePolygonEditor();

        dragMapHandlers = Object.fromEntries(['dragging', 'boxZoom', 'doubleClickZoom']
            .map(name => [name, singleMap[name]?.enabled() === true]));
        try { singleMap.dragging.disable(); } catch (_) { }
        try { if (singleMap.boxZoom) singleMap.boxZoom.disable(); } catch (_) { }
        try { if (singleMap.doubleClickZoom) singleMap.doubleClickZoom.disable(); } catch (_) { }
        if (e.originalEvent && typeof e.originalEvent.preventDefault === 'function') {
            e.originalEvent.preventDefault();
        }
        try { L.DomEvent.stopPropagation(e); } catch (_) { }

        singleMap.on('mousemove', handleRectDragMove);
        singleMap.on('touchmove', handleRectDragMove);
        singleMap.on('mouseup', handleRectDragEnd);
        singleMap.on('touchend', handleRectDragEnd);
        document.addEventListener('mouseup', handleRectDragEnd);
        document.addEventListener('touchend', handleRectDragEnd);
    }

    function getBlockCentroid(blockFeature) {
        try {
            const c = turf.centroid(blockFeature);
            const [lng, lat] = c.geometry.coordinates;
            return L.latLng(lat, lng);
        } catch (_) {
            // fallback: use bounds center
            try {
                const layer = L.geoJSON(blockFeature);
                const b = layer.getBounds().getCenter();
                return L.latLng(b.lat, b.lng);
            } catch (__) { return map.getCenter(); }
        }
    }

    function drawBlockOnMap(blockFeature) {
        if (singleBlockLayer) {
            singleMap.removeLayer(singleBlockLayer);
            singleBlockLayer = null;
        }
        if (singleParcelBorderLayer) {
            try { singleMap.removeLayer(singleParcelBorderLayer); } catch (_) { }
            singleParcelBorderLayer = null;
        }
        singleMap.invalidateSize({ pan: false });

        // Draw parcel outline only (no fill)
        singleParcelBorderLayer = L.geoJSON(blockFeature, {
            pane: EDIT_PANE,
            style: { color: '#e53935', weight: 2, fillOpacity: 0, opacity: 1 },
            interactive: false
        }).addTo(singleMap);
    }

    function clearSingleBuildingPendingState() {
        singleBuildingOverrideContext = null;
    }

    // The X / Esc path. Closing NEVER saves — only "Done" (confirmSingleBuilding) does. When the
    // editor is running a commit-on-confirm session (a geometry edit, or a Build-palette creation)
    // the design would be lost, so ask first; declining keeps the editor open.
    // Did the user change the design since the dialog opened? Untouched → close without asking.
    let singleBuildingDesignChangeTracker = null;
    function singleBuildingDesignChanges() {
        if (!singleBuildingDesignChangeTracker) {
            singleBuildingDesignChangeTracker = window.DesignChangeTracker.createDesignChangeTracker({
                signature: () => window.DesignChangeTracker.featuresSignature(
                    buildingEntries.map(entry => entry && entry.feature)) + '|' + currentGroundTreatment + '|' + (singleLandTakeReview?.changeSignature || '') + '|' + JSON.stringify(currentGroundDecorationDesign)
            });
        }
        return singleBuildingDesignChangeTracker;
    }

    async function requestCloseSingleBuildingMapEditor() {
        if (typeof window !== 'undefined' && typeof window.confirmDiscardProposalDesignSession === 'function') {
            const proceed = await window.confirmDiscardProposalDesignSession({
                hasDesign: buildingEntries.some(entry => entry && entry.feature) && singleBuildingDesignChanges().changed()
            });
            if (!proceed) return;
        }
        closeSingleBuildingMapEditor();
    }

    // Pure teardown: the design is committed (or not) by the caller — "Done" saves first,
    // X/Esc discards the design session first.
    function closeSingleBuildingMapEditor(options = {}) {
        const { preservePending = false } = options;
        if (singleBuildingDesignChangeTracker) singleBuildingDesignChangeTracker.stop();
        singleLandTakeReview?.destroy();
        singleLandTakeReview = null;
        handleRectDragEnd();
        singlePendingVertexActionIndex = null;
        destroySinglePolygonEditor();
        if (singleMap) {
            if (singleBlockLayer) try { singleMap.removeLayer(singleBlockLayer); } catch (_) { }
            if (singleParcelBorderLayer) try { singleMap.removeLayer(singleParcelBorderLayer); } catch (_) { }
            if (singleRectGroup) try { singleMap.removeLayer(singleRectGroup); } catch (_) { }
            if (singleGroundPreviewLayer) try { singleMap.removeLayer(singleGroundPreviewLayer); } catch (_) { }
            singleGroundPreviewLayer = null;
            singleRectGroup = null;
            singleRectLayer = null;
            singleActivePolygonLayer = null;
            singleMap.off('mousedown', tryStartDragFromMap);
            singleMap.off('touchstart', tryStartDragFromMap);
            singleMap = null;
            singleBlockLayer = null;
            singleParcelBorderLayer = null;
            singleDragMarker = null;
        }
        singleBlockFeature = null;
        singleGroundBoundary = null;
        singleGroundPreviewSuspended = false;
        singleBuildingLayers.clear();
        singleHistory?.destroy();
        singleHistory = null;
        singleRectFeature = null;
        currentRotationDeg = 0;
        currentGroundTreatment = 'paved';
        currentGroundDecorationDesign = null;
        if (!preservePending) {
            clearSingleBuildingPendingState();
        }

        singleEditor = null;
        singleUploadOnConfirm = null;
        singleSession?.close();
        singleSession = null;
        if (typeof window !== 'undefined') {
            // Only "Done" commits — it tears down with preservePending after saving. Every other
            // close abandons the design session, leaving the edited object exactly as it was.
            if (!preservePending) window.discardProposalDraftDesignSession?.();
            window.finishProposalDraftDesignSession?.();
        }
    }

    async function confirmSingleBuilding() {
        if (!singleLandTakeReview || !(await singleLandTakeReview.prepare())) return;
        const active = getActiveBuilding();
        const hasAnyBuilding = buildingEntries.some(b => b && b.feature);
        if (!active || !hasAnyBuilding) {
            setSingleBuildingStatus('draw_the_single_building_inside_the_selected_block_first', 'Draw the building inside the selected block first.');
            return;
        }

        const context = getSingleBuildingContext();
        if (!context || !Array.isArray(context.parcels) || context.parcels.length === 0) {
            setSingleBuildingStatus('select_a_parcel_block_before_creating_a_proposal', 'Select a parcel block before creating a proposal.');
            return;
        }

        const block = { parcels: context.parcels };
        const blockParcelIds = block.parcels.map(parcel => {
            try {
                return resolveParcelId(parcel?.feature);
            } catch (_) { return null; }
        }).filter(Boolean);
        const blockLabel = context.blockName || describeSingleBuildingSelection(blockParcelIds);
        if (!block.parcels || block.parcels.length === 0) {
            setSingleBuildingStatus('selected_block_has_no_parcels_2', 'Selected block has no parcels.');
            return;
        }

        if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || typeof multiParcelSelection.clearSelection !== 'function') {
            setSingleBuildingStatus('parcel_selection_tools_are_unavailable_cannot_prepare_proposal', 'Parcel selection tools are unavailable, cannot prepare proposal.');
            return;
        }

        multiParcelSelection.clearSelection();

        const normalizedParcelIds = [];
        const parentDetails = [];
        block.parcels.forEach(parcel => {
            const parcelId = resolveParcelId(parcel?.feature);
            if (!parcelId) return;
            const idStr = parcelId.toString();
            if (/^site(-plot)?:/.test(idStr)) return;
            let number = idStr;
            try {
                if (parcel.feature?.properties?.BROJ_CESTICE) {
                    number = String(parcel.feature.properties.BROJ_CESTICE);
                }
            } catch (_) { }
            normalizedParcelIds.push(idStr);
            parentDetails.push({ id: idStr, number });
            multiParcelSelection.selectedParcels.add(idStr);
        });

        if (typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length && !singleBlockFeature?.geometry) {
            setSingleBuildingStatus('could_not_determine_parcels_for_this_block', 'Could not determine parcels for this block.');
            return;
        }

        const clonedBuildings = [];
        for (const entry of buildingEntries) {
            if (!entry || !entry.feature) continue;
            const cloned = singleSession?.placement?.locked
                ? window.SingleBuildingGeometry.clipFootprintToBoundary(JSON.parse(JSON.stringify(entry.feature)), singleBlockFeature, turf)
                : JSON.parse(JSON.stringify(entry.feature));
            if (!cloned.properties) cloned.properties = {};
            cloned.properties.height = Math.max(3, Number(entry.height) || DEFAULT_HEIGHT_M);
            cloned.properties.rotation = Number(entry.rotation) || 0;
            cloned.properties.footprintMode = 'polygon';
            delete cloned.properties.width;
            delete cloned.properties.length;
            delete cloned.properties.chamfer;
            cloned.properties.block = blockLabel || cloned.properties.block || null;
            cloned.properties.type = 'proposedBuildingSingle';
            cloned.properties.color = entry.color;
            clonedBuildings.push({
                id: entry.id,
                name: entry.name,
                color: entry.color,
                feature: cloned,
                height: cloned.properties.height,
                rotation: cloned.properties.rotation
            });
        }

        if (!clonedBuildings.length) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to prepare building geometry for proposal.');
            return;
        }

        const buildingFeatures = clonedBuildings.map(b => b.feature).filter(f => f && f.geometry);
        const singleContext = {
            parcelIds: normalizedParcelIds.slice(),
            parentDetails: parentDetails.slice(),
            blockName: blockLabel,
            parameters: {
                typology: 'single',
                height: clonedBuildings[0]?.height ?? null,
                rotation: clonedBuildings[0]?.rotation ?? null,
                footprintMode: 'polygon'
            },
            buildingFeature: buildingFeatures[0] || null,
            buildings: buildingFeatures,
            groundSurface: currentGroundSurface(),
            groundBoundary: cloneSingleFeature(singleGroundBoundary),
            landTake: cloneSingleFeature(singleLandTakeReview?.take),
            placement: { site: currentPlacementSite(buildingFeatures), free: true }
        };
        if (typeof setPendingBuildingProposalContext === 'function') {
            setPendingBuildingProposalContext(singleContext);
        } else if (typeof window !== 'undefined') {
            window.pendingBuildingProposalContext = singleContext;
        }
        if (typeof window !== 'undefined') {
            window.pendingBuildingFromBlockify = buildingFeatures[0] || null;
        }

        if (buildingFeatures.length > 1) {
            const staged = window.stageActiveFreeformBuildings({ buildings: buildingFeatures.map((building, index) => ({
                building,
                site: cloneSingleFeature(index === 0 ? singleContext.placement.site : building.geometry),
                ...(index === 0 ? { surroundings: {
                    groundSurface: singleContext.groundSurface,
                    groundBoundary: singleContext.groundBoundary,
                    landTake: cloneSingleFeature(building.geometry)
                } } : {})
            })) });
            if (!staged.ok) {
                console.error('Freeform buildings could not be prepared', staged.reason);
                showSingleBuildingEditorAlert('uploadInvalid', 'Could not prepare the building geometry.');
                return;
            }
        }

        const afterConfirm = singleUploadOnConfirm;
        closeSingleBuildingMapEditor({ preservePending: true });
        afterConfirm?.();

        setSingleBuildingStatus('single_building_design_saved_complete_the_proposal_form_to_submit', 'Single building design saved. Complete the proposal form to submit.');

        const description = document.getElementById('proposalDescription');
        if (description) description.focus();
    }

    function showSingleBuildingMapEditor() {
        if (singleEditor) return false;
        try {
            const opened = mountSingleBuildingMapEditor();
            if (!opened) closeSingleBuildingMapEditor();
            return opened;
        } catch (error) {
            closeSingleBuildingMapEditor();
            throw error;
        }
    }

    function mountSingleBuildingMapEditor() {
        singleBlockFeature = getSelectedBlockFeature();
        singleGroundBoundary = cloneSingleFeature(singleBuildingSeedGroundBoundary || singleBlockFeature);
        singleBuildingSeedGroundBoundary = null;
        if (!singleBlockFeature) {
            setSingleBuildingStatus('select_a_block_first', 'Select a block first');
            return;
        }

        const modalText = {
            title: translateSingleBuildingText('modal.singleBuilding.title', 'Freeform'),
            closeLabel: translateSingleBuildingText('modal.singleBuilding.closeLabel', 'Close buildings modal'),
            confirm: translateSingleBuildingText('modal.singleBuilding.confirm', 'Done'),
            densityTitle: translateSingleBuildingText('densityStats.title', 'Geometry statistics'),
            densityParcelArea: translateSingleBuildingText('densityStats.parcelArea', 'Parcel area'),
            densityFootprint: translateSingleBuildingText('densityStats.footprint', 'Building footprint'),
            densitySiteCoverage: translateSingleBuildingText('densityStats.siteCoverage', 'Site coverage (kig)'),
            densityGbp: translateSingleBuildingText('densityStats.gbp', 'Above-ground GBP'),
            densityKin: translateSingleBuildingText('densityStats.kin', 'kin'),
            heightLabel: translateSingleBuildingText('modal.singleBuilding.heightLabel', 'Height (m):'),
            rotationLabel: translateSingleBuildingText('modal.singleBuilding.rotationLabel', 'Rotate footprint'),
            rotateCounterclockwiseLabel: translateSingleBuildingText('modal.singleBuilding.rotateCounterclockwiseLabel', 'Rotate counterclockwise 5 degrees'),
            rotateClockwiseLabel: translateSingleBuildingText('modal.singleBuilding.rotateClockwiseLabel', 'Rotate clockwise 5 degrees'),
            uploadGeojsonLabel: translateSingleBuildingText('modal.singleBuilding.uploadGeojsonLabel', 'Upload GeoJSON'),
            uploadGlbLabel: translateSingleBuildingText('modal.singleBuilding.uploadGlbLabel', 'Upload .glb'),
            surroundingsLabel: translateSingleBuildingText('modal.singleBuilding.surroundingsLabel', 'Surroundings'),
            surroundingsPaved: translateSingleBuildingText('modal.singleBuilding.surroundingsPaved', 'Paving'),
            surroundingsGreen: translateSingleBuildingText('modal.singleBuilding.surroundingsGreen', 'Green'),
            surroundingsInfo: translateSingleBuildingText(
                'modal.singleBuilding.surroundingsInfo',
                'Surface treatment applies to the land around the proposed buildings. Demolition follows the design’s land take.'
            ),
            // A touch screen has no Delete key to press — its variant names only the trash button.
            infoText: (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
                ? translateSingleBuildingText(
                    'modal.singleBuilding.infoTextTouch',
                    'Drag the footprint to move it. Drag a vertex to reshape it, tap an edge to add a vertex, or select a vertex and use the trash button to remove it. Use Lock to starting site when the design must stay within the selected land.'
                )
                : translateSingleBuildingText(
                    'modal.singleBuilding.infoText',
                    'Drag the footprint to move it. Drag a vertex to reshape it, click an edge to add a vertex, or select a vertex and use the trash button or Delete/Backspace to remove it. Use Lock to starting site when the design must stay within the selected land.'
                )
        };

        if (!singleEditor) {
            singleSession = window.OnMapEditor.open({
                owner: EDIT_LOCK_OWNER,
                id: 'single-building-editor',
                title: modalText.title,
                modes: ['2d', 'model'],
                onCancel: requestCloseSingleBuildingMapEditor,
                onModeChange: syncSingleBuildingView,
                placement: { site: singleBlockFeature, onLockChange: () => { renderSharedPolygonEditor(); syncRotationButtons(); } },
                hints: {
                    '2d': translateSingleBuildingText('modal.singleBuilding.mapHint', 'Drag the building or its corners. Tap an edge to add a corner.')
                },
                tools: `
                    <button id="single-rotate-counterclockwise" class="btn" type="button" title="${modalText.rotateCounterclockwiseLabel}" aria-label="${modalText.rotateCounterclockwiseLabel}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> 5°</button>
                    <button id="single-rotate-clockwise" class="btn" type="button" title="${modalText.rotateClockwiseLabel}" aria-label="${modalText.rotateClockwiseLabel}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> 5°</button>
                `,
                content: `
                        <div class="on-map-building__height">
                            <label for="single-height-slider">${modalText.heightLabel} <strong id="single-height-value">${DEFAULT_HEIGHT_M}</strong></label>
                            <input type="range" id="single-height-slider" aria-label="${modalText.heightLabel}" min="3" max="250" step="1" value="${DEFAULT_HEIGHT_M}">
                        </div>
                        <div class="on-map-building__metrics"><span>${modalText.densityFootprint}</span><strong id="single-building-footprint-summary">—</strong></div>
                        <div class="on-map-building__fields">
                            <section id="single-land-take" class="land-take-review" aria-label="${translateSingleBuildingText('landTake.title')}">
                                <h3 class="cb-kicker">${translateSingleBuildingText('landTake.title')}</h3>
                                <p data-land-intro>${translateSingleBuildingText('landTake.intro', '', { count: 0 })}</p>
                                <div class="land-take-actions">
                                    <button class="btn btn-sm" type="button" data-land-footprint>${translateSingleBuildingText('landTake.allFootprint')}</button>
                                    <button class="btn btn-sm" type="button" data-land-whole>${translateSingleBuildingText('landTake.allWhole')}</button>
                                </div>
                                <div class="land-take-rows" data-land-rows></div>
                                <p data-land-status role="status" aria-live="polite"></p>
                            </section>
                            <div class="parameter-group">
                                <label for="single-ground-treatment">${modalText.surroundingsLabel}</label>
                                <select id="single-ground-treatment"><option value="paved">${modalText.surroundingsPaved}</option><option value="green">${modalText.surroundingsGreen}</option></select>
                                <button id="single-ground-treatment-edit" class="btn btn-sm" type="button" disabled>${translateSingleBuildingText('modal.singleBuilding.editSurroundings', 'Edit surroundings')}</button>
                                <p class="parameter-info-text">${modalText.surroundingsInfo}</p>
                            </div>
                            <section id="single-building-density-stats" class="building-density-card" aria-live="polite">
                                <h3 class="cb-kicker">${modalText.densityTitle}</h3>
                                <dl class="building-density-grid">
                                    <div><dt>${modalText.densityParcelArea}</dt><dd id="single-building-density-parcel">—</dd></div>
                                    <div><dt>${modalText.densityFootprint}</dt><dd id="single-building-density-footprint">—</dd></div>
                                    <div><dt>${modalText.densitySiteCoverage}</dt><dd id="single-building-density-coverage">—</dd></div>
                                    <div><dt>${modalText.densityGbp}</dt><dd id="single-building-density-gbp">—</dd></div>
                                    <div><dt>${modalText.densityKin}</dt><dd id="single-building-density-kin">—</dd></div>
                                </dl>
                                <p id="single-building-density-hint" class="building-density-hint"></p>
                            </section>
                            <div class="cb-actions on-map-building__imports">
                                <button id="single-building-geojson-upload" class="btn" type="button">${modalText.uploadGeojsonLabel}</button>
                                <button id="single-building-glb-upload" class="btn" type="button">${modalText.uploadGlbLabel}</button>
                            </div>
                            <input id="single-building-geojson-input" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden>
                        </div>
`,
                footer: `
                        <button id="single-building-undo" type="button" class="btn btn-quiet" disabled>${translateSingleBuildingText('onMapEditor.undo', 'Undo')}</button>
                        <button id="single-building-confirm" type="button" class="btn btn-primary">${modalText.confirm}</button>
                    `
            });
            if (!singleSession) return false;
            singleEditor = singleSession.root;
            singleSession.tools.setAttribute('role', 'toolbar');
            singleSession.tools.setAttribute('aria-label', modalText.rotationLabel);
            singleBuildingDesignChanges().start(document);
            document.getElementById('single-building-confirm').addEventListener('click', event => {
                if (!window.BusyControl.isBusy(event.currentTarget)) window.BusyControl.track(event.currentTarget, confirmSingleBuilding);
            });

            const hSlider = document.getElementById('single-height-slider');
            ensureSingleBuildingHistory().bindInput(hSlider, (e) => {
                currentHeightM = parseFloat(e.target.value);
                document.getElementById('single-height-value').textContent = CbFormat.formatNumber(currentHeightM, { maxFractionDigits: 0, minFractionDigits: 0 });
                if (singleRectFeature) {
                    if (singleRectFeature.properties) singleRectFeature.properties.height = currentHeightM;
                    const active = getActiveBuilding();
                    if (active) {
                        active.height = currentHeightM;
                        active.feature = singleRectFeature;
                    }
                    try { updateSingleBuildingPreview(); } catch (_) { }
                    autosaveSingleBuildingDraft();
                }
            });

            document.getElementById('single-rotate-counterclockwise')
                .addEventListener('click', () => rotateActiveFootprint(5));
            document.getElementById('single-rotate-clockwise')
                .addEventListener('click', () => rotateActiveFootprint(-5));

            const groundSelect = document.getElementById('single-ground-treatment');
            if (groundSelect) {
                groundSelect.addEventListener('change', (e) => {
                    ensureSingleBuildingHistory().record();
                    currentGroundTreatment = normalizeGroundTreatment(e.target.value);
                    currentGroundDecorationDesign = null;
                    updateGroundPreview();
                    updateSingleBuildingPreview();
                    autosaveSingleBuildingDraft();
                });
            }
            document.getElementById('single-ground-treatment-edit').addEventListener('click', () => {
                window.BuildingSurroundingsEditor.edit({ session: singleSession, surface: currentGroundSurface(),
                    onOpen: () => {
                        singleGroundPreviewSuspended = true;
                        updateGroundPreview();
                    },
                    onClose: () => {
                        singleGroundPreviewSuspended = false;
                        updateGroundPreview();
                    },
                    onSave: design => {
                    ensureSingleBuildingHistory()?.record();
                    currentGroundDecorationDesign = design;
                    updateRectangleLayers();
                } });
            });

            const geojsonButton = document.getElementById('single-building-geojson-upload');
            document.getElementById('single-building-glb-upload')?.addEventListener('click', () => {
                window.BusyControl.track(document.getElementById('single-building-glb-upload'), openSingleBuildingModelUpload);
            });
            const geojsonInput = document.getElementById('single-building-geojson-input');
            if (geojsonButton && geojsonInput) {
                geojsonButton.addEventListener('click', () => geojsonInput.click());
                geojsonInput.addEventListener('change', event => {
                    const file = event.target?.files?.[0];
                    if (file) loadSingleBuildingGeoJSON(file);
                    event.target.value = '';
                });
            }

            // No outside-click close: a stray click on the backdrop would throw the design away.
            // The editor is left only via the X (discard, after confirming) or Done (save).
        }

        singleMap = singleSession.map;
        singleMap.on('mousedown', tryStartDragFromMap);
        singleMap.on('touchstart', tryStartDragFromMap);
        drawBlockOnMap(singleBlockFeature);
        buildingEntries = [];
        activeBuildingId = null;
        nextBuildingId = 1;

        currentGroundTreatment = normalizeGroundTreatment(singleBuildingSeedGroundTreatment);
        currentGroundDecorationDesign = cloneSingleFeature(singleBuildingSeedDecorationDesign);
        singleBuildingSeedDecorationDesign = null;
        singleBuildingSeedGroundTreatment = null;
        const groundSelectEl = document.getElementById('single-ground-treatment');
        if (groundSelectEl) groundSelectEl.value = currentGroundTreatment;
        const initialPlacement = computeInitialPlacement(singleBlockFeature);
        const startCenter = initialPlacement.center || getBlockCentroid(singleBlockFeature);
        currentHeightM = DEFAULT_HEIGHT_M;
        currentRotationDeg = 0;
        singleRectFeature = null;

        // Restore the exact saved polygons (e.g. while editing or copying a proposal). Geometry is
        // authoritative; legacy width/length/chamfer properties are intentionally not regenerated.
        const seedBuildings = singleBuildingSeedBuildings;
        singleBuildingSeedBuildings = null;
        let initialEntry = null;
        if (Array.isArray(seedBuildings) && seedBuildings.length) {
            seedBuildings.forEach((feature) => {
                if (!feature || !feature.geometry) return;
                const props = feature.properties || {};
                const entry = addNewBuildingEntry(featureCenterLatLng(feature) || startCenter, {
                    feature,
                    height: props.height,
                    rotation: props.rotation
                });
                if (!entry) return;
                if (!initialEntry) initialEntry = entry;
            });
        }
        if (!initialEntry) {
            initialEntry = addNewBuildingEntry(startCenter, {
                width: initialPlacement.width,
                length: initialPlacement.length,
                height: currentHeightM,
                rotation: currentRotationDeg
            });
        }
        if (!initialEntry) throw new Error('Could not fit a building inside the selected site.');
        setActiveBuilding(initialEntry.id, { refreshUI: true });

        singleLandTakeReview = window.FreeformLandTakeReview.mount({ session: singleSession,
            getBuildings: () => buildingEntries.filter(entry => entry?.feature).map(entry => cloneSingleFeature(entry.feature)),
            initialTake: singleBuildingSeedLandTake,
            onHistory: () => ensureSingleBuildingHistory().record(),
            onReview: () => singleSession?.setPreview(singleBuildingPreview()),
            onChange: refreshSingleLandTakePreview
        });
        singleBuildingSeedLandTake = null;
        // Opening placement keeps the view the user chose, including the surrounding context.
        // An automatic fit here also queued a surprise camera move on returning from model 3D.
        syncSingleBuildingView();
        ensureSingleBuildingHistory();
        singleBuildingDesignChanges().capture();
        document.getElementById('single-height-slider').focus({ preventScroll: true });
        return true;
    }

    // Uploaded and generated designs share the same explicit site or live-parcel boundary.
    function singleBuildingPlacementContext({ blockName, parcelIds, site = null }) {
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        const siteGeometry = site?.type === 'Feature' ? site.geometry : site;
        const siteOnly = !ids.length && ['Polygon', 'MultiPolygon'].includes(siteGeometry?.type);
        if (!ids.length && !siteOnly) {
            setSingleBuildingStatus('select_parcels_before_launching_the_single_building_tool', 'Select a site before launching the single building tool.');
            return null;
        }
        const liveParcels = siteOnly ? [{ id: 'site:single', feature: {
            type: 'Feature', properties: { parcelId: 'site:single', synthetic: true, siteParcel: true },
            geometry: cloneSingleFeature(siteGeometry)
        } }] : singleBuildingParcelsForIds(ids);
        if (!siteOnly && liveParcels.length !== ids.length) {
            setSingleBuildingStatus('could_not_resolve_parcel_data_for_the_single_building_tool', 'Could not resolve parcel data for the single building tool.');
            return null;
        }
        return { blockName: blockName || describeSingleBuildingSelection(ids),
            parcels: liveParcels, parcelIds: ids, site: cloneSingleFeature(site) };
    }

    // `initialBuildings` (optional) reopens the editor on previously-saved building features
    // instead of one default building — used by "Copy into new proposal".
    // `initialGroundTreatment` restores the proposal's surroundings choice the same way.
    function openSingleBuildingForParcels({ blockName, parcelIds, initialBuildings = null, site = null, initialGroundTreatment = null, initialDecorationDesign = null, initialLandTake = null, initialGroundBoundary = null }) {
        if (singleEditor) return false;
        const context = singleBuildingPlacementContext({ blockName, parcelIds, site });
        if (!context) return false;
        singleBuildingSeedBuildings = (Array.isArray(initialBuildings) && initialBuildings.length) ? initialBuildings : null;
        singleBuildingSeedGroundTreatment = initialGroundTreatment;
        singleBuildingSeedDecorationDesign = initialDecorationDesign;
        singleBuildingSeedGroundBoundary = initialGroundBoundary;
        singleBuildingSeedLandTake = initialLandTake;
        singleBuildingOverrideContext = context;
        return showSingleBuildingMapEditor();
    }

    // Uploads enter the same placement editor; only Done saves the design and completes the
    // upload caller's form status. The mesh reference stays attached to the editable footprint.
    function createSingleBuildingFromUpload({ blockName, parcelIds, site = null, width, length, height, footprint, modelName, modelUrl, onConfirm } = {}) {
        if (singleEditor || window.OnMapEditor?.isActive?.()) return false;
        const context = singleBuildingPlacementContext({ blockName, parcelIds, site });
        if (!context) return false;
        singleBuildingOverrideContext = context;
        singleBlockFeature = getSelectedBlockFeature();
        if (!singleBlockFeature) {
            setSingleBuildingStatus('select_a_block_first', 'Could not build a block from the selected parcels.');
            return false;
        }

        // Reset building state so the upload produces a single, clean entry.
        buildingEntries = [];
        activeBuildingId = null;
        nextBuildingId = 1;

        const placement = computeInitialPlacement(singleBlockFeature);
        const safeHeight = Math.max(3, Math.round(Number(height) || DEFAULT_HEIGHT_M));
        const feature = window.SingleBuildingGeometry.placeModelFootprint(footprint, placement.center, 0);
        if (!feature) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to fit the uploaded building inside the selected block.');
            return false;
        }
        markAsEditablePolygon(feature, safeHeight, 0);
        if (!editableFootprintValid(feature)) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to fit the uploaded building inside the selected block.');
            return false;
        }
        const entry = addNewBuildingEntry(placement.center, {
            feature,
            height: safeHeight,
            rotation: 0
        });
        if (!entry || !entry.feature) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to fit the uploaded building inside the selected block.');
            return false;
        }

        // Tag the footprint with the model origin so it can be recognised later.
        if (!entry.feature.properties) entry.feature.properties = {};
        entry.feature.properties.source = 'upload';
        if (modelName) entry.feature.properties.modelName = String(modelName).slice(0, 120);
        // modelUrl lets the main-map 3D view render the actual mesh instead of an extruded box.
        // It rides along in feature.properties → proposal_data JSONB → window.proposedBuildings.
        if (modelUrl) entry.feature.properties.modelUrl = String(modelUrl);
        entry.height = safeHeight;
        entry.feature.properties.height = safeHeight;

        singleBuildingSeedBuildings = [cloneSingleFeature(entry.feature)];
        singleUploadOnConfirm = typeof onConfirm === 'function' ? onConfirm : null;
        return showSingleBuildingMapEditor();
    }

    window.openSingleBuildingForParcels = openSingleBuildingForParcels;
    window.openFreeformGeoJSONBuildings = openFreeformGeoJSONBuildings;
    window.createSingleBuildingFromUpload = createSingleBuildingFromUpload;
    window.clearSingleBuildingPendingState = clearSingleBuildingPendingState;
})();
