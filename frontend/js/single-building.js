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
    let singleMoveTogether = true;
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

    // Rotation state
    let currentRotationDeg = 0; // current rotation in degrees

    // Surroundings: one treatment per proposal for the whole merged parcel area around the
    // buildings — left as it is, paved like a square, or grassed like a park. See building-ground.js.
    let currentGroundTreatment = 'none';
    // §15a: how the freeform building forms its parcel — footprint parcel (default) or taking
    // the whole host parcels. Carried on the draft context into buildingProposal.takeWholeParcels.
    let currentTakeWholeParcels = false;
    let singleBuildingSeedGroundTreatment = null;
    let singleBuildingSeedTakeWholeParcels = null;

    function buildingGroundApi() {
        return (typeof window !== 'undefined' && window.BuildingGround) ? window.BuildingGround : null;
    }

    function normalizeGroundTreatment(value) {
        const api = buildingGroundApi();
        return api ? api.normalizeTreatment(value) : 'none';
    }

    // The polygon the proposal will pave or green: the block minus every building footprint on it.
    function currentGroundSurface() {
        const api = buildingGroundApi();
        if (!api) return null;
        const buildings = buildingEntries.filter(entry => entry?.feature).map(entry => entry.feature);
        return api.buildSurface(currentGroundTreatment, singleGroundBoundary || singleBlockFeature, buildings);
    }

    function currentPlacementSite(buildings = null) {
        const features = buildings ? buildings.slice() : buildingEntries.filter(entry => entry?.feature).map(entry => entry.feature);
        if ((currentGroundTreatment !== 'none' || currentTakeWholeParcels) && singleGroundBoundary) {
            features.unshift(singleGroundBoundary);
        }
        let combined = null;
        for (const feature of features) combined = combined ? turf.union(combined, feature) : cloneSingleFeature(feature);
        if (!combined?.geometry) return null;
        return combined.geometry.type === 'MultiPolygon' ? combined.geometry
            : { type: 'MultiPolygon', coordinates: [combined.geometry.coordinates] };
    }

    function captureSingleBuildingDesign() {
        return cloneSingleFeature({ buildings: buildingEntries, activeId: activeBuildingId,
            groundBoundary: singleGroundBoundary, groundTreatment: currentGroundTreatment,
            takeWholeParcels: currentTakeWholeParcels });
    }

    function ensureSingleBuildingHistory() {
        if (!singleHistory) {
            singleHistory = window.GeometryEditHistory.create({
                capture: captureSingleBuildingDesign,
                restore(snapshot) {
                    buildingEntries = cloneSingleFeature(snapshot.buildings);
                    singleGroundBoundary = cloneSingleFeature(snapshot.groundBoundary);
                    currentGroundTreatment = snapshot.groundTreatment;
                    currentTakeWholeParcels = snapshot.takeWholeParcels;
                    refreshBuildingSelector();
                    setActiveBuilding(snapshot.activeId, { refreshUI: true });
                    const ground = document.getElementById('single-ground-treatment');
                    if (ground) ground.value = currentGroundTreatment;
                    const mode = document.getElementById('single-parcel-mode');
                    if (mode) mode.value = currentTakeWholeParcels ? 'whole' : 'footprint';
                }
            });
            singleHistory.bindKeyboard(document, { enabled: () => !!singleEditor && !rectDragActive });
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
    const DEFAULT_LENGTH_M = 6; // along Y
    const DEFAULT_WIDTH_M = 3;  // along X
    const DEFAULT_HEIGHT_M = 10; // meters
    let currentHeightM = DEFAULT_HEIGHT_M;
    let pendingSingleBuildingMeta = null;
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
                parcelFeature: singleBlockFeature,
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

    const showSingleBuildingAlert = (key, fallback, params = {}) => {
        const message = translateSingleBuildingText(`alerts.messages.${key}`, fallback, params);
        window.CbDialog.alert(message);
        return message;
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
        const select = document.getElementById('single-building-selector');
        if (select) select.value = String(activeBuildingId);
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
        const fitted = fitRectangleAtCenter(centerLatLng, widthM, lengthM, heightM, rotationDeg) || null;
        return markAsEditablePolygon(fitted, heightM, rotationDeg);
    }

    function addNewBuildingEntry(centerLatLng, options = {}) {
        const placement = computeInitialPlacement(singleBlockFeature);
        const center = centerLatLng || placement.center;
        const width = Number(options.width) || placement.width || DEFAULT_WIDTH_M;
        const length = Number(options.length) || placement.length || DEFAULT_LENGTH_M;
        const height = Number(options.height) || width;
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
            name: savedName || translateSingleBuildingText('modal.singleBuilding.defaultName', 'Building {{n}}', { n: id }),
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

    function duplicateActiveBuilding() {
        const source = getActiveBuilding();
        const projector = getSingleProjector();
        if (!source?.feature?.geometry || !projector) return null;

        const targets = [];
        const sourceCenter = featureCenterLatLng(source.feature);
        if (sourceCenter && singleMap) {
            const point = singleMap.latLngToLayerPoint(sourceCenter);
            [[28, 0], [-28, 0], [0, 28], [0, -28], [28, 28], [-28, 28], [28, -28], [-28, -28]]
                .forEach(([dx, dy]) => targets.push(singleMap.layerPointToLatLng(point.add(L.point(dx, dy)))));
        }
        const placement = computeInitialPlacement(singleBlockFeature);
        if (placement.center) targets.push(placement.center);
        for (let i = 0; i < 20; i++) {
            const randomTarget = randomPointInsideBlock(singleBlockFeature);
            if (randomTarget) targets.push(randomTarget);
        }

        let copiedFeature = null;
        for (const target of targets) {
            const geometry = window.SingleBuildingGeometry.moveGeometryCenter(source.feature.geometry, target);
            const candidate = featureWithGeometry(source.feature, geometry);
            if (candidate && editableFootprintValid(candidate)) {
                copiedFeature = candidate;
                break;
            }
        }
        // A cramped parcel may have no second non-overlapping-looking position. Keeping the exact
        // copy is still preferable to silently changing its shape; the new active handles reveal it.
        if (!copiedFeature) copiedFeature = cloneSingleFeature(source.feature);

        ensureSingleBuildingHistory().record();
        const entry = addNewBuildingEntry(featureCenterLatLng(copiedFeature), {
            feature: copiedFeature,
            height: source.height,
            rotation: source.rotation
        });
        if (!entry) return null;
        entry.feature.properties.name = entry.name;
        refreshBuildingSelector();
        setActiveBuilding(entry.id, { refreshUI: true });
        return entry;
    }

    function removeActiveBuilding() {
        if (!buildingEntries.length) return;
        if (buildingEntries.length === 1) return; // keep at least one building
        ensureSingleBuildingHistory().record();
        buildingEntries = buildingEntries.filter(b => b.id !== activeBuildingId);
        const next = buildingEntries[buildingEntries.length - 1];
        setActiveBuilding(next.id);
        refreshBuildingSelector();
        updateRectangleLayers();
    }

    function refreshBuildingSelector() {
        const select = document.getElementById('single-building-selector');
        if (!select) return;
        select.replaceChildren(...buildingEntries.map(building => {
            const option = document.createElement('option');
            option.value = String(building.id);
            option.textContent = building.name;
            return option;
        }));
        select.value = String(activeBuildingId);
    }

    // Proposed building collection shares the same layer/array as blockify
    if (typeof window !== 'undefined') {
        try { if (!Array.isArray(window.proposedBuildings)) window.proposedBuildings = []; } catch (_) { }
        try { window.pendingSingleBuildingFeature = null; } catch (_) { }
        try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
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
            // Use robust union and reduce to largest polygon if available from building-blocks.js
            let unioned = null;
            try { unioned = robustUnion(parcelFeatures); } catch (_) { unioned = null; }
            if (!unioned) {
                // Fallback to manual union via turf.union sequentially
                try {
                    let acc = parcelFeatures[0];
                    for (let i = 1; i < parcelFeatures.length; i++) {
                        try { acc = turf.union(acc, parcelFeatures[i]) || acc; } catch (_) { }
                    }
                    unioned = acc;
                } catch (_) { unioned = parcelFeatures[0]; }
            }
            try { unioned = toSingleLargestPolygon(unioned) || unioned; } catch (_) { }
            return unioned;
        } catch (_) { return null; }
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

    function randomPointInsideBlock(blockFeature) {
        if (!blockFeature || !blockFeature.geometry) return null;
        try {
            const bbox = turf.bbox(blockFeature);
            for (let i = 0; i < 24; i++) {
                const pt = turf.randomPoint(1, { bbox }).features[0];
                if (turf.booleanPointInPolygon(pt, blockFeature)) {
                    const [lng, lat] = pt.geometry.coordinates;
                    return L.latLng(lat, lng);
                }
            }
        } catch (_) { }
        return getBlockCentroid(blockFeature) || null;
    }

    function computeInitialPlacement(blockFeature) {
        const initialSquareSize = Math.max(DEFAULT_WIDTH_M, DEFAULT_LENGTH_M);
        if (!blockFeature) return { center: null, width: initialSquareSize, length: initialSquareSize };

        const attempts = 12;
        const growStep = 3;
        const retreat = 2.5;
        let best = { center: null, width: initialSquareSize, length: initialSquareSize };

        for (let i = 0; i < attempts; i++) {
            const center = randomPointInsideBlock(blockFeature);
            if (!center) continue;

            let size = 6;
            let lastValid = null;
            for (let j = 0; j < 160; j++) {
                const candidate = buildRectangleFeature(center, size, size, DEFAULT_HEIGHT_M);
                if (footprintFullyInsideBlock(candidate, blockFeature)) {
                    lastValid = size;
                    size += growStep;
                } else {
                    break;
                }
            }

            if (!lastValid) continue;

            let targetSize = Math.max(1, lastValid - retreat * 2);
            for (let k = 0; k < 12; k++) {
                const candidate = buildRectangleFeature(center, targetSize, targetSize, DEFAULT_HEIGHT_M);
                if (footprintFullyInsideBlock(candidate, blockFeature)) break;
                targetSize = Math.max(1, targetSize - retreat);
            }

            if (targetSize > best.width) {
                best = { center, width: targetSize, length: targetSize };
            }
        }

        if (!best.center) {
            const fallbackCenter = getBlockCentroid(blockFeature);
            return { center: fallbackCenter, width: initialSquareSize, length: initialSquareSize };
        }

        return best;
    }

    function singleBuildingPreview() {
        if (!singleEditor) return null;
        return {
            draftPreview: { kind: 'buildings', features: buildingEntries.map(entry => cloneSingleFeature(entry.feature)).filter(Boolean) },
            boundary: cloneSingleFeature(singleBlockFeature),
            groundSurface: currentGroundSurface()
        };
    }

    function updateSingleBuildingPreview() {
        refreshSingleBuildingDensityStats();
        singleSession?.setPreview(singleBuildingPreview());
        positionSingleBuildingToolbar();
    }

    function positionSingleBuildingToolbar() {
        const center = featureCenterLatLng(singleRectFeature);
        singleSession?.setAnchor(center ? { lat: center.lat, lng: center.lng, height: currentHeightM } : null);
    }

    function syncSingleBuildingView() {
        if (!singleEditor) return;
        renderSharedPolygonEditor();
        updateSingleBuildingPreview();
    }

    function tryStartDragFromMap(event) {
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

    function footprintFullyInsideBlock(footprintFeature, blockFeature) {
        try {
            if (!footprintFeature || !blockFeature) return false;
            return window.SingleBuildingGeometry?.footprintWithinBoundary?.(
                footprintFeature,
                blockFeature,
                turf
            ) === true;
        } catch (_) { return false; }
    }

    function fitRectangleAtCenter(centerLatLng, widthM, lengthM, heightM, rotationDeg = 0) {
        if (!singleBlockFeature || !centerLatLng) return null;
        let w = widthM;
        let l = lengthM;
        let best = null;
        const maxIters = 14;
        for (let i = 0; i < maxIters; i++) {
            let candidate = buildRectangleFeature(centerLatLng, w, l, heightM, rotationDeg);
            try { candidate = turf.rewind(candidate, { reverse: false }); } catch (_) { }
            if (footprintFullyInsideBlock(candidate, singleBlockFeature)) {
                best = candidate;
                if (best && best.properties) {
                    best.properties.width = w;
                    best.properties.length = l;
                    best.properties.rotation = rotationDeg;
                }
                break;
            }
            w *= 0.93;
            l *= 0.93;
        }
        return best;
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
            takeWholeParcels: currentTakeWholeParcels,
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
                // Click any non-active footprint on the map to make it active (same as the dropdown).
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
        const surface = currentGroundSurface();
        const style = surface ? buildingGroundApi()?.SURFACE_STYLE_2D[surface.treatment] : null;
        if (!surface || !style) return;
        try {
            singleGroundPreviewLayer = L.geoJSON({ type: 'Feature', properties: {}, geometry: surface.polygon }, {
                pane: EDIT_PANE,
                style: { ...style, weight: 1, opacity: 1 },
                interactive: false
            }).addTo(singleMap);
            singleGroundPreviewLayer.bringToBack();
        } catch (error) {
            console.warn('[single-building] ground preview failed', error);
        }
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
            refreshBuildingSelector();
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
        // One metric transform moves the proposal and all its contents. Moving an individual
        // building is also available, while the original site remains only an optional guide.
        if (Math.abs(delta.x) + Math.abs(delta.y) < 1 && !rectDragHistoryRecorded) return;
        const target = singleSession.placement.moveTarget(rectDragStartFeature.geometry, startCenter, newCenter, e);
        const geometry = window.SingleBuildingGeometry.moveGeometry(rectDragStartFeature.geometry, startCenter, target);
        const candidate = featureWithGeometry(rectDragStartFeature, geometry);
        if (!candidate || !editableFootprintValid(candidate)) return;
        const movedEntries = rectDragStartDesign.buildings.map(entry => {
            if (!singleMoveTogether && entry.id !== activeBuildingId) return cloneSingleFeature(entry);
            const moved = cloneSingleFeature(entry);
            moved.feature.geometry = window.SingleBuildingGeometry.moveGeometry(entry.feature.geometry, startCenter, target);
            moved.lastValidCenter = featureCenterLatLng(moved.feature);
            return moved;
        });
        if (movedEntries.some(entry => !singleSession.placement.accepts(entry.feature))) return;
        const movedGround = singleMoveTogether && rectDragStartDesign.groundBoundary
            ? featureWithGeometry(rectDragStartDesign.groundBoundary,
                window.SingleBuildingGeometry.moveGeometry(rectDragStartDesign.groundBoundary.geometry, startCenter, target))
            : cloneSingleFeature(rectDragStartDesign.groundBoundary);
        if ((currentGroundTreatment !== 'none' || currentTakeWholeParcels)
            && movedGround && !singleSession.placement.accepts(movedGround)) return;
        if (!rectDragHistoryRecorded) {
            ensureSingleBuildingHistory().record();
            rectDragHistoryRecorded = true;
        }
        buildingEntries = movedEntries;
        singleGroundBoundary = movedGround;
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
        pendingSingleBuildingMeta = null;
        singleBuildingOverrideContext = null;
        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = null; } catch (_) { }
            try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
        }
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
                    buildingEntries.map(entry => entry && entry.feature)) + '|' + currentGroundTreatment + '|' + currentTakeWholeParcels
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
        singleBuildingLayers.clear();
        singleHistory?.destroy();
        singleHistory = null;
        singleRectFeature = null;
        currentRotationDeg = 0;
        currentGroundTreatment = 'none';
        currentTakeWholeParcels = false;
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

    function confirmSingleBuilding() {
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

        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeatures = clonedBuildings.map(b => b.feature); } catch (_) { }
            try { window.pendingSingleBuildingFeature = clonedBuildings[0]?.feature || null; } catch (_) { }
        }

        pendingSingleBuildingMeta = {
            blockName: blockLabel,
            parcelIds: normalizedParcelIds.slice(),
            buildings: clonedBuildings
        };

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
            takeWholeParcels: currentTakeWholeParcels,
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
                site: index === 0 ? currentPlacementSite([building]) : cloneSingleFeature(building.geometry),
                ...(index === 0 ? { surroundings: {
                    groundSurface: singleContext.groundSurface,
                    groundBoundary: singleContext.groundBoundary,
                    takeWholeParcels: singleContext.takeWholeParcels
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

    function createSingleBuildingProposal(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        const authorInput = document.getElementById('proposalAuthor');
        const typeInput = document.getElementById('proposalType');
        const descriptionInput = document.getElementById('proposalDescription');
        const offerInput = document.getElementById('proposalOffer');

        const author = (typeof getProposalAuthorValue === 'function'
            ? getProposalAuthorValue()
            : (authorInput ? authorInput.value.trim() : ''));
        const proposalType = typeInput ? typeInput.value : 'Building(s)';
        const nameInput = document.getElementById('proposalName');
        const proposalName = (nameInput && nameInput.value ? nameInput.value.trim() : '')
            || (typeof generateDefaultProposalName === 'function' ? generateDefaultProposalName(proposalType) : proposalType);
        const description = descriptionInput ? descriptionInput.value.trim() : '';
        const offer = offerInput ? (typeof window.parseProposalOfferValue === 'function' ? window.parseProposalOfferValue(offerInput.value) : parseFloat(offerInput.value)) : NaN;

        if (!author) {
            showSingleBuildingAlert('please_enter_an_author_name', 'Please enter an author name.');
            return;
        }
        if (!proposalType) {
            showSingleBuildingAlert('please_choose_a_proposal_type', 'Please choose a proposal type.');
            return;
        }
        if (!description) {
            showSingleBuildingAlert('please_enter_a_description_for_the_proposal', 'Please enter a description for the proposal.');
            return;
        }
        if (!Number.isFinite(offer) || offer <= 0) {
            showSingleBuildingAlert('please_enter_a_valid_offer_amount_eur', 'Please enter a valid offer amount (EUR).');
            return;
        }

        const buildingMetaList = Array.isArray(pendingSingleBuildingMeta?.buildings)
            ? pendingSingleBuildingMeta.buildings
            : [];
        const pendingFeatureList = (typeof window !== 'undefined')
            ? (window.pendingSingleBuildingFeatures
                || (window.pendingSingleBuildingFeature ? [window.pendingSingleBuildingFeature] : []))
            : [];
        const preparedBuildings = buildingMetaList.map(b => {
            if (!b || !b.feature || !b.feature.geometry) return null;
            const feature = JSON.parse(JSON.stringify(b.feature));
            return {
                id: b.id,
                name: b.name,
                color: b.color,
                feature,
                height: Math.max(3, Number(b.height) || DEFAULT_HEIGHT_M),
                rotation: Number(b.rotation) || 0
            };
        }).filter(Boolean);

        if (!preparedBuildings.length) {
            pendingFeatureList.forEach(f => {
                if (f && f.geometry) {
                    try {
                        const clone = JSON.parse(JSON.stringify(f));
                        preparedBuildings.push({
                            id: null,
                            name: 'Building',
                            color: null,
                            feature: clone,
                            height: Math.max(3, Number(clone?.properties?.height) || DEFAULT_HEIGHT_M),
                            rotation: Number(clone?.properties?.rotation) || 0
                        });
                    } catch (_) { }
                }
            });
        }

        if (!preparedBuildings.length) {
            showSingleBuildingAlert('no_building_geometry_prepared_please_create_the_building_again', 'No building geometry prepared. Please create the building again.');
            return;
        }

        const blockName = (pendingSingleBuildingMeta && pendingSingleBuildingMeta.blockName) || (getSingleBuildingContext()?.blockName) || selectedBlockName || null;

        let finalParcelIds = [];
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (pendingSingleBuildingMeta && Array.isArray(pendingSingleBuildingMeta.parcelIds) && pendingSingleBuildingMeta.parcelIds.length > 0) {
            finalParcelIds = pendingSingleBuildingMeta.parcelIds.slice();
        }

        finalParcelIds = finalParcelIds
            .map(value => value != null ? value.toString() : null)
            .filter(Boolean);

        if (finalParcelIds.length === 0) {
            showSingleBuildingAlert('no_parcels_selected_for_this_proposal', 'No parcels selected for this proposal.');
            return;
        }

        const uniqueParcelIds = Array.from(new Set(finalParcelIds));

        const fabric = (typeof window !== 'undefined') ? window.LiveParcelFabric : null;
        if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
            showSingleBuildingAlert('proposal_storage_is_unavailable', 'Cadastral ground is unavailable.');
            return;
        }
        let cadastreParcelIds;
        try {
            cadastreParcelIds = fabric.cadastreIdsForParcelIds(uniqueParcelIds);
        } catch (_) {
            showSingleBuildingAlert('no_parcels_selected_for_this_proposal', 'The selected parcel ground is no longer current.');
            return;
        }

        const primaryBuilding = preparedBuildings[0];
        const proposedHeightMeters = Math.round(Number(primaryBuilding.height || currentHeightM || DEFAULT_HEIGHT_M));
        const proposedRotationDeg = Number(primaryBuilding.rotation || currentRotationDeg || 0);

        if (!primaryBuilding.feature.properties) {
            primaryBuilding.feature.properties = {};
        }
        primaryBuilding.feature.properties.height = proposedHeightMeters;
        primaryBuilding.feature.properties.rotation = proposedRotationDeg;
        primaryBuilding.feature.properties.footprintMode = 'polygon';
        delete primaryBuilding.feature.properties.width;
        delete primaryBuilding.feature.properties.length;
        delete primaryBuilding.feature.properties.chamfer;
        primaryBuilding.feature.properties.block = blockName;
        primaryBuilding.feature.properties.type = 'proposedBuildingSingle';

        const buildingFeatures = preparedBuildings.map(b => {
            if (!b.feature.properties) b.feature.properties = {};
            b.feature.properties.block = blockName;
            b.feature.properties.type = 'proposedBuildingSingle';
            b.feature.properties.height = Math.max(3, Number(b.height) || DEFAULT_HEIGHT_M);
            b.feature.properties.rotation = Number(b.rotation) || 0;
            b.feature.properties.footprintMode = 'polygon';
            delete b.feature.properties.width;
            delete b.feature.properties.length;
            delete b.feature.properties.chamfer;
            b.feature.properties.color = b.color;
            return b.feature;
        });

        const buildingProposalMetadata = {
            createdFrom: 'single-building',
            blockName: blockName,
            parameters: {
                height: proposedHeightMeters,
                rotation: proposedRotationDeg,
                footprintMode: 'polygon'
            }
        };

        const nowIso = new Date().toISOString();
        const offerCurrency = 'EUR';
        const geometryObject = {
            superParcel: null,
            lakeGraphics: null,
            parkGraphics: null,
            squareGraphics: null,
            buildings: buildingFeatures.map(f => ({
                type: f.type || 'Feature',
                geometry: f.geometry ? JSON.parse(JSON.stringify(f.geometry)) : null,
                properties: f.properties ? { ...f.properties } : {}
            })),
            reparcellizationPolygons: null
        };

        const proposal = {
            proposalId: null,
            name: proposalName,
            title: proposalName,
            proposalName,
            description: description || proposalName,
            author,
            createdAt: nowIso,
            updatedAt: nowIso,
            lifecycleStatus: 'draft',
            applied: false,
            tags: ['buildings'],
            lens: undefined,
            cadastreParcelIds,
            media: { screenshotUrl: null, imageUrl: null },
            goal: 'buildings',
            acquisitionStrategy: 'full',
            typologyType: 'block',
            boundaryAdjustmentType: null,
            offer,
            budget: offer,
            offerCurrency,
            budgetCurrency: offerCurrency,
            corridorType: null,
            blockName: blockName || null,
            geometry: geometryObject,
            authorName: author,
            type: 'building',
            buildingProposal: buildingProposalMetadata,
            acceptedParcelIds: []
        };

        // Capture the active lens so single-building proposals carry the expected pattern and metadata
        const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
        if (lensSnapshot.length) {
            proposal.lens = lensSnapshot;
        }

        const storage = (typeof Proposals !== 'undefined' && Proposals.storage) ? Proposals.storage : proposalStorage;
        const addProposalFn = storage && (storage.addProposal || storage.add);
        if (!storage || typeof addProposalFn !== 'function') {
            showSingleBuildingAlert('proposal_storage_is_unavailable', 'Proposal storage is unavailable.');
            return;
        }

        const proposalId = addProposalFn.call(storage, proposal, {
            selectedParcelIds: uniqueParcelIds
        });
        if (!proposalId) {
            showSingleBuildingAlert('a_proposal_with_the_same_parcels_already_exists', 'A proposal with the same parcels already exists.');
            return;
        }

        const primaryParcelId = uniqueParcelIds.length ? uniqueParcelIds[0] : null;

        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = null; } catch (_) { }
            try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
        }
        pendingSingleBuildingMeta = null;

        if (typeof multiParcelSelection !== 'undefined') {
            multiParcelSelection.clearSelection();
            if (typeof multiParcelSelection.updateUI === 'function') multiParcelSelection.updateUI();
        }

        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        if (typeof closeProposalDialog === 'function') {
            closeProposalDialog();
        }

        closeSingleBuildingMapEditor();

        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof focusProposalDetails === 'function') {
            const proposalKey = proposalId || null;
            focusProposalDetails(proposalKey, {
                parcelId: primaryParcelId,
                centerOnProposal: true
            });
        }

        if (blockName && typeof refreshBlockInfoProposalTab === 'function') {
            setTimeout(() => refreshBlockInfoProposalTab(blockName), 0);
        }

        setSingleBuildingStatus(
            'single_building_proposal_created_use_apply_when_ready',
            'Proposal "{{title}}" created. Use Apply to map from the proposal details when ready.',
            { title: proposalName }
        );
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
        singleMoveTogether = true;
        if (!singleBlockFeature) {
            setSingleBuildingStatus('select_a_block_first', 'Select a block first');
            return;
        }

        const modalText = {
            title: translateSingleBuildingText('modal.singleBuilding.title', 'Freeform'),
            closeLabel: translateSingleBuildingText('modal.singleBuilding.closeLabel', 'Close buildings modal'),
            cancel: translateSingleBuildingText('modal.singleBuilding.cancel', 'Cancel'),
            more: translateSingleBuildingText('modal.singleBuilding.more', 'Site & details'),
            confirm: translateSingleBuildingText('modal.singleBuilding.confirm', 'Done'),
            buildingsTitle: translateSingleBuildingText('modal.singleBuilding.buildingsTitle', 'Buildings'),
            addLabel: translateSingleBuildingText('modal.singleBuilding.addLabel', 'Duplicate building'),
            deleteLabel: translateSingleBuildingText('modal.singleBuilding.deleteLabel', 'Delete'),
            renameLabel: translateSingleBuildingText('modal.singleBuilding.renameLabel', 'Rename'),
            parametersTitle: translateSingleBuildingText('modal.singleBuilding.parametersTitle', 'Parameters'),
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
            surroundingsLabel: translateSingleBuildingText('modal.singleBuilding.surroundingsLabel', 'Surroundings'),
            surroundingsNone: translateSingleBuildingText('modal.singleBuilding.surroundingsNone', 'Leave as they are'),
            surroundingsPaved: translateSingleBuildingText('modal.singleBuilding.surroundingsPaved', 'Paved'),
            surroundingsGreen: translateSingleBuildingText('modal.singleBuilding.surroundingsGreen', 'Green'),
            parcelLabel: translateSingleBuildingText('modal.singleBuilding.parcelLabel', 'Building parcel'),
            parcelFootprint: translateSingleBuildingText('modal.singleBuilding.parcelFootprint', 'Footprint parcel'),
            parcelWhole: translateSingleBuildingText('modal.singleBuilding.parcelWhole', 'Take the whole parcels'),
            parcelInfo: translateSingleBuildingText(
                'modal.singleBuilding.parcelInfo',
                'By default the building forms its own parcel from its footprint and the rest of the land stays with its owner. Taking whole parcels makes them the building\u2019s parcel as they are.'
            ),
            surroundingsInfo: translateSingleBuildingText(
                'modal.singleBuilding.surroundingsInfo',
                'One choice for the whole parcel area around every building in this proposal. Existing buildings on these parcels are cleared either way.'
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
                    '2d': translateSingleBuildingText('modal.singleBuilding.mapHint', 'Drag the building or its corners. Tap an edge to add a corner.'),
                    model: translateSingleBuildingText('modal.singleBuilding.modelHint', 'Adjust the height and orbit to see the fit. Use 2D to reshape the footprint.')
                },
                tools: `
                    <button id="single-rotate-counterclockwise" class="btn" type="button" title="${modalText.rotateCounterclockwiseLabel}" aria-label="${modalText.rotateCounterclockwiseLabel}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> 5°</button>
                    <button id="single-rotate-clockwise" class="btn" type="button" title="${modalText.rotateClockwiseLabel}" aria-label="${modalText.rotateClockwiseLabel}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> 5°</button>
                `,
                content: `                        <label class="on-map-editor__placement-option"><input id="single-move-together" type="checkbox" checked><span>${translateSingleBuildingText('modal.singleBuilding.moveTogether', 'Move whole proposal')}</span></label>
                        <div class="on-map-building__height">
                            <label for="single-height-slider">${modalText.heightLabel} <strong id="single-height-value">${DEFAULT_HEIGHT_M}</strong></label>
                            <input type="range" id="single-height-slider" min="3" max="250" step="1" value="${DEFAULT_HEIGHT_M}">
                        </div>
                        <div class="on-map-building__metrics"><span>${modalText.densityFootprint}</span><strong id="single-building-footprint-summary">—</strong></div>
                        <details class="on-map-building__details">
                            <summary>${modalText.more}</summary>
                            <div class="on-map-building__scroll">
                                <div class="building-picker-row">
                                    <select id="single-building-selector" aria-label="${modalText.buildingsTitle}"></select>
                                    <input type="text" id="single-building-name-input" maxlength="20" hidden aria-label="${modalText.renameLabel}">
                                    <button id="single-building-rename" class="btn btn-quiet btn-icon" type="button" aria-label="${modalText.renameLabel}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
                                    <button id="single-building-delete" class="btn btn-quiet btn-icon" type="button" aria-label="${modalText.deleteLabel}"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                                    <button id="single-building-add" class="btn btn-quiet btn-icon" type="button" aria-label="${modalText.addLabel}"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
                                </div>
                                <div class="parameter-group">
                                    <label for="single-ground-treatment">${modalText.surroundingsLabel}</label>
                                    <select id="single-ground-treatment"><option value="none">${modalText.surroundingsNone}</option><option value="paved">${modalText.surroundingsPaved}</option><option value="green">${modalText.surroundingsGreen}</option></select>
                                    <p class="parameter-info-text">${modalText.surroundingsInfo}</p>
                                </div>
                                <div class="parameter-group">
                                    <label for="single-parcel-mode">${modalText.parcelLabel}</label>
                                    <select id="single-parcel-mode"><option value="footprint">${modalText.parcelFootprint}</option><option value="whole">${modalText.parcelWhole}</option></select>
                                    <p class="parameter-info-text">${modalText.parcelInfo}</p>
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
                                <button id="single-building-geojson-upload" class="btn btn-block" type="button">${modalText.uploadGeojsonLabel}</button>
                                <input id="single-building-geojson-input" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden>
                            </div>
                        </details>
`,
                footer: `
                        <button id="single-building-undo" type="button" class="btn btn-quiet" disabled>${translateSingleBuildingText('onMapEditor.undo', 'Undo')}</button>
                        <button id="single-building-cancel" type="button" class="btn btn-quiet">${modalText.cancel}</button>
                        <button id="single-building-confirm" type="button" class="btn btn-primary">${modalText.confirm}</button>
                    `
            });
            if (!singleSession) return false;
            singleEditor = singleSession.root;
            singleSession.tools.setAttribute('role', 'toolbar');
            singleSession.tools.setAttribute('aria-label', modalText.rotationLabel);
            singleEditor.querySelector('details').addEventListener('toggle', positionSingleBuildingToolbar);
            document.getElementById('single-building-cancel').addEventListener('click', requestCloseSingleBuildingMapEditor);
            singleBuildingDesignChanges().start(document);
            document.getElementById('single-building-confirm').addEventListener('click', confirmSingleBuilding);

            const hSlider = document.getElementById('single-height-slider');
            hSlider.addEventListener('input', (e) => {
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

            document.getElementById('single-move-together').addEventListener('change', event => {
                singleMoveTogether = event.target.checked;
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
                    updateGroundPreview();
                    updateSingleBuildingPreview();
                    autosaveSingleBuildingDraft();
                });
            }

            const parcelModeSelect = document.getElementById('single-parcel-mode');
            if (parcelModeSelect) {
                parcelModeSelect.addEventListener('change', (e) => {
                    ensureSingleBuildingHistory().record();
                    currentTakeWholeParcels = e.target.value === 'whole';
                    autosaveSingleBuildingDraft();
                });
            }

            const geojsonButton = document.getElementById('single-building-geojson-upload');
            const geojsonInput = document.getElementById('single-building-geojson-input');
            if (geojsonButton && geojsonInput) {
                geojsonButton.addEventListener('click', () => geojsonInput.click());
                geojsonInput.addEventListener('change', event => {
                    const file = event.target?.files?.[0];
                    if (file) loadSingleBuildingGeoJSON(file);
                    event.target.value = '';
                });
            }

            const selector = document.getElementById('single-building-selector');
            const addBtn = document.getElementById('single-building-add');
            const deleteBtn = document.getElementById('single-building-delete');
            const renameBtn = document.getElementById('single-building-rename');
            const nameInput = document.getElementById('single-building-name-input');

            if (renameBtn && nameInput && selector) {
                renameBtn.addEventListener('click', () => {
                    const isInputVisible = !nameInput.hidden;
                    if (isInputVisible) {
                        nameInput.hidden = true;
                        selector.hidden = false;
                        const newName = nameInput.value.trim().substring(0, 20);
                        const active = getActiveBuilding();
                        if (active && newName && newName !== active.name) {
                            active.name = newName;
                            if (active.feature && active.feature.properties) {
                                active.feature.properties.name = newName;
                            }
                            refreshBuildingSelector();
                            updateRectangleLayers();
                            try { updateSingleBuildingPreview(); } catch (_) { }
                        }
                    } else {
                        const active = getActiveBuilding();
                        if (active) {
                            nameInput.value = active.name;
                            selector.hidden = true;
                            nameInput.hidden = false;
                            nameInput.focus();
                        }
                    }
                });

                const commitNameChange = () => {
                    const newName = nameInput.value.trim().substring(0, 20);
                    const active = getActiveBuilding();
                    if (active && newName) {
                        active.name = newName;
                        if (active.feature && active.feature.properties) {
                            active.feature.properties.name = newName;
                        }
                        refreshBuildingSelector();
                        updateRectangleLayers();
                    }
                };

                nameInput.addEventListener('change', commitNameChange);
                nameInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        commitNameChange();
                        nameInput.hidden = true;
                        selector.hidden = false;
                    }
                });
            }

            if (selector) {
                selector.addEventListener('change', (e) => {
                    const id = Number(e.target.value);
                    if (Number.isFinite(id)) {
                        setActiveBuilding(id, { refreshUI: true });
                    }
                });
            }
            if (addBtn) {
                addBtn.addEventListener('click', duplicateActiveBuilding);
            }
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => {
                    removeActiveBuilding();
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
        singleBuildingSeedGroundTreatment = null;
        currentTakeWholeParcels = singleBuildingSeedTakeWholeParcels === true;
        singleBuildingSeedTakeWholeParcels = null;
        const groundSelectEl = document.getElementById('single-ground-treatment');
        if (groundSelectEl) groundSelectEl.value = currentGroundTreatment;
        const parcelModeEl = document.getElementById('single-parcel-mode');
        if (parcelModeEl) parcelModeEl.value = currentTakeWholeParcels ? 'whole' : 'footprint';
        const initialPlacement = computeInitialPlacement(singleBlockFeature);
        const startCenter = initialPlacement.center || getBlockCentroid(singleBlockFeature);
        currentHeightM = initialPlacement.width || DEFAULT_HEIGHT_M;
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
        refreshBuildingSelector();
        if (!initialEntry) throw new Error('Could not fit a building inside the selected site.');
        setActiveBuilding(initialEntry.id, { refreshUI: true });

        // Frame the editable object once. Later edits leave the user's camera alone.
        singleSession.fitFeature(singleRectFeature);
        syncSingleBuildingView();
        ensureSingleBuildingHistory();
        singleBuildingDesignChanges().capture();
        document.getElementById('single-height-slider').focus({ preventScroll: true });
        return true;
    }

    // `initialBuildings` (optional) reopens the editor on previously-saved building features
    // instead of one default building — used by "Copy into new proposal".
    // `initialGroundTreatment` restores the proposal's surroundings choice the same way.
    function openSingleBuildingForParcels({ blockName, parcelIds, initialBuildings = null, site = null, initialGroundTreatment = null, initialTakeWholeParcels = null, initialGroundBoundary = null }) {
        if (singleEditor) return false;
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        const siteGeometry = site?.type === 'Feature' ? site.geometry : site;
        const siteOnly = !ids.length && ['Polygon', 'MultiPolygon'].includes(siteGeometry?.type);
        if (!ids.length && !siteOnly) {
            setSingleBuildingStatus('select_parcels_before_launching_the_single_building_tool', 'Select a site before launching the single building tool.');
            return;
        }
        singleBuildingSeedBuildings = (Array.isArray(initialBuildings) && initialBuildings.length) ? initialBuildings : null;
        singleBuildingSeedGroundTreatment = initialGroundTreatment;
        singleBuildingSeedGroundBoundary = initialGroundBoundary;
        singleBuildingSeedTakeWholeParcels = initialTakeWholeParcels;
        const liveParcels = siteOnly ? [{ id: 'site:single', feature: {
            type: 'Feature', properties: { parcelId: 'site:single', synthetic: true, siteParcel: true },
            geometry: cloneSingleFeature(siteGeometry)
        } }] : singleBuildingParcelsForIds(ids);
        if (!siteOnly && liveParcels.length !== ids.length) {
            setSingleBuildingStatus('could_not_resolve_parcel_data_for_the_single_building_tool', 'Could not resolve parcel data for the single building tool.');
            return;
        }
        singleBuildingOverrideContext = {
            blockName: blockName || describeSingleBuildingSelection(ids),
            parcels: liveParcels,
            parcelIds: ids,
            site: cloneSingleFeature(site)
        };
        return showSingleBuildingMapEditor();
    }

    // Uploads enter the same placement editor; only Done saves the design and completes the
    // upload caller's form status. The mesh reference stays attached to the editable footprint.
    function createSingleBuildingFromUpload({ blockName, parcelIds, width, length, height, modelName, modelUrl, onConfirm } = {}) {
        if (singleEditor || window.OnMapEditor?.isActive?.()) return false;
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        if (!ids.length) {
            setSingleBuildingStatus('select_parcels_before_launching_the_single_building_tool', 'Select parcels before uploading a building.');
            return false;
        }
        const liveParcels = singleBuildingParcelsForIds(ids);
        if (liveParcels.length !== ids.length) {
            setSingleBuildingStatus('could_not_resolve_parcel_data_for_the_single_building_tool', 'Could not resolve parcel data for the uploaded building.');
            return false;
        }

        singleBuildingOverrideContext = { blockName: blockName || describeSingleBuildingSelection(ids), parcels: liveParcels, parcelIds: ids };
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
        const entry = addNewBuildingEntry(placement.center, {
            width: Number(width) || placement.width || DEFAULT_WIDTH_M,
            length: Number(length) || placement.length || DEFAULT_LENGTH_M,
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
    window.createSingleBuildingProposal = createSingleBuildingProposal;
    window.createSingleBuildingFromUpload = createSingleBuildingFromUpload;
    window.clearSingleBuildingPendingState = clearSingleBuildingPendingState;
})();
