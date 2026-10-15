/**
 * Row House (row of houses) functionality.
 * 
 * This file contains the functionality for row houses - a single line/row of houses whose
 * initial parametric footprint can then be edited as an arbitrary polygon.
 * 
 * Unlike block typology which creates ring-shaped buildings with courtyards,
 * row typology starts from a simple chamfered rectangle for linear housing developments.
 */

(function () {
    // Modal state
    let rowHouseModal = null;
    let rowHouseMap = null;
    let rowHouseGenerationTimer = null;
    let rowHouseParcelLayer = null;
    let rowHouseBuildingLayer = null;
    // A row is one bar, but the houses under it belong to individual owners: the bar is cut into one
    // house per constituent parcel, in distinct shades, so a row reads as a terrace rather than one
    // extruded slab — and the gain lands on the parcel that earned it. See urban-rule-massing.md.
    // Default "exactly this height" preserves what the row editor has always drawn.
    const DEFAULT_ROW_RULE_KIND = 'exact';
    const DEFAULT_ROW_MIN_PLOT_AREA_M2 = 50;
    let rowUnitLayers = [];
    let rowExcludedLayers = [];
    let rowRuleKind = DEFAULT_ROW_RULE_KIND;
    let rowMinHeightM = 0;
    let rowMinPlotAreaM2 = DEFAULT_ROW_MIN_PLOT_AREA_M2;
    let rowVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
    let rowUnits = [];        // per-parcel permitted massing — what the proposal saves
    let rowBuildOut = [];     // one example built under it — presentation only
    let rowExcluded = [];
    let rowHousePolygonEditor = null;
    let rowHousePendingVertexActionIndex = null;
    let rowHouseHistory = null;
    let rowHouseUndoButton = null;
    let rowHouseHistoryKeydown = null;
    let rowHouseManualMode = false;
    let generatedRowHouseFeature = null;
    let rowHouseBlockNameOverride = null;
    let rowHouseBlock = null;
    let pendingRowHouseProposalContext = null;

    // Default parameter values
    const DEFAULT_BUILDING_LENGTH = 40; // meters (length along longest side, will be auto-calculated)
    const DEFAULT_BUILDING_WIDTH = 10; // meters (depth/width of row, perpendicular to longest side)
    const DEFAULT_BUILDING_HEIGHT = 12; // meters
    const DEFAULT_CHAMFER = 0; // meters (corner cut length)
    let currentBuildingLength = DEFAULT_BUILDING_LENGTH;
    let currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
    let currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
    let currentChamfer = DEFAULT_CHAMFER;
    let maxBuildingLength = DEFAULT_BUILDING_LENGTH; // Will be calculated based on superparcel

    // Position and rotation state (in meters, relative to superparcel centroid)
    let currentOffsetX = 0; // meters offset in X direction
    let currentOffsetY = 0; // meters offset in Y direction
    let currentRotation = 0; // radians, rotation around the building center
    let baseRotation = 0; // radians, initial rotation based on longest side

    // Parameters to restore when the modal next opens, instead of the defaults. Set by
    // openRowHouseForParcels({ initialParameters }); consumed once by showRowHouseModal().
    let rowHouseSeedParameters = null;
    let rowHouseSeedFeature = null;

    // Interaction state
    let isDragging = false;
    let dragStartLatLng = null;
    let dragStartOffset = null;
    let dragStartFeature = null;
    let dragLastValidFeature = null;
    let dragMapWasEnabled = true;

    // Cached superparcel data for boundary checking
    let cachedSuperparcel = null;
    let cachedSuperparcelMeters = null;
    let cachedCentroid = null;
    let cachedMetersPerDegLng = null;
    let cachedMetersPerDegLat = null;

    // Helper functions
    function formatRowHouseText(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function translateRowHouseText(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            { const translated = api.t(key, params); if (translated !== key) return translated; }
        }
        return formatRowHouseText(fallback, params);
    }

    function showRowHouseAlert(key, fallback, params = {}) {
        const message = key
            ? translateRowHouseText(`alerts.messages.${key}`, fallback, params)
            : translateRowHouseText('', fallback, params);
        window.CbDialog.alert(message);
        return message;
    }

    function showRowHouseEditorAlert(key, fallback) {
        const message = translateRowHouseText(`rowHouses.modal.${key}`, fallback);
        window.CbDialog.alert(message);
        return message;
    }

    function setRowHouseInfo(key, fallback, params = {}) {
        const infoElement = document.getElementById('rowhouse-info');
        if (!infoElement) return;
        if (key) {
            infoElement.setAttribute('data-i18n-key', key);
            infoElement.setAttribute('data-i18n-attr', 'text');
        } else {
            infoElement.removeAttribute('data-i18n-key');
        }
        if (params && Object.keys(params).length > 0) {
            try {
                infoElement.setAttribute('data-i18n-params', JSON.stringify(params));
            } catch (_) {
                infoElement.removeAttribute('data-i18n-params');
            }
        } else {
            infoElement.removeAttribute('data-i18n-params');
        }
        infoElement.textContent = translateRowHouseText(key, fallback, params);
    }

    function setPendingRowHouseProposalContext(ctx) {
        pendingRowHouseProposalContext = ctx || null;
        if (typeof window !== 'undefined') {
            window.pendingRowHouseProposalContext = pendingRowHouseProposalContext;
        }
    }

    function cloneRowHouseFeature(feature) {
        if (!feature) return null;
        try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
    }

    function rowHouseOuterRing(feature) {
        if (!feature?.geometry || feature.geometry.type !== 'Polygon') return null;
        const ring = feature.geometry.coordinates?.[0];
        return Array.isArray(ring) && ring.length >= 4 ? ring : null;
    }

    function rowHouseGeneratorSite(block) {
        if (block?.generatorSite?.geometry) return cloneRowHouseFeature(block.generatorSite);
        if (block?.site?.geometry) return cloneRowHouseFeature(block.site);
        return robustUnionLocal((block?.parcels || []).map(parcel => parcel?.feature).filter(Boolean));
    }

    function rowHouseFeatureWithRing(feature, ring) {
        const next = cloneRowHouseFeature(feature);
        if (!next?.geometry || !Array.isArray(ring) || ring.length < 3) return null;
        const open = window.PolygonGeometryEditor?.openRing?.(ring) || ring.slice();
        if (open.length < 3) return null;
        next.geometry = {
            type: 'Polygon',
            coordinates: [[...open, [open[0][0], open[0][1]]]]
        };
        return next;
    }

    function rowHouseFeatureValid(feature) {
        try {
            if (!feature?.geometry || feature.geometry.type !== 'Polygon' || turf.area(feature) < 0.5) return false;
            if (typeof turf.kinks === 'function' && turf.kinks(feature).features.length) return false;
            if (rowHouseModal?.placement?.locked) return rowHouseModal.placement.accepts(feature) === true;
            return true;
        } catch (_) {
            return false;
        }
    }

    function rowHousePlacementLocked() { return rowHouseModal?.placement?.locked === true; }

    function rowHouseGeometrySnapshot() {
        return {
            feature: cloneRowHouseFeature(generatedRowHouseFeature),
            manualMode: rowHouseManualMode,
            length: currentBuildingLength, width: currentBuildingWidth, height: currentBuildingHeight,
            chamfer: currentChamfer, offsetX: currentOffsetX, offsetY: currentOffsetY,
            rotation: currentRotation, seed: rowVariationSeed
        };
    }

    function restoreRowHouseGeometrySnapshot(snapshot) {
        if (!snapshot) return;
        generatedRowHouseFeature = cloneRowHouseFeature(snapshot.feature);
        rowHouseManualMode = snapshot.manualMode === true;
        currentBuildingLength = snapshot.length ?? currentBuildingLength;
        currentBuildingWidth = snapshot.width ?? currentBuildingWidth;
        currentBuildingHeight = snapshot.height ?? currentBuildingHeight;
        currentChamfer = snapshot.chamfer ?? currentChamfer;
        currentOffsetX = snapshot.offsetX ?? currentOffsetX;
        currentOffsetY = snapshot.offsetY ?? currentOffsetY;
        currentRotation = snapshot.rotation ?? currentRotation;
        rowVariationSeed = snapshot.seed ?? rowVariationSeed;
        syncRowHouseGeometryControls();
        if (generatedRowHouseFeature) {
            rowHouseModal?.placement?.update?.(generatedRowHouseFeature);
            displayRowHouseBuildingInModal(generatedRowHouseFeature);
            autosaveRowHouseDraft();
        }
    }

    function ensureRowHouseHistory() {
        if (rowHouseHistory || !window.GeometryEditHistory?.create || !rowHouseMap) return rowHouseHistory;
        rowHouseHistory = window.GeometryEditHistory.create({
            capture: rowHouseGeometrySnapshot,
            restore: restoreRowHouseGeometrySnapshot
        });
        rowHouseHistoryKeydown = rowHouseHistory.bindKeyboard(document, { enabled: () => !!rowHouseModal });
        try {
            rowHouseUndoButton = document.createElement('button');
            rowHouseUndoButton.type = 'button';
            rowHouseUndoButton.className = 'map-shell-button geom-undo-button';
            rowHouseUndoButton.title = translateRowHouseText('onMapEditor.undo', 'Undo (Cmd/Ctrl+Z)');
            rowHouseUndoButton.setAttribute('aria-label', rowHouseUndoButton.title);
            rowHouseUndoButton.textContent = '↶';
            rowHouseUndoButton.disabled = true;
            L.DomEvent?.disableClickPropagation?.(rowHouseUndoButton);
            L.DomEvent?.disableScrollPropagation?.(rowHouseUndoButton);
            rowHouseMap.getContainer()?.appendChild(rowHouseUndoButton);
            rowHouseHistory.bindButton(rowHouseUndoButton);
        } catch (_) { rowHouseUndoButton = null; }
        return rowHouseHistory;
    }

    function syncRowHouseGeometryControls() {
        const controls = [
            ['rowhouse-length-slider', currentBuildingLength],
            ['rowhouse-width-slider', currentBuildingWidth],
            ['rowhouse-chamfer-slider', currentChamfer],
            ['rowhouse-height-slider', currentBuildingHeight]
        ];
        controls.forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.value = String(value);
        });
        const labels = [
            ['rowhouse-length-value', currentBuildingLength, 1], ['rowhouse-width-value', currentBuildingWidth, 1],
            ['rowhouse-height-value', currentBuildingHeight, 0], ['rowhouse-chamfer-value', currentChamfer, 1]
        ];
        labels.forEach(([id, value, digits]) => {
            const element = document.getElementById(id);
            if (element) element.textContent = CbFormat.formatNumber(Number(value), { maxFractionDigits: digits, minFractionDigits: digits });
        });
        ['rowhouse-length-slider', 'rowhouse-width-slider', 'rowhouse-chamfer-slider'].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = rowHouseManualMode;
        });
        const toggle = document.getElementById('rowhouse-manual-toggle');
        if (toggle) {
            toggle.setAttribute('data-i18n-key', rowHouseManualMode
                ? 'rowHouses.modal.returnGenerated' : 'rowHouses.modal.editShape');
            toggle.setAttribute('data-i18n-attr', 'text');
            toggle.textContent = rowHouseManualMode
                ? translateRowHouseText('rowHouses.modal.returnGenerated', 'Discard manual shape and return to generated geometry')
                : translateRowHouseText('rowHouses.modal.editShape', 'Edit shape manually');
            toggle.setAttribute('aria-pressed', rowHouseManualMode ? 'true' : 'false');
        }
    }

    async function toggleRowHouseManualMode() {
        if (!generatedRowHouseFeature?.geometry) return;
        if (!rowHouseManualMode) {
            rowHouseHistory?.record?.();
            rowHouseManualMode = true;
        } else {
            const proceed = await window.CbDialog.confirm(
                translateRowHouseText('rowHouses.modal.confirmReturnGenerated', 'Discard manual edits and return to the generated shape?'),
                { destructive: true, okText: translateRowHouseText('proposalDrafts.discardDesign.confirm', 'Discard') }
            );
            if (!proceed) return;
            rowHouseHistory?.record?.();
            rowHouseManualMode = false;
        }
        syncRowHouseGeometryControls();
        if (rowHouseManualMode) renderRowHousePolygonEditor();
        else generateRowHouseInModal();
        autosaveRowHouseDraft();
    }

    function destroyRowHousePolygonEditor() {
        if (!rowHousePolygonEditor) return;
        try { rowHousePolygonEditor.destroy(); } catch (_) { }
        rowHousePolygonEditor = null;
    }

    function getRowHouseDisplayName() {
        if (rowHouseBlockNameOverride) return rowHouseBlockNameOverride;
        return translateRowHouseText('rowHouses.modal.messages.selectedParcels', 'Selected Parcels');
    }

    function getActiveRowHouseBlock() {
        if (rowHouseBlock && Array.isArray(rowHouseBlock.parcels) && rowHouseBlock.parcels.length > 0) {
            return rowHouseBlock;
        }
        return null;
    }

    function describeRowHouseParcelSelection(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return translateRowHouseText('rowHouses.modal.messages.selectedParcels', 'Selected Parcels');
        if (ids.length === 1) return translateRowHouseText('rowHouses.modal.messages.singleParcelLabel', 'Parcel {{id}}', { id: ids[0] });
        // The shared plural key: Croatian and Serbian need a different form for 2–4 parcels.
        return translateRowHouseText('proposals.autoName.parcels', '{{count}} parcels', { count: ids.length });
    }

    function rowHouseParcelsForIds(parcelIds) {
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

    // --- Geometry utilities ---

    // Sanitize and convert polygon to single largest polygon
    function toSingleLargestPolygonLocal(feature) {
        if (typeof toSingleLargestPolygon === 'function') {
            return toSingleLargestPolygon(feature);
        }
        if (!feature || !feature.geometry) return feature;
        const geom = feature.geometry;
        if (geom.type === 'Polygon') return feature;
        if (geom.type === 'MultiPolygon') {
            let maxArea = -Infinity;
            let largestCoords = null;
            geom.coordinates.forEach(poly => {
                try {
                    const tempFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } };
                    const area = turf.area(tempFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly;
                    }
                } catch (_) { }
            });
            if (largestCoords) {
                return {
                    type: 'Feature',
                    properties: feature.properties || {},
                    geometry: { type: 'Polygon', coordinates: largestCoords }
                };
            }
        }
        return feature;
    }

    // Robust union of parcel features
    function robustUnionLocal(features) {
        if (typeof robustUnion === 'function') {
            return robustUnion(features);
        }
        if (!Array.isArray(features) || features.length === 0) return null;
        if (features.length === 1) return features[0];
        try {
            let acc = features[0];
            for (let i = 1; i < features.length; i++) {
                try { acc = turf.union(acc, features[i]) || acc; } catch (_) { }
            }
            return acc;
        } catch (_) {
            return features[0];
        }
    }

    // Robust negative buffer
    function robustNegativeBufferLocal(feature, distance) {
        if (typeof robustNegativeBuffer === 'function') {
            return robustNegativeBuffer(feature, distance);
        }
        if (!feature || !feature.geometry || distance <= 0) return feature;
        try {
            const buffered = turf.buffer(feature, -distance / 1000, { units: 'kilometers', steps: 16 });
            return buffered;
        } catch (_) {
            return feature;
        }
    }

    // Apply chamfer to polygon corners (45-degree cuts)
    function applyChamferToPolygon(feature, chamferLength) {
        if (!feature || !feature.geometry || chamferLength <= 0) return feature;

        const geom = feature.geometry;
        if (geom.type !== 'Polygon') return feature;

        const ring = geom.coordinates[0];
        if (!Array.isArray(ring) || ring.length < 4) return feature;

        // Work in meters using centroid as origin
        const centroid = turf.centroid(feature);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = window.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        // Convert to local meters
        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];
        const toDegrees = ([x, y]) => [
            x / metersPerDegLng + cLng,
            y / metersPerDegLat + cLat
        ];

        // Convert ring to meters (excluding closing point)
        const meterRing = ring.slice(0, -1).map(toMeters);
        const n = meterRing.length;

        // Calculate chamfered ring
        // Chamfer is defined as an isosceles triangle cut from each corner.
        // chamferLength = the length of each equal leg of the triangle,
        // measured from the corner vertex along each adjacent edge.
        const chamferedRing = [];

        for (let i = 0; i < n; i++) {
            const prev = meterRing[(i - 1 + n) % n];
            const curr = meterRing[i];
            const next = meterRing[(i + 1) % n];

            // Vector from current to previous
            const toPrev = [prev[0] - curr[0], prev[1] - curr[1]];
            const lenToPrev = Math.sqrt(toPrev[0] * toPrev[0] + toPrev[1] * toPrev[1]);

            // Vector from current to next
            const toNext = [next[0] - curr[0], next[1] - curr[1]];
            const lenToNext = Math.sqrt(toNext[0] * toNext[0] + toNext[1] * toNext[1]);

            if (lenToPrev < 0.001 || lenToNext < 0.001) {
                chamferedRing.push(curr);
                continue;
            }

            // Limit chamfer to not exceed 40% of either adjacent edge length
            const effectiveChamfer = Math.min(chamferLength, lenToPrev * 0.4, lenToNext * 0.4);

            if (effectiveChamfer < 0.001) {
                chamferedRing.push(curr);
                continue;
            }

            // Normalize vectors
            const normPrev = [toPrev[0] / lenToPrev, toPrev[1] / lenToPrev];
            const normNext = [toNext[0] / lenToNext, toNext[1] / lenToNext];

            // Point along edge toward previous, at chamferLength distance from corner
            const p1 = [
                curr[0] + normPrev[0] * effectiveChamfer,
                curr[1] + normPrev[1] * effectiveChamfer
            ];

            // Point along edge toward next, at chamferLength distance from corner
            const p2 = [
                curr[0] + normNext[0] * effectiveChamfer,
                curr[1] + normNext[1] * effectiveChamfer
            ];

            // Replace the corner vertex with two points (the chamfer cut)
            chamferedRing.push(p1);
            chamferedRing.push(p2);
        }

        // Convert back to degrees and close the ring
        const degreesRing = chamferedRing.map(toDegrees);
        if (degreesRing.length > 0) {
            degreesRing.push([...degreesRing[0]]);
        }

        return {
            type: 'Feature',
            properties: { ...feature.properties },
            geometry: {
                type: 'Polygon',
                coordinates: [degreesRing]
            }
        };
    }

    // Generate row house polygon
    function generateRowHousePolygon(block, length, width, chamfer, offsetX = 0, offsetY = 0, rotation = 0) {
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return null;
        }

        // An authored site can extend beyond the currently selected child parcels. Keep it as
        // the geometry boundary while parcel features still define ownership and row splitting.
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = rowHouseGeneratorSite(block) || robustUnionLocal(parcelFeatures);

        if (!superparcel) {
            throw new Error('Failed to create superparcel');
        }

        // Sanitize polygon
        if (typeof sanitizePolygonFeature === 'function') {
            superparcel = sanitizePolygonFeature(superparcel) || superparcel;
        }
        superparcel = toSingleLargestPolygonLocal(superparcel) || superparcel;

        if (!superparcel || !superparcel.geometry) {
            throw new Error('Failed to process superparcel');
        }

        // Get the exterior ring of the superparcel
        const geom = superparcel.geometry;
        let ring;
        if (geom.type === 'Polygon') {
            ring = geom.coordinates[0];
        } else if (geom.type === 'MultiPolygon') {
            // Use the largest polygon
            let maxArea = 0;
            for (const poly of geom.coordinates) {
                const area = Math.abs(turf.area(turf.polygon([poly[0]])));
                if (area > maxArea) {
                    maxArea = area;
                    ring = poly[0];
                }
            }
        }

        if (!ring || ring.length < 4) {
            throw new Error('Invalid superparcel geometry');
        }

        // Convert to meters using centroid as origin for accurate distance calculations
        const centroid = turf.centroid(superparcel);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = window.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        // Cache for boundary checking
        cachedSuperparcel = superparcel;
        cachedCentroid = [cLng, cLat];
        cachedMetersPerDegLng = metersPerDegLng;
        cachedMetersPerDegLat = metersPerDegLat;

        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];
        const toDegrees = ([x, y]) => [
            x / metersPerDegLng + cLng,
            y / metersPerDegLat + cLat
        ];

        // Convert ring to meters (excluding closing point)
        const meterRing = ring.slice(0, -1).map(toMeters);
        cachedSuperparcelMeters = meterRing;
        const n = meterRing.length;

        // Step 1: Find the longest straight side of the superparcel to determine orientation
        let longestSideLength = 0;
        let longestSideStart = null;
        let longestSideEnd = null;

        for (let i = 0; i < n; i++) {
            const p1 = meterRing[i];
            const p2 = meterRing[(i + 1) % n];
            const dx = p2[0] - p1[0];
            const dy = p2[1] - p1[1];
            const sideLen = Math.sqrt(dx * dx + dy * dy);

            if (sideLen > longestSideLength) {
                longestSideLength = sideLen;
                longestSideStart = p1;
                longestSideEnd = p2;
            }
        }

        if (!longestSideStart || !longestSideEnd || longestSideLength < 0.1) {
            throw new Error('Could not find valid longest side');
        }

        // Step 2: Calculate the base direction vector of the longest side
        const dx = longestSideEnd[0] - longestSideStart[0];
        const dy = longestSideEnd[1] - longestSideStart[1];
        const sideLength = longestSideLength;

        // Base angle from longest side
        baseRotation = Math.atan2(dy, dx);

        // Total rotation = base + user rotation
        const totalRotation = baseRotation + rotation;

        // Unit vector along the rotated length direction
        const ux = Math.cos(totalRotation);
        const uy = Math.sin(totalRotation);

        // Perpendicular unit vector (width direction)
        const perpX = -uy;
        const perpY = ux;

        // Step 3: Create rectangle centered at offset position
        const halfLength = length / 2;
        const halfWidth = width / 2;

        // Rectangle corners centered at offset position
        const corner1 = [offsetX - halfLength * ux - halfWidth * perpX, offsetY - halfLength * uy - halfWidth * perpY];
        const corner2 = [offsetX + halfLength * ux - halfWidth * perpX, offsetY + halfLength * uy - halfWidth * perpY];
        const corner3 = [offsetX + halfLength * ux + halfWidth * perpX, offsetY + halfLength * uy + halfWidth * perpY];
        const corner4 = [offsetX - halfLength * ux + halfWidth * perpX, offsetY - halfLength * uy + halfWidth * perpY];

        // Rectangle vertices in order (closed ring)
        const rectMeters = [corner1, corner2, corner3, corner4, corner1];

        // Convert back to degrees
        const rectDegrees = rectMeters.map(toDegrees);

        // Create the base rectangle feature
        let buildingPolygon = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [rectDegrees]
            }
        };

        // Apply the chamfer to the base rectangle
        if (chamfer > 0) {
            buildingPolygon = applyChamferToPolygon(buildingPolygon, chamfer);
        }

        // Set properties
        buildingPolygon.properties.type = 'proposedRowHouse';
        buildingPolygon.properties.length = length;
        buildingPolygon.properties.width = width;
        buildingPolygon.properties.chamfer = chamfer;
        buildingPolygon.properties.height = Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT);
        buildingPolygon.properties.block = getRowHouseDisplayName();
        buildingPolygon.properties.longestSideLength = longestSideLength;
        buildingPolygon.properties.offsetX = offsetX;
        buildingPolygon.properties.offsetY = offsetY;
        buildingPolygon.properties.rotation = rotation;

        // Store the pre-chamfer corners for reference
        const cornersInDegrees = [
            toDegrees(corner1),
            toDegrees(corner2),
            toDegrees(corner3),
            toDegrees(corner4)
        ];
        buildingPolygon.properties._corners = cornersInDegrees;

        // Store midpoints of rectangle sides for rotation handles (avoiding chamfered corners)
        buildingPolygon.properties._sideMidpoints = [
            // Midpoint of side 1-2 (bottom in length direction)
            [(cornersInDegrees[0][0] + cornersInDegrees[1][0]) / 2, (cornersInDegrees[0][1] + cornersInDegrees[1][1]) / 2],
            // Midpoint of side 2-3 (right in width direction)
            [(cornersInDegrees[1][0] + cornersInDegrees[2][0]) / 2, (cornersInDegrees[1][1] + cornersInDegrees[2][1]) / 2],
            // Midpoint of side 3-4 (top in length direction)
            [(cornersInDegrees[2][0] + cornersInDegrees[3][0]) / 2, (cornersInDegrees[2][1] + cornersInDegrees[3][1]) / 2],
            // Midpoint of side 4-1 (left in width direction)
            [(cornersInDegrees[3][0] + cornersInDegrees[0][0]) / 2, (cornersInDegrees[3][1] + cornersInDegrees[0][1]) / 2]
        ];

        return buildingPolygon;
    }

    // Calculate the maximum building dimensions that fit within the superparcel with 1m margin
    // Also sets up cached values for consistent boundary checking
    function calculateMaxBuildingDimensions(block) {
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Use the authored site as the fit boundary when one was supplied; parcel features remain
        // the ownership inputs for the generated row.
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = rowHouseGeneratorSite(block) || robustUnionLocal(parcelFeatures);

        if (!superparcel) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Sanitize polygon
        if (typeof sanitizePolygonFeature === 'function') {
            superparcel = sanitizePolygonFeature(superparcel) || superparcel;
        }
        superparcel = toSingleLargestPolygonLocal(superparcel) || superparcel;

        if (!superparcel || !superparcel.geometry) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Get the exterior ring of the superparcel
        const geom = superparcel.geometry;
        let ring;
        if (geom.type === 'Polygon') {
            ring = geom.coordinates[0];
        } else if (geom.type === 'MultiPolygon') {
            let maxArea = 0;
            for (const poly of geom.coordinates) {
                const area = Math.abs(turf.area(turf.polygon([poly[0]])));
                if (area > maxArea) {
                    maxArea = area;
                    ring = poly[0];
                }
            }
        }

        if (!ring || ring.length < 4) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Convert to meters using centroid as origin
        const centroid = turf.centroid(superparcel);
        const [cLng, cLat] = centroid.geometry.coordinates;
        // The affine local frame with the ellipsoid's true scales at the centroid (local-frame.js)
        const localFrame = window.LocalFrame.makeLocalFrame(cLng, cLat);
        const metersPerDegLng = localFrame.metersPerDegLng;
        const metersPerDegLat = localFrame.metersPerDegLat;

        const toMeters = ([lng, lat]) => [
            (lng - cLng) * metersPerDegLng,
            (lat - cLat) * metersPerDegLat
        ];

        const meterRing = ring.slice(0, -1).map(toMeters);
        const n = meterRing.length;

        // Set up cached values for consistent boundary checking
        cachedSuperparcel = superparcel;
        cachedCentroid = [cLng, cLat];
        cachedMetersPerDegLng = metersPerDegLng;
        cachedMetersPerDegLat = metersPerDegLat;
        cachedSuperparcelMeters = meterRing;

        // Find the longest side to determine orientation
        let longestSideLength = 0;
        let longestSideStart = null;
        let longestSideEnd = null;

        for (let i = 0; i < n; i++) {
            const p1 = meterRing[i];
            const p2 = meterRing[(i + 1) % n];
            const dx = p2[0] - p1[0];
            const dy = p2[1] - p1[1];
            const sideLen = Math.sqrt(dx * dx + dy * dy);

            if (sideLen > longestSideLength) {
                longestSideLength = sideLen;
                longestSideStart = p1;
                longestSideEnd = p2;
            }
        }

        if (!longestSideStart || !longestSideEnd) {
            return { maxLength: DEFAULT_BUILDING_LENGTH, maxWidth: DEFAULT_BUILDING_WIDTH };
        }

        // Direction vectors
        const dx = longestSideEnd[0] - longestSideStart[0];
        const dy = longestSideEnd[1] - longestSideStart[1];

        // Set baseRotation to the angle of the longest side (used by checkBuildingFitsInSuperparcel)
        baseRotation = Math.atan2(dy, dx);

        const ux = dx / longestSideLength;
        const uy = dy / longestSideLength;
        const perpX = -uy;
        const perpY = ux;

        // Binary search to find maximum dimensions with 2:1 aspect ratio
        // that keep all edges at least 1m from the superparcel border
        const MIN_MARGIN = 1.0; // 1 meter margin
        let minScale = 0;
        let maxScale = 500; // Start with a large scale

        // Helper to check if a rectangle at given scale fits (inside polygon and margin from boundary)
        const rectFitsWithMargin = (scale) => {
            const halfLength = scale;
            const halfWidth = scale / 2; // 2:1 aspect ratio

            // Rectangle corners centered at origin
            const corners = [
                [-halfLength * ux - halfWidth * perpX, -halfLength * uy - halfWidth * perpY],
                [halfLength * ux - halfWidth * perpX, halfLength * uy - halfWidth * perpY],
                [halfLength * ux + halfWidth * perpX, halfLength * uy + halfWidth * perpY],
                [-halfLength * ux + halfWidth * perpX, -halfLength * uy + halfWidth * perpY]
            ];

            // Check center and each corner and edge midpoint
            const testPoints = [
                [0, 0], // center
                ...corners,
                // Edge midpoints
                [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
                [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
                [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
                [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2]
            ];

            for (const pt of testPoints) {
                // First check if point is inside the superparcel
                if (!pointInPolygon(pt, meterRing)) {
                    return false;
                }
                // Then check minimum distance to boundary
                let minDist = Infinity;
                for (let i = 0; i < n; i++) {
                    const e1 = meterRing[i];
                    const e2 = meterRing[(i + 1) % n];
                    const dist = pointToSegmentDistance(pt, e1, e2);
                    if (dist < minDist) {
                        minDist = dist;
                    }
                }
                if (minDist < MIN_MARGIN) {
                    return false;
                }
            }
            return true;
        };

        // Binary search for maximum scale
        for (let iter = 0; iter < 50; iter++) {
            const midScale = (minScale + maxScale) / 2;
            if (rectFitsWithMargin(midScale)) {
                minScale = midScale;
            } else {
                maxScale = midScale;
            }
        }

        // minScale now holds the maximum half-length that fits
        const maxLength = Math.max(4, minScale * 2); // Full length (minimum 4m)
        const maxWidth = Math.max(2, minScale); // Full width (minimum 2m, which is half of length due to 2:1 ratio)

        // Calculate polygon diameter (longest line that fits inside)
        // This is the maximum distance between any two vertices
        let polygonDiameter = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const dx = meterRing[j][0] - meterRing[i][0];
                const dy = meterRing[j][1] - meterRing[i][1];
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > polygonDiameter) {
                    polygonDiameter = dist;
                }
            }
        }
        // Apply 1m margin to the diameter
        const maxSliderValue = Math.max(4, Math.round(polygonDiameter - 2)); // -2m for 1m margin on each side

        return { maxLength, maxWidth, maxSliderValue };
    }

    // Helper: distance from point to line segment
    function pointToSegmentDistance(pt, e1, e2) {
        const dx = e2[0] - e1[0];
        const dy = e2[1] - e1[1];
        const lenSq = dx * dx + dy * dy;

        if (lenSq < 0.0001) {
            // Segment is essentially a point
            return Math.sqrt((pt[0] - e1[0]) ** 2 + (pt[1] - e1[1]) ** 2);
        }

        // Project point onto line, clamped to segment
        let t = ((pt[0] - e1[0]) * dx + (pt[1] - e1[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = e1[0] + t * dx;
        const projY = e1[1] + t * dy;

        return Math.sqrt((pt[0] - projX) ** 2 + (pt[1] - projY) ** 2);
    }

    // Helper: check if a point is inside a polygon using ray casting algorithm
    function pointInPolygon(pt, polygon) {
        const x = pt[0], y = pt[1];
        let inside = false;
        const n = polygon.length;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];

            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Helper: minimum distance from point to polygon boundary
    function distanceToPolygonBoundary(pt, polygon) {
        let minDist = Infinity;
        const n = polygon.length;
        for (let i = 0; i < n; i++) {
            const e1 = polygon[i];
            const e2 = polygon[(i + 1) % n];
            const dist = pointToSegmentDistance(pt, e1, e2);
            if (dist < minDist) {
                minDist = dist;
            }
        }
        return minDist;
    }

    // Check if a building polygon fits within the superparcel with minimum margin
    function checkBuildingFitsInSuperparcel(length, width, chamfer, offsetX, offsetY, rotation, minMargin = 0.5) {
        if (!cachedSuperparcelMeters || !cachedCentroid || cachedSuperparcelMeters.length < 3) return true;

        const totalRotation = baseRotation + rotation;
        const ux = Math.cos(totalRotation);
        const uy = Math.sin(totalRotation);
        const perpX = -uy;
        const perpY = ux;

        const halfLength = length / 2;
        const halfWidth = width / 2;

        // Get building corners in meters
        const corners = [
            [offsetX - halfLength * ux - halfWidth * perpX, offsetY - halfLength * uy - halfWidth * perpY],
            [offsetX + halfLength * ux - halfWidth * perpX, offsetY + halfLength * uy - halfWidth * perpY],
            [offsetX + halfLength * ux + halfWidth * perpX, offsetY + halfLength * uy + halfWidth * perpY],
            [offsetX - halfLength * ux + halfWidth * perpX, offsetY - halfLength * uy + halfWidth * perpY]
        ];

        // Also check edge midpoints and center
        const testPoints = [
            [offsetX, offsetY], // center point
            ...corners,
            [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
            [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
            [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
            [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2]
        ];

        // Check each test point: must be inside polygon AND at least minMargin from boundary
        for (const pt of testPoints) {
            // First check if point is inside the superparcel
            if (!pointInPolygon(pt, cachedSuperparcelMeters)) {
                return false;
            }
            // Then check minimum distance to boundary
            const distToBoundary = distanceToPolygonBoundary(pt, cachedSuperparcelMeters);
            if (distToBoundary < minMargin) {
                return false;
            }
        }
        return true;
    }

    // Convert lat/lng to meters relative to cached centroid
    function latLngToMeters(latlng) {
        if (!cachedCentroid || !cachedMetersPerDegLng || !cachedMetersPerDegLat) return [0, 0];
        return [
            (latlng.lng - cachedCentroid[0]) * cachedMetersPerDegLng,
            (latlng.lat - cachedCentroid[1]) * cachedMetersPerDegLat
        ];
    }

    // Start drag interaction
    function rowHousePointerEvent(event) {
        const nativeEvent = event?.originalEvent || event;
        const touch = nativeEvent?.changedTouches?.[0] || nativeEvent?.touches?.[0];
        if (!touch) return event;
        nativeEvent.preventDefault?.();
        return { clientX: touch.clientX, clientY: touch.clientY, target: nativeEvent.target, originalEvent: nativeEvent, preventDefault: () => nativeEvent.preventDefault?.() };
    }

    function startDrag(e) {
        const originalTarget = e?.originalEvent?.target;
        if (originalTarget && typeof originalTarget.closest === 'function'
            && originalTarget.closest('.polygon-geometry-editor__vertex, .polygon-geometry-editor__delete-marker')) return;
        if (e?.originalEvent && typeof e.originalEvent.preventDefault === 'function') e.originalEvent.preventDefault();
        isDragging = true;
        dragMapWasEnabled = rowHouseMap?.dragging?.enabled?.() !== false;
        dragStartLatLng = e.latlng;
        dragStartOffset = [currentOffsetX, currentOffsetY];
        dragStartFeature = cloneRowHouseFeature(generatedRowHouseFeature);
        dragLastValidFeature = cloneRowHouseFeature(generatedRowHouseFeature);
        rowHouseHistory?.record?.();
        rowHousePendingVertexActionIndex = null;
        destroyRowHousePolygonEditor();

        rowHouseMap.dragging.disable();
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd);
        document.addEventListener('touchcancel', onDragEnd);
    }

    // Handle drag movement
    function onDragMove(e) {
        if (!isDragging || !rowHouseMap || !dragStartLatLng) return;

        const pointer = rowHousePointerEvent(e);
        const containerPoint = rowHouseMap.mouseEventToContainerPoint(pointer);
        const latlng = rowHouseMap.containerPointToLatLng(containerPoint);

        if (!dragStartFeature?.geometry || !window.SingleBuildingGeometry?.moveGeometry) return;
        // The footprint keeps its ground metres from the drag's start point, placed at the cursor.
        const geometry = rowHouseModal?.placement?.moveGeometry?.(dragStartFeature.geometry, dragStartLatLng, latlng, pointer)
            || window.SingleBuildingGeometry.moveGeometry(dragStartFeature.geometry, dragStartLatLng, latlng);
        const candidate = cloneRowHouseFeature(dragStartFeature);
        if (!candidate || !geometry) return;
        candidate.geometry = geometry;
        if (!rowHouseFeatureValid(candidate)) return;
        rowHouseModal?.placement?.update?.(candidate);

        // Snapping may place the accepted geometry away from the raw pointer. Persist the
        // accepted displacement so later slider regeneration stays at the visible position.
        const startCenter = turf.centroid(dragStartFeature).geometry.coordinates;
        const movedCenter = turf.centroid(candidate).geometry.coordinates;
        const startMeters = latLngToMeters({ lng: startCenter[0], lat: startCenter[1] });
        const currentMeters = latLngToMeters({ lng: movedCenter[0], lat: movedCenter[1] });
        currentOffsetX = dragStartOffset[0] + currentMeters[0] - startMeters[0];
        currentOffsetY = dragStartOffset[1] + currentMeters[1] - startMeters[1];
        candidate.properties = { ...(candidate.properties || {}), offsetX: currentOffsetX, offsetY: currentOffsetY };
        dragLastValidFeature = candidate;
        generatedRowHouseFeature = candidate;
        try {
            const latLngs = candidate.geometry.coordinates.map(ring => ring.map(([lng, lat]) => [lat, lng]));
            rowHouseBuildingLayer?.eachLayer?.(layer => layer.setLatLngs?.(latLngs));
        } catch (_) { }
        updateBuildingMetrics(candidate);
    }

    // End drag interaction
    function onDragEnd() {
        const finalFeature = dragLastValidFeature || dragStartFeature;
        const changed = !!(finalFeature?.geometry && dragStartFeature?.geometry
            && JSON.stringify(finalFeature.geometry) !== JSON.stringify(dragStartFeature.geometry));
        isDragging = false;
        dragStartLatLng = null;
        dragStartOffset = null;
        dragStartFeature = null;
        dragLastValidFeature = null;
        if (rowHouseMap && dragMapWasEnabled) rowHouseMap.dragging.enable();
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);
        document.removeEventListener('touchcancel', onDragEnd);
        if (finalFeature) {
            generatedRowHouseFeature = finalFeature;
            displayRowHouseBuildingInModal(finalFeature);
            if (changed) autosaveRowHouseDraft();
            else rowHouseHistory?.discardLast?.();
        }
    }

    function commitRowHousePolygonRing(ring) {
        const candidate = rowHouseFeatureWithRing(generatedRowHouseFeature, ring);
        if (!candidate || !rowHouseFeatureValid(candidate)) {
            displayRowHouseBuildingInModal(generatedRowHouseFeature);
            return false;
        }
        candidate.properties = {
            ...(candidate.properties || {}),
            type: 'proposedRowHouse',
            height: Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT),
            footprintMode: 'polygon'
        };
        if (!rowHouseModal?.placement?.accepts?.(candidate)) return false;
        generatedRowHouseFeature = candidate;
        rowHouseModal?.placement?.update?.(candidate);
        displayRowHouseBuildingInModal(candidate);
        autosaveRowHouseDraft();
        return true;
    }

    function renderRowHousePolygonEditor() {
        const initialSelectedVertexIndex = rowHousePendingVertexActionIndex;
        rowHousePendingVertexActionIndex = null;
        destroyRowHousePolygonEditor();
        const ring = rowHouseOuterRing(generatedRowHouseFeature);
        if (!rowHouseMap || !ring || !window.PolygonGeometryEditor?.create) return;
        rowHousePolygonEditor = window.PolygonGeometryEditor.create({
            map: rowHouseMap,
            pane: rowHouseModal?.handlePane,
            leaflet: L,
            turf,
            ring,
            boundary: () => rowHousePlacementLocked() ? (rowHouseBlock?.site || cachedSuperparcel) : null,
            snapCoordinate: (coordinate, event) => rowHouseModal?.placement?.snapCoordinate?.(coordinate, event) || coordinate,
            undo: false,
            initialSelectedVertexIndex,
            showInitialDeleteAction: Number.isInteger(initialSelectedVertexIndex),
            vertexTitle: translateRowHouseText('rowHouses.modal.vertexLabel', 'Drag to reshape'),
            deleteTitle: translateRowHouseText('rowHouses.modal.deleteVertexLabel', 'Delete selected vertex'),
            onDragStart: () => rowHouseHistory?.record?.(),
            onCommit: ({ ring: committedRing, reason, vertexIndex }) => {
                if (reason !== 'move') rowHouseHistory?.record?.();
                rowHouseManualMode = true;
                syncRowHouseGeometryControls();
                rowHousePendingVertexActionIndex = reason === 'move' ? vertexIndex : null;
                const committed = commitRowHousePolygonRing(committedRing);
                rowHousePendingVertexActionIndex = null;
                return committed;
            }
        });
    }

    function rotateRowHouseFootprint(deltaDegrees) {
        if (!generatedRowHouseFeature?.geometry || !Number.isFinite(deltaDegrees)) return;
        let candidate = null;
        try {
            const geometry = window.SingleBuildingGeometry?.rotateGeometry?.(
                generatedRowHouseFeature.geometry,
                deltaDegrees
            );
            if (geometry) {
                candidate = cloneRowHouseFeature(generatedRowHouseFeature);
                candidate.geometry = geometry;
            }
        } catch (_) { }
        if (!candidate || !rowHouseFeatureValid(candidate)) return;
        rowHouseHistory?.record?.();
        currentRotation += deltaDegrees * Math.PI / 180;
        candidate.properties = {
            ...(generatedRowHouseFeature.properties || {}),
            rotation: currentRotation,
            footprintMode: 'polygon'
        };
        generatedRowHouseFeature = candidate;
        rowHouseModal?.placement?.update?.(candidate);
        displayRowHouseBuildingInModal(candidate);
        autosaveRowHouseDraft();
    }

    function loadRowHouseGeoJSON(file) {
        if (!file || !window.PolygonGeometryEditor) return;
        const reader = new FileReader();
        reader.onload = () => {
            let ring = null;
            try {
                ring = window.PolygonGeometryEditor.extractOuterRingFromGeoJSON(JSON.parse(reader.result), turf);
            } catch (error) {
                console.error('Row-house GeoJSON parse failed', error);
            }
            if (!ring) {
                showRowHouseEditorAlert('uploadNoPolygon', 'No usable polygon found in that file.');
                return;
            }
            rowHouseHistory?.record?.();
            const constrained = rowHousePlacementLocked()
                ? (window.PolygonGeometryEditor.constrainRingToBoundary(ring, rowHouseBlock?.site || cachedSuperparcel, turf) || ring)
                : ring;
            const candidate = rowHouseFeatureWithRing(generatedRowHouseFeature, constrained);
            if (!candidate || !rowHouseFeatureValid(candidate)) {
                showRowHouseEditorAlert('uploadOutside', 'The uploaded polygon does not overlap these parcels in a usable way.');
                return;
            }
            candidate.properties = {
                ...(generatedRowHouseFeature?.properties || {}),
                type: 'proposedRowHouse',
                height: Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT),
                footprintMode: 'polygon',
                rotation: 0
            };
            currentOffsetX = 0;
            currentOffsetY = 0;
            currentRotation = 0;
            rowHouseManualMode = true;
            syncRowHouseGeometryControls();
            generatedRowHouseFeature = candidate;
            rowHouseModal?.placement?.update?.(candidate);
            displayRowHouseBuildingInModal(candidate);
            autosaveRowHouseDraft();
        };
        reader.onerror = () => showRowHouseEditorAlert('uploadError', 'Could not read that file.');
        reader.readAsText(file);
    }

    // Display building on the modal map
    function currentRowRule() {
        return window.UrbanRuleVariation.normalizeBlockRule({
            typology: 'row',
            kind: rowRuleKind,
            maxHeightM: Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT,
            minHeightM: rowMinHeightM,
            minPlotAreaM2: rowMinPlotAreaM2
        });
    }

    function rowParcelsForSplit() {
        const block = getActiveRowHouseBlock();
        if (!block || !Array.isArray(block.parcels)) return [];
        return block.parcels.map((parcel, index) => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id ?? `parcel-${index}`);
            return { feature: parcel?.feature, parcelId };
        }).filter(entry => entry.feature && entry.feature.geometry);
    }

    // Cut the bar into one house per parcel and derive the example built under it. The bar itself
    // stays the draggable, vertex-editable outline — only what is drawn inside it changes.
    function rebuildRowUnits(barFeature) {
        const parcels = rowParcelsForSplit();
        if (!barFeature || !parcels.length) {
            rowUnits = []; rowBuildOut = []; rowExcluded = [];
            return;
        }
        const deps = { turf };
        const parcelUnion = robustUnionLocal(parcels.map(parcel => parcel.feature));
        let fitsParcelUnion = true;
        try {
            fitsParcelUnion = !!parcelUnion?.geometry
                && window.SingleBuildingGeometry?.footprintWithinBoundary?.(barFeature, parcelUnion, turf) === true;
        } catch (_) { fitsParcelUnion = false; }
        if (!rowHousePlacementLocked() && (rowHouseBlock?.syntheticSite || !fitsParcelUnion)) {
            const rule = currentRowRule();
            const massing = cloneRowHouseFeature(barFeature);
            massing.properties = {
                ...(massing.properties || {}),
                massing: true,
                urbanRule: rule,
                variationSeed: rowVariationSeed
            };
            const compelled = rule.kind === 'range' && rule.minDepthM > 0
                ? window.UrbanRuleVariation.buildToMinimum(massing, rule.minDepthM, deps)
                : null;
            if (compelled?.geometry) massing.properties.minFootprint = compelled.geometry;
            rowUnits = [massing];
            rowExcluded = [];
            rowBuildOut = [window.UrbanRuleVariation.realizeFeature(massing, deps)];
            return;
        }
        const split = window.UrbanRuleVariation.splitMassingByParcels(
            barFeature, parcels, currentRowRule(), rowVariationSeed, deps);
        rowUnits = split.pieces;
        rowExcluded = split.excluded;
        rowBuildOut = rowUnits.map(unit => window.UrbanRuleVariation.realizeFeature(unit, deps));
    }

    // A minimum belongs to one rule type, and under "exactly this height" there is no variation to
    // roll — so the button is hidden rather than left doing provably nothing.
    function syncRowRuleControls() {
        const group = document.getElementById('rowhouse-minheight-group');
        if (group) group.style.display = rowRuleKind === 'range' ? '' : 'none';
        const regenerate = document.getElementById('btn-rowhouse-regenerate');
        if (regenerate) regenerate.hidden = rowRuleKind === 'exact';
        const slider = document.getElementById('rowhouse-minheight-slider');
        if (!slider) return;
        const ceiling = Number(currentBuildingHeight) || DEFAULT_BUILDING_HEIGHT;
        slider.max = String(ceiling);
        if (rowMinHeightM > ceiling) rowMinHeightM = ceiling;
        slider.value = String(rowMinHeightM);
        const label = document.getElementById('rowhouse-minheight-value');
        if (label) label.textContent = CbFormat.formatNumber(rowMinHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
    }

    function rowExclusionReason(status) {
        if (status === 'below-min-plot') {
            return translateRowHouseText('rowHouses.modal.messages.excludedBelowMinPlot',
                'Smaller than the minimum plot size — it has to be merged with a neighbour before anything can be built here.');
        }
        return translateRowHouseText('rowHouses.modal.messages.excludedSliver',
            'Only a splinter of the row falls on this plot — too small to be a house.');
    }

    function displayRowHouseBuildingInModal(feature) {
        if (!rowHouseMap) return;

        destroyRowHousePolygonEditor();
        if (rowHouseBuildingLayer) {
            rowHouseMap.removeLayer(rowHouseBuildingLayer);
            rowHouseBuildingLayer = null;
        }
        [rowUnitLayers, rowExcludedLayers].forEach(layers => {
            layers.forEach(layer => { if (layer) { try { rowHouseMap.removeLayer(layer); } catch (_) { } } });
        });
        rowUnitLayers = [];
        rowExcludedLayers = [];

        if (!feature || !feature.geometry) return;

        rebuildRowUnits(feature);

        // Houses go down first so the bar stays on top and keeps its drag and vertex handles; the
        // bar's fill is nearly clear so the shades read through it.
        rowExcluded.forEach(entry => {
            if (!entry || !entry.feature || entry.status === 'no-massing-here') return;
            const layer = L.geoJSON(entry.feature, {
                pane: rowHouseModal?.pane,
            style: { fillColor: '#b0453a', fillOpacity: 0.16, color: '#b0453a', weight: 1.5, dashArray: '2, 5' }
            }).addTo(rowHouseMap);
            layer.bindTooltip(rowExclusionReason(entry.status), { direction: 'center' });
            rowExcludedLayers.push(layer);
        });
        rowUnits.forEach(unit => {
            const color = unit.properties?.color || '#8899aa';
            const layer = L.geoJSON(unit, {
                pane: rowHouseModal?.pane,
            style: { fillColor: color, fillOpacity: 0.75, color: '#33465c', weight: 1 }
            }).addTo(rowHouseMap);
            rowUnitLayers.push(layer);
        });

        rowHouseBuildingLayer = L.geoJSON(feature, {
            pane: rowHouseModal?.pane,
            style: {
                fillColor: '#0d6efd',
                fillOpacity: rowUnits.length ? 0.05 : 0.5,
                color: '#0d6efd',
                weight: 2,
                cursor: 'move'
            },
            onEachFeature: function (feat, layer) {
                // Enable dragging on the polygon
                const beginRowDrag = (e) => {
                    L.DomEvent.stopPropagation(e);
                    startDrag(e);
                };
                layer.on('mousedown', beginRowDrag);
                layer.on('touchstart', beginRowDrag);
            }
        }).addTo(rowHouseMap);

        // Vertex/edge interaction is shared with block-manual and freeform-building editors.
        renderRowHousePolygonEditor();

        // Update metrics display
        updateBuildingMetrics(feature);

        const previewFeatures = rowBuildOut.length ? rowBuildOut : [feature];
        rowHouseModal?.setPreview({
            draftPreview: { kind: 'buildings', features: rowBuildOut },
            boundary: rowHouseBlock?.site || cachedSuperparcel,
            envelopes: rowRuleKind === 'exact' ? [] : rowUnits,
            excluded: rowExcluded.filter(entry => entry?.feature?.geometry).map(entry => entry.feature)
        });
        const anchorFeature = previewFeatures[0] || feature;
        try {
            const center = turf.centroid(anchorFeature).geometry.coordinates;
            rowHouseModal?.setAnchor({ lat: center[1], lng: center[0], height: Number(anchorFeature.properties?.height || currentBuildingHeight) });
        } catch (_) { }
    }

    // Calculate and display building metrics
    function updateBuildingMetrics(feature) {
        const circumferenceEl = document.getElementById('rowhouse-circumference-value');
        const areaEl = document.getElementById('rowhouse-area-value');
        const volumeEl = document.getElementById('rowhouse-volume-value');

        if (!circumferenceEl || !areaEl || !volumeEl) return;

        if (!feature || !feature.geometry || !feature.geometry.coordinates) {
            circumferenceEl.textContent = '0';
            areaEl.textContent = '0';
            volumeEl.textContent = '0';
            return;
        }

        try {
            // Calculate circumference (perimeter) using turf
            const circumference = turf.length(feature, { units: 'meters' });
            circumferenceEl.textContent = CbFormat.formatNumber(circumference, { maxFractionDigits: 1, minFractionDigits: 1 });

            // Calculate area using turf
            const area = turf.area(feature);
            areaEl.textContent = CbFormat.formatNumber(area, { maxFractionDigits: 1, minFractionDigits: 1 });

            // Calculate volume (area * height)
            const height = feature.properties.height || currentBuildingHeight || DEFAULT_BUILDING_HEIGHT;
            const volume = area * height;
            volumeEl.textContent = CbFormat.formatNumber(volume, { maxFractionDigits: 1, minFractionDigits: 1 });
        } catch (e) {
            console.warn('[RowHouse] Error calculating metrics:', e);
            circumferenceEl.textContent = '0';
            areaEl.textContent = '0';
            volumeEl.textContent = '0';
        }
    }

    // Snapshot live geometry without closing the modal. This is intentionally separate from the
    // legacy Done handler, which also mutates the global parcel selection and proposal form.
    function autosaveRowHouseDraft() {
        const activeDraft = window.getActiveProposalDesignDraft?.();
        const block = getActiveRowHouseBlock();
        if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
            || !generatedRowHouseFeature || !block?.parcels?.length
            || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
        const parentDetails = [];
        const parcelIds = [];
        if (!block.syntheticSite) block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const id = String(parcelId);
            parcelIds.push(id);
            parentDetails.push({ id, number: String(props?.BROJ_CESTICE || id) });
        });
        const feature = window.UrbanRuleVariation.massingWithRule(generatedRowHouseFeature, currentRowRule(), rowVariationSeed, { turf });
        window.syncActiveProposalDraftFromEditor('building', {
            parcelIds,
            parentDetails,
            blockName: getRowHouseDisplayName(),
            parameters: {
                length: Number(currentBuildingLength),
                width: Number(currentBuildingWidth),
                height: Number(currentBuildingHeight),
                chamfer: Number(currentChamfer),
                offsetX: Number(currentOffsetX) || 0,
                offsetY: Number(currentOffsetY) || 0,
                rotation: Number(currentRotation) || 0,
                typology: 'row',
                rule: currentRowRule(),
                seed: rowVariationSeed,
                manualMode: rowHouseManualMode,
                placementBaseSite: cloneRowHouseFeature(block.generatorSite || block.site || cachedSuperparcel)
            },
            buildingFeature: feature,
            buildings: [feature],
            placement: { site: cloneRowHouseFeature(feature), free: true }
        }, { coalesceKey: 'row-house-live' });
    }

    // Generate row house in modal
    function generateRowHouseInModal() {
        const block = getActiveRowHouseBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return;
        }

        setRowHouseInfo('rowHouses.modal.generating', 'Generating row houses...');

        try {
            // Check if current parameters fit, if not try to adjust offset
            if (rowHousePlacementLocked() && !checkBuildingFitsInSuperparcel(currentBuildingLength, currentBuildingWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
                // Try resetting offset to center
                if (checkBuildingFitsInSuperparcel(currentBuildingLength, currentBuildingWidth, currentChamfer, 0, 0, currentRotation)) {
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                } else if (checkBuildingFitsInSuperparcel(currentBuildingLength, currentBuildingWidth, currentChamfer, 0, 0, 0)) {
                    // Also reset rotation
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                    currentRotation = 0;
                }
                // If still doesn't fit, the polygon generation will happen anyway
                // but user will see it may be outside bounds
            }

            const buildingFeature = generateRowHousePolygon(
                block,
                currentBuildingLength,
                currentBuildingWidth,
                currentChamfer,
                currentOffsetX,
                currentOffsetY,
                currentRotation
            );

            if (!buildingFeature) {
                throw new Error('Failed to generate row house polygon');
            }

            generatedRowHouseFeature = buildingFeature;
            rowHouseModal?.placement?.update?.(buildingFeature);
            displayRowHouseBuildingInModal(buildingFeature);
            autosaveRowHouseDraft();

            const doneButton = document.getElementById('btn-rowhouse-done');
            if (doneButton) doneButton.disabled = false;

            // Clear info text on successful generation
            setRowHouseInfo('', '');

        } catch (error) {
            console.error('[RowHouse] Generation error:', error);
            setRowHouseInfo(
                'rowHouses.modal.messages.creationFailed',
                'Row houses creation failed. Try adjusting parameters.',
                {}
            );
            const doneButton = document.getElementById('btn-rowhouse-done');
            if (doneButton) doneButton.disabled = true;
        }
    }

    // --- Modal management ---

    function showRowHouseModal() {
        const block = getActiveRowHouseBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus(translateRowHouseText('status.messages.no_block_selected', 'No block selected'));
            }
            return false;
        }

        rowHouseBlock = block;
        if (!block.site?.geometry) {
            block.site = robustUnionLocal(block.parcels.map(parcel => parcel.feature).filter(Boolean));
        }
        if (!block.generatorSite?.geometry) {
            block.generatorSite = cloneRowHouseFeature(block.site);
        }
        const blockLabel = getRowHouseDisplayName();

        console.log('[RowHouses] showRowHouseModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

        // Create modal if it doesn't exist
        if (!rowHouseModal) {
            // The shared map editor owns the floating panel, map and view controls; this module
            // contributes the row-house parameters, rotation tools and commit actions.
            const container = document.createElement('div');
            container.id = 'rowhouse-container';
            container.className = 'cb-dialog cb-dialog--xl';
            container.innerHTML = `
                <div id="rowhouse-sidebar">
                    <h3 class="cb-kicker" data-i18n-key="rowHouses.modal.parametersTitle">Parameters</h3>
                    <div class="parameter-group">
                        <label for="rowhouse-ruletype-select" data-i18n-key="rowHouses.modal.labels.ruleType" data-i18n-attr="text">What the rule compels:</label>
                        <select id="rowhouse-ruletype-select">
                            <option value="exact" data-i18n-key="rowHouses.modal.labels.ruleTypeExact" data-i18n-attr="text">Exactly this height</option>
                            <option value="max" data-i18n-key="rowHouses.modal.labels.ruleTypeMax" data-i18n-attr="text">At most this height</option>
                            <option value="range" data-i18n-key="rowHouses.modal.labels.ruleTypeRange" data-i18n-attr="text">Between a minimum and this</option>
                        </select>
                    </div>
                    <div class="parameter-group" id="rowhouse-minheight-group" style="display: none;">
                        <label for="rowhouse-minheight-slider">
                            <span data-i18n-key="rowHouses.modal.labels.minHeight" data-i18n-attr="text">Min Height (m):</span>
                            <span id="rowhouse-minheight-value">0.0</span>
                        </label>
                        <input type="range" id="rowhouse-minheight-slider" min="0" max="80" value="0" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-minplot-slider">
                            <span data-i18n-key="rowHouses.modal.labels.minPlotArea" data-i18n-attr="text">Min Plot Size (m²):</span>
                            <span id="rowhouse-minplot-value">${DEFAULT_ROW_MIN_PLOT_AREA_M2}</span>
                        </label>
                        <input type="range" id="rowhouse-minplot-slider" min="0" max="10000" value="${DEFAULT_ROW_MIN_PLOT_AREA_M2}" step="10">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-length-slider">
                            <span data-i18n-key="rowHouses.modal.labels.length" data-i18n-attr="text">Length (m):</span>
                            <span id="rowhouse-length-value">${CbFormat.formatNumber(DEFAULT_BUILDING_LENGTH, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                        </label>
                        <input type="range" id="rowhouse-length-slider" min="4" max="200" value="${DEFAULT_BUILDING_LENGTH}" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <button type="button" id="rowhouse-manual-toggle" class="btn btn-block" aria-pressed="false" data-i18n-key="rowHouses.modal.editShape" data-i18n-attr="text">Edit shape manually</button>
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-width-slider">
                            <span data-i18n-key="rowHouses.modal.labels.width" data-i18n-attr="text">Width (m):</span>
                            <span id="rowhouse-width-value">${CbFormat.formatNumber(DEFAULT_BUILDING_WIDTH, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                        </label>
                        <input type="range" id="rowhouse-width-slider" min="2" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-height-slider">
                            <span data-i18n-key="rowHouses.modal.labels.height" data-i18n-attr="text">Height (m):</span>
                            <span id="rowhouse-height-value">${CbFormat.formatNumber(DEFAULT_BUILDING_HEIGHT, { maxFractionDigits: 0, minFractionDigits: 0 })}</span>
                        </label>
                        <input type="range" id="rowhouse-height-slider" min="3" max="80" value="${DEFAULT_BUILDING_HEIGHT}" step="1">
                    </div>
                    <div class="parameter-group">
                        <label data-i18n-key="rowHouses.modal.labels.rotation" data-i18n-attr="text">Rotate footprint</label>
                        <div class="single-building-rotation-buttons">
                            <button id="rowhouse-rotate-counterclockwise" class="btn" type="button" data-i18n-key="rowHouses.modal.rotateCounterclockwise" data-i18n-attr="aria-label" aria-label="Rotate counterclockwise 5 degrees"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> 5°</button>
                            <button id="rowhouse-rotate-clockwise" class="btn" type="button" data-i18n-key="rowHouses.modal.rotateClockwise" data-i18n-attr="aria-label" aria-label="Rotate clockwise 5 degrees"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> 5°</button>
                        </div>
                    </div>
                    <details class="on-map-editor__more-options">
                        <summary data-i18n-key="onMapEditor.moreOptions">${translateRowHouseText('onMapEditor.moreOptions', 'More options')}</summary>
                        <div class="parameter-group">
                            <label for="rowhouse-chamfer-slider">
                                <span data-i18n-key="rowHouses.modal.labels.chamfer" data-i18n-attr="text">Chamfer (m):</span>
                                <span id="rowhouse-chamfer-value">${CbFormat.formatNumber(DEFAULT_CHAMFER, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                            </label>
                            <input type="range" id="rowhouse-chamfer-slider" min="0" max="10" value="${DEFAULT_CHAMFER}" step="0.5">
                        </div>
                        <div class="parameter-group">
                            <button id="rowhouse-geojson-upload" class="btn btn-block" type="button" data-i18n-key="rowHouses.modal.uploadGeojson" data-i18n-attr="text">Upload GeoJSON</button>
                            <input id="rowhouse-geojson-input" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden>
                        </div>
                        <div class="parameter-metrics">
                            <div class="metric-row">
                                <span data-i18n-key="rowHouses.modal.labels.circumference" data-i18n-attr="text">Circumference (m):</span>
                                <span id="rowhouse-circumference-value">0</span>
                            </div>
                            <div class="metric-row">
                                <span data-i18n-key="rowHouses.modal.labels.area" data-i18n-attr="text">Area (m²):</span>
                                <span id="rowhouse-area-value">0</span>
                            </div>
                            <div class="metric-row">
                                <span data-i18n-key="rowHouses.modal.labels.volume" data-i18n-attr="text">Volume (m³):</span>
                                <span id="rowhouse-volume-value">0</span>
                            </div>
                        </div>
                        <div class="parameter-info">
                            <p data-i18n-key="rowHouses.modal.helper.adjust">Drag the footprint to move it. Drag vertices to reshape it, click an edge to add a vertex, or select a vertex to remove it.</p>
                            <p data-i18n-key="rowHouses.modal.helper.dimensions">Length is parallel to the longest parcel side. Width is perpendicular.</p>
                            <p data-i18n-key="rowHouses.modal.helper.chamfer">Chamfer cuts the corners at 45° angles.</p>
                        </div>
                    </details>
                </div>
                <div id="rowhouse-controls" class="cb-dialog__footer">
                    <div id="rowhouse-info" data-i18n-attr="text" role="status" aria-live="polite"></div>
                    <div id="rowhouse-buttons">
                        <button type="button" class="btn btn-quiet" id="btn-rowhouse-cancel" data-i18n-key="cancel" data-i18n-attr="text">Cancel</button>
                        <button type="button" class="btn" id="btn-rowhouse-regenerate" hidden data-i18n-key="rowHouses.modal.regenerate" data-i18n-attr="text">Regenerate</button>
                        <button type="button" class="btn btn-primary" id="btn-rowhouse-done" data-i18n-key="rowHouses.modal.done" data-i18n-attr="text">Done</button>
                    </div>
                </div>
            `;

            const content = container.querySelector('#rowhouse-sidebar');
            const footer = container.querySelector('#rowhouse-controls');
            const rotationTools = container.querySelector('.single-building-rotation-buttons');
            footer?.classList.remove('cb-dialog__footer');
            rowHouseModal = window.OnMapEditor?.open({
                owner: 'row-house',
                id: 'rowhouse',
                title: translateRowHouseText('rowHouses.modal.title', 'Row houses'),
                content,
                footer,
                modes: ['2d', 'model'],
                wide: false,
                tools: rotationTools,
                placement: {
                    site: block.site || cachedSuperparcel,
                    onLockChange: () => {
                        if (generatedRowHouseFeature) {
                            if (rowHouseFeatureValid(generatedRowHouseFeature)) displayRowHouseBuildingInModal(generatedRowHouseFeature);
                            else setRowHouseInfo('', translateRowHouseText('onMapEditor.lockReject', 'The current footprint is outside the locked site. Move it back inside to use site lock.'));
                        }
                    }
                },
                hints: {
                    '2d': translateRowHouseText('rowHouses.modal.helper.adjust', 'Drag the footprint to move it. Drag vertices to reshape it, click an edge to add a vertex, or select a vertex to remove it.'),
                    model: translateRowHouseText('rowHouses.modal.helper.dimensions', 'Length follows the longest parcel side; width is perpendicular.')
                },
                onCancel: requestCloseRowHouseModal,
                onModeChange: mode => { if (mode === '2d') renderRowHousePolygonEditor(); }
            });
            if (!rowHouseModal) return false;
            if (rowHouseModal.tools) {
                rowHouseModal.tools.setAttribute('role', 'toolbar');
                rowHouseModal.tools.setAttribute('aria-label', translateRowHouseText('rowHouses.modal.labels.rotation', 'Rotate footprint'));
            }
            rowHouseMap = rowHouseModal.map;
            ensureRowHouseHistory();
            setRowHouseInfo('rowHouses.modal.generating', 'Generating row houses...');

            // Apply translations
            try {
                if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                    window.i18n.applyTranslations(rowHouseModal.content);
                    window.i18n.applyTranslations(rowHouseModal.tools);
                }
            } catch (_) { }


            // Add event listeners
            const doneButton = document.getElementById('btn-rowhouse-done');
            if (doneButton) {
                doneButton.addEventListener('click', saveRowHouseDesignForProposal);
                doneButton.disabled = true;
            }

            const cancelButton = document.getElementById('btn-rowhouse-cancel');
            if (cancelButton) cancelButton.addEventListener('click', requestCloseRowHouseModal);
            document.getElementById('rowhouse-manual-toggle')?.addEventListener('click', toggleRowHouseManualMode);

            // Slider event listeners with boundary checking
            document.getElementById('rowhouse-length-slider').addEventListener('input', function (e) {
                if (rowHouseManualMode) return;
                rowHouseHistory?.record?.();
                const proposedLength = parseFloat(e.target.value);
                // Check if proposed length fits (try to adjust position first)
                if (!rowHousePlacementLocked() || checkBuildingFitsInSuperparcel(proposedLength, currentBuildingWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
                    currentBuildingLength = proposedLength;
                } else if (checkBuildingFitsInSuperparcel(proposedLength, currentBuildingWidth, currentChamfer, 0, 0, currentRotation)) {
                    // Reset position to center
                    currentBuildingLength = proposedLength;
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                } else if (checkBuildingFitsInSuperparcel(proposedLength, currentBuildingWidth, currentChamfer, 0, 0, 0)) {
                    // Reset position and rotation
                    currentBuildingLength = proposedLength;
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                    currentRotation = 0;
                } else {
                    // Revert slider to current valid value
                    e.target.value = currentBuildingLength;
                }
                document.getElementById('rowhouse-length-value').textContent = CbFormat.formatNumber(currentBuildingLength, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-chamfer-slider').addEventListener('input', function (e) {
                if (rowHouseManualMode) return;
                rowHouseHistory?.record?.();
                currentChamfer = parseFloat(e.target.value);
                document.getElementById('rowhouse-chamfer-value').textContent = CbFormat.formatNumber(currentChamfer, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-width-slider').addEventListener('input', function (e) {
                if (rowHouseManualMode) return;
                rowHouseHistory?.record?.();
                const proposedWidth = parseFloat(e.target.value);
                // Check if proposed width fits (try to adjust position first)
                if (!rowHousePlacementLocked() || checkBuildingFitsInSuperparcel(currentBuildingLength, proposedWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
                    currentBuildingWidth = proposedWidth;
                } else if (checkBuildingFitsInSuperparcel(currentBuildingLength, proposedWidth, currentChamfer, 0, 0, currentRotation)) {
                    // Reset position to center
                    currentBuildingWidth = proposedWidth;
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                } else if (checkBuildingFitsInSuperparcel(currentBuildingLength, proposedWidth, currentChamfer, 0, 0, 0)) {
                    // Reset position and rotation
                    currentBuildingWidth = proposedWidth;
                    currentOffsetX = 0;
                    currentOffsetY = 0;
                    currentRotation = 0;
                } else {
                    // Revert slider to current valid value
                    e.target.value = currentBuildingWidth;
                }
                document.getElementById('rowhouse-width-value').textContent = CbFormat.formatNumber(currentBuildingWidth, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-height-slider').addEventListener('input', function (e) {
                rowHouseHistory?.record?.();
                currentBuildingHeight = parseFloat(e.target.value);
                document.getElementById('rowhouse-height-value').textContent = CbFormat.formatNumber(currentBuildingHeight, { maxFractionDigits: 0, minFractionDigits: 0 });
                // Height affects the model preview and volume metric
                if (generatedRowHouseFeature) {
                    generatedRowHouseFeature.properties.height = Math.round(currentBuildingHeight);
                    syncRowRuleControls(); // the minimum rides on the ceiling
                    displayRowHouseBuildingInModal(generatedRowHouseFeature);
                    autosaveRowHouseDraft();
                }
            });

            const rowRuleSelect = document.getElementById('rowhouse-ruletype-select');
            if (rowRuleSelect) {
                rowRuleSelect.value = rowRuleKind;
                rowRuleSelect.addEventListener('change', function (e) {
                    rowRuleKind = e.target.value;
                    syncRowRuleControls();
                    if (generatedRowHouseFeature) displayRowHouseBuildingInModal(generatedRowHouseFeature);
                });
            }

            const rowMinHeightSlider = document.getElementById('rowhouse-minheight-slider');
            if (rowMinHeightSlider) {
                rowMinHeightSlider.addEventListener('input', function (e) {
                    rowMinHeightM = parseFloat(e.target.value);
                    document.getElementById('rowhouse-minheight-value').textContent = CbFormat.formatNumber(rowMinHeightM, { maxFractionDigits: 1, minFractionDigits: 1 });
                    if (generatedRowHouseFeature) displayRowHouseBuildingInModal(generatedRowHouseFeature);
                });
            }

            const rowMinPlotSlider = document.getElementById('rowhouse-minplot-slider');
            if (rowMinPlotSlider) {
                rowMinPlotSlider.addEventListener('input', function (e) {
                    rowMinPlotAreaM2 = parseFloat(e.target.value);
                    document.getElementById('rowhouse-minplot-value').textContent = rowMinPlotAreaM2.toString();
                    if (generatedRowHouseFeature) displayRowHouseBuildingInModal(generatedRowHouseFeature);
                });
            }

            const rowRegenerate = document.getElementById('btn-rowhouse-regenerate');
            if (rowRegenerate) {
                // Only the seed moves: the massing, and every number read off it, stay put.
                rowRegenerate.addEventListener('click', function () {
                    rowVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
                    if (generatedRowHouseFeature) displayRowHouseBuildingInModal(generatedRowHouseFeature);
                });
            }

            document.getElementById('rowhouse-rotate-counterclockwise')
                .addEventListener('click', () => rotateRowHouseFootprint(5));
            document.getElementById('rowhouse-rotate-clockwise')
                .addEventListener('click', () => rotateRowHouseFootprint(-5));

            const geojsonButton = document.getElementById('rowhouse-geojson-upload');
            const geojsonInput = document.getElementById('rowhouse-geojson-input');
            if (geojsonButton && geojsonInput) {
                geojsonButton.addEventListener('click', () => geojsonInput.click());
                geojsonInput.addEventListener('change', event => {
                    const file = event.target?.files?.[0];
                    if (file) loadRowHouseGeoJSON(file);
                    event.target.value = '';
                });
            }

            // No outside-click close: a stray click on the backdrop would throw the design away.
            // The editor is left only via the X (discard, after confirming) or Done (save).

        }

        // Display the block on the map
        displayBlockOnRowHouseMap(block);

        // Calculate max dimensions based on superparcel (also sets baseRotation and cached values)
        const { maxLength, maxWidth, maxSliderValue } = calculateMaxBuildingDimensions(block);
        maxBuildingLength = maxLength;

        // Reset parameter values - start at max dimensions (1m from border)
        currentBuildingLength = maxLength;
        currentBuildingWidth = maxLength / 2; // Start with 2:1 aspect ratio
        currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
        rowRuleKind = DEFAULT_ROW_RULE_KIND;
        rowMinHeightM = 0;
        rowMinPlotAreaM2 = DEFAULT_ROW_MIN_PLOT_AREA_M2;
        rowVariationSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
        rowHouseManualMode = false;
        rowUnits = [];
        rowBuildOut = [];
        rowExcluded = [];
        currentChamfer = DEFAULT_CHAMFER;

        // Reset position and rotation (baseRotation is set by calculateMaxBuildingDimensions)
        currentOffsetX = 0;
        currentOffsetY = 0;
        currentRotation = 0;

        // Restore saved slider values and, when present, the exact edited polygon. Parameters keep
        // the controls useful; the feature preserves vertex edits and uploaded footprints.
        const seed = rowHouseSeedParameters;
        const seedFeature = cloneRowHouseFeature(rowHouseSeedFeature);
        rowHouseSeedParameters = null;
        rowHouseSeedFeature = null;
        if (seed) {
            const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
            if (num(seed.length) !== null) currentBuildingLength = num(seed.length);
            if (num(seed.width) !== null) currentBuildingWidth = num(seed.width);
            if (num(seed.height) !== null) currentBuildingHeight = num(seed.height);
            if (num(seed.chamfer) !== null) currentChamfer = num(seed.chamfer);
            if (num(seed.offsetX) !== null) currentOffsetX = num(seed.offsetX);
            if (num(seed.offsetY) !== null) currentOffsetY = num(seed.offsetY);
            if (num(seed.rotation) !== null) currentRotation = num(seed.rotation);
            // What the rule compels, and the variation it was saved with — restoring the seed is
            // what makes a reopened design redraw the SAME terrace.
            const savedRule = (seed.rule && typeof seed.rule === 'object') ? seed.rule : null;
            if (savedRule) {
                if (window.UrbanRuleVariation.RULE_KINDS.includes(savedRule.kind)) rowRuleKind = savedRule.kind;
                if (num(savedRule.minHeightM) !== null) rowMinHeightM = num(savedRule.minHeightM);
                if (num(savedRule.minPlotAreaM2) !== null) rowMinPlotAreaM2 = num(savedRule.minPlotAreaM2);
            }
            if (num(seed.seed) !== null) rowVariationSeed = num(seed.seed) >>> 0;
            rowHouseManualMode = seed.manualMode === true;
        }
        // Note: baseRotation is intentionally NOT reset here - it's set by calculateMaxBuildingDimensions
        // based on the longest side of the superparcel for consistent boundary checking

        // Update sliders - both length and width use the same max (polygon diameter)
        const lengthSlider = document.getElementById('rowhouse-length-slider');
        const widthSlider = document.getElementById('rowhouse-width-slider');
        const heightSlider = document.getElementById('rowhouse-height-slider');
        const chamferSlider = document.getElementById('rowhouse-chamfer-slider');

        if (lengthSlider) {
            lengthSlider.max = maxSliderValue;
            lengthSlider.value = Math.min(currentBuildingLength, maxSliderValue);
            currentBuildingLength = parseFloat(lengthSlider.value);
            document.getElementById('rowhouse-length-value').textContent = CbFormat.formatNumber(currentBuildingLength, { maxFractionDigits: 1, minFractionDigits: 1 });
        }
        if (widthSlider) {
            widthSlider.max = maxSliderValue;
            widthSlider.value = Math.min(currentBuildingWidth, maxSliderValue);
            currentBuildingWidth = parseFloat(widthSlider.value);
            document.getElementById('rowhouse-width-value').textContent = CbFormat.formatNumber(currentBuildingWidth, { maxFractionDigits: 1, minFractionDigits: 1 });
        }
        if (heightSlider) {
            heightSlider.value = currentBuildingHeight;
            document.getElementById('rowhouse-height-value').textContent = CbFormat.formatNumber(currentBuildingHeight, { maxFractionDigits: 0, minFractionDigits: 0 });
        }
        if (chamferSlider) {
            chamferSlider.value = currentChamfer;
            document.getElementById('rowhouse-chamfer-value').textContent = CbFormat.formatNumber(currentChamfer, { maxFractionDigits: 1, minFractionDigits: 1 });
        }
        const rowRuleSelectEl = document.getElementById('rowhouse-ruletype-select');
        if (rowRuleSelectEl) rowRuleSelectEl.value = rowRuleKind;
        const rowMinPlotEl = document.getElementById('rowhouse-minplot-slider');
        if (rowMinPlotEl) {
            rowMinPlotEl.value = rowMinPlotAreaM2;
            document.getElementById('rowhouse-minplot-value').textContent = String(rowMinPlotAreaM2);
        }
        syncRowRuleControls();
        syncRowHouseGeometryControls();

        // Generate row house immediately
        rowHouseGenerationTimer = setTimeout(() => {
            rowHouseGenerationTimer = null;
            if (!rowHouseModal || rowHouseBlock !== block) return;
            if (seedFeature?.geometry && rowHouseFeatureValid(seedFeature)) {
                seedFeature.properties = {
                    ...(seedFeature.properties || {}),
                    type: 'proposedRowHouse',
                    height: Math.round(currentBuildingHeight || DEFAULT_BUILDING_HEIGHT),
                    footprintMode: 'polygon'
                };
                generatedRowHouseFeature = seedFeature;
                displayRowHouseBuildingInModal(seedFeature);
                autosaveRowHouseDraft();
                const doneButton = document.getElementById('btn-rowhouse-done');
                if (doneButton) doneButton.disabled = false;
                setRowHouseInfo('', '');
            } else {
                generateRowHouseInModal();
            }
        }, 500);
        return true;
    }

    function displayBlockOnRowHouseMap(block) {
        // Clear existing layers
        if (rowHouseParcelLayer) {
            rowHouseMap.removeLayer(rowHouseParcelLayer);
            rowHouseParcelLayer = null;
        }

        // Create a feature collection for all parcels in the block
        const features = block.parcels.map(parcel => parcel.feature);
        const featureCollection = {
            type: 'FeatureCollection',
            features: features
        };

        // Add the parcels to the map
        rowHouseParcelLayer = L.geoJSON(featureCollection, {
            pane: rowHouseModal?.pane,
            style: {
                fillColor: 'red',
                fillOpacity: 0.2,
                color: 'red',
                weight: 2
            }
        }).addTo(rowHouseMap);

        // Fit the map to the bounds of the block
        rowHouseModal?.fitFeature(block.site?.geometry ? block.site : featureCollection, { maxZoom: 21 });
    }

    // The X / Esc path. Closing NEVER saves — only "Done" (saveRowHouseDesignForProposal) does.
    // When the editor is running a commit-on-confirm session (a geometry edit, or a Build-palette
    // creation) the design would be lost, so ask first; declining keeps the editor open.
    async function requestCloseRowHouseModal() {
        if (typeof window !== 'undefined' && typeof window.confirmDiscardProposalDesignSession === 'function') {
            const proceed = await window.confirmDiscardProposalDesignSession({ hasDesign: !!generatedRowHouseFeature });
            if (!proceed) return;
        }
        closeRowHouseModal();
    }

    function closeRowHouseModal(options = {}) {
        const { preservePending = false } = options;
        if (rowHouseGenerationTimer !== null) {
            clearTimeout(rowHouseGenerationTimer);
            rowHouseGenerationTimer = null;
        }
        destroyRowHousePolygonEditor();
        rowHouseHistoryKeydown?.();
        rowHouseHistoryKeydown = null;
        rowHouseHistory?.destroy?.();
        rowHouseHistory = null;
        if (rowHouseUndoButton?.parentNode) rowHouseUndoButton.parentNode.removeChild(rowHouseUndoButton);
        rowHouseUndoButton = null;
        rowHousePendingVertexActionIndex = null;
        if (rowHouseMap) {
            [rowHouseParcelLayer, rowHouseBuildingLayer].forEach(layer => {
                if (layer) { try { rowHouseMap.removeLayer(layer); } catch (_) { } }
            });
            [rowUnitLayers, rowExcludedLayers].forEach(layers => layers.forEach(layer => {
                if (layer) { try { rowHouseMap.removeLayer(layer); } catch (_) { } }
            }));
        }
        rowHouseParcelLayer = null;
        rowHouseBuildingLayer = null;
        rowUnitLayers = [];
        rowExcludedLayers = [];
        rowHouseMap = null;
        const editorSession = rowHouseModal;
        rowHouseModal = null;
        editorSession?.close();

        // Clear state
        generatedRowHouseFeature = null;
        rowHouseSeedFeature = null;
        rowHouseBlock = null;
        rowHouseBlockNameOverride = null;
        rowHouseManualMode = false;

        // Clear cached superparcel data
        cachedSuperparcel = null;
        cachedSuperparcelMeters = null;
        cachedCentroid = null;
        cachedMetersPerDegLng = null;
        cachedMetersPerDegLat = null;

        document.dispatchEvent(new CustomEvent('rowHouseModalClosed'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));

        // Reset parameters to defaults
        currentBuildingLength = DEFAULT_BUILDING_LENGTH;
        currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
        currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
        currentChamfer = DEFAULT_CHAMFER;
        currentOffsetX = 0;
        currentOffsetY = 0;
        currentRotation = 0;
        baseRotation = 0;

        if (!preservePending) {
            setPendingRowHouseProposalContext(null);
            if (typeof window !== 'undefined') {
                window.pendingRowHouseFromModal = null;
            }
        }
        if (typeof window !== 'undefined') {
            // Only "Done" commits — it tears down with preservePending after saving. Every other
            // close abandons the design session, leaving the edited object exactly as it was.
            if (!preservePending) window.discardProposalDraftDesignSession?.();
            window.finishProposalDraftDesignSession?.();
        }
    }

    // Save design for proposal
    // Gentle nudge before proposing row houses across parcels that vary a lot in size/shape. Returns
    // true to proceed (similar enough, user accepted, or measurement/confirm unavailable), false only
    // when the user backs out. Never throws — a warning must not block a valid save.
    async function confirmRowHouseParcelSimilarity(block) {
        try {
            if (typeof window === 'undefined' || typeof window.ProposalWarnings === 'undefined'
                || typeof turf === 'undefined' || typeof window.showStyledConfirm !== 'function') return true;
            const measured = (block.parcels || []).map(parcel => {
                const feature = parcel && parcel.feature;
                if (!feature || !feature.geometry) return null;
                try {
                    return { area: turf.area(feature), perimeter: turf.length(feature, { units: 'kilometers' }) * 1000 };
                } catch (_) { return null; }
            }).filter(Boolean);
            const assessment = window.ProposalWarnings.assessRowHouseSimilarity(measured);
            if (!assessment.dissimilar) return true;
            const message = translateRowHouseText(
                'rowHouses.modal.warnings.dissimilarParcels',
                'Row houses can be defined on any parcels, but the {{count}} selected parcels vary a lot in size and shape. It will still work — row houses typically sit on similar-sized, similar-shaped parcels. Do you want to proceed?',
                { count: assessment.count }
            );
            return await window.showStyledConfirm(message, {
                okText: translateRowHouseText('rowHouses.modal.warnings.proceed', 'Proceed anyway'),
                cancelText: translateRowHouseText('rowHouses.modal.warnings.cancel', 'Go back')
            });
        } catch (err) {
            console.warn('[row-house] parcel-similarity check failed', err);
            return true;
        }
    }

    async function saveRowHouseDesignForProposal() {
        if (!generatedRowHouseFeature) {
            setRowHouseInfo('rowHouses.modal.messages.generateBeforeFinishing', 'Generate a row house before finishing.');
            return;
        }

        const block = getActiveRowHouseBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            setRowHouseInfo('rowHouses.modal.messages.blockHasNoParcels', 'Block has no parcels.');
            return;
        }

        if (!(await confirmRowHouseParcelSimilarity(block))) return;

        const parentDetails = [];
        const normalizedParcelIds = [];

        // Clear multi-selection if available
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
        }

        if (!block.syntheticSite) block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const idStr = parcelId.toString();
            let number = idStr;
            try {
                if (parcel.feature?.properties?.BROJ_CESTICE) {
                    number = String(parcel.feature.properties.BROJ_CESTICE);
                }
            } catch (_) { }
            normalizedParcelIds.push(idStr);
            parentDetails.push({ id: idStr, number });
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection?.selectedParcels) {
                multiParcelSelection.selectedParcels.add(idStr);
            }
        });

        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length && !block.syntheticSite) {
            setRowHouseInfo('rowHouses.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
            return;
        }

        const clonedFeature = window.UrbanRuleVariation.massingWithRule(generatedRowHouseFeature, currentRowRule(), rowVariationSeed, { turf });
        const clonedUnits = [cloneRowHouseFeature(clonedFeature)];
        const context = {
            parcelIds: normalizedParcelIds.slice(),
            parentDetails: parentDetails.slice(),
            blockName: getRowHouseDisplayName(),
            parameters: {
                length: Number.isFinite(Number(currentBuildingLength)) ? Number(currentBuildingLength) : null,
                width: Number.isFinite(Number(currentBuildingWidth)) ? Number(currentBuildingWidth) : null,
                height: Number.isFinite(Number(currentBuildingHeight)) ? Number(currentBuildingHeight) : null,
                chamfer: Number.isFinite(Number(currentChamfer)) ? Number(currentChamfer) : null,
                offsetX: Number.isFinite(Number(currentOffsetX)) ? Number(currentOffsetX) : 0,
                offsetY: Number.isFinite(Number(currentOffsetY)) ? Number(currentOffsetY) : 0,
                rotation: Number.isFinite(Number(currentRotation)) ? Number(currentRotation) : 0,
                typology: 'row',
                // What the rule compels and the variation it was saved with, so reopening redraws
                // the same terrace rather than a different one under the same name.
                rule: currentRowRule(),
                seed: rowVariationSeed,
                manualMode: rowHouseManualMode,
                placementBaseSite: cloneRowHouseFeature(block.generatorSite || block.site || cachedSuperparcel)
            },
            buildingFeature: clonedFeature,
            buildings: clonedUnits,
            placement: { site: cloneRowHouseFeature(generatedRowHouseFeature), free: true }
        };

        window.pendingRowHouseFromModal = clonedFeature;
        window.pendingBuildingFromBlockify = clonedFeature; // For compatibility with proposal creation
        setPendingRowHouseProposalContext(context);

        // Also set the building context for existing proposal creation flow
        if (typeof setPendingBuildingProposalContext === 'function') {
            setPendingBuildingProposalContext(context);
        } else if (typeof window !== 'undefined') {
            window.pendingBuildingProposalContext = context;
        }

        closeRowHouseModal({ preservePending: true });

        if (typeof updateStatus === 'function') {
            updateStatus('Row house design saved. Add proposal details to submit.');
        }

        const description = document.getElementById('proposalDescription');
        if (description) {
            if (!description.value.trim()) {
                description.value = translateRowHouseText(
                    'rowHouses.modal.messages.defaultProposalDescription',
                    'Row house proposal for {{blockName}}',
                    { blockName: context.blockName || 'selected parcels' }
                );
            }
            description.focus();
        }
    }

    // Entry point for opening row house modal from parcels
    // Saved parameters keep the sliders meaningful; `initialFeature` preserves arbitrary edits or
    // an uploaded polygon instead of regenerating a rectangle when the proposal is reopened.
    function openRowHouseForParcels({ blockName, parcelIds, initialParameters = null, initialFeature = null, site = null }) {
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        const authoredSite = site?.type === 'Feature' && site.geometry ? cloneRowHouseFeature(site) : null;
        if (!ids.length && !authoredSite?.geometry) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select parcels before launching the row house tool.');
            }
            return false;
        }
        rowHouseSeedParameters = initialParameters || null;
        rowHouseSeedFeature = initialFeature?.geometry ? cloneRowHouseFeature(initialFeature) : null;

        const liveParcels = rowHouseParcelsForIds(ids);
        if (liveParcels.length !== ids.length) {
            if (typeof updateStatus === 'function') {
                updateStatus(translateRowHouseText('status.messages.could_not_resolve_parcel_data_for_the_selected_parcels', 'Could not resolve parcel data for the selected parcels.'));
            }
            return false;
        }
        if (!ids.length && authoredSite?.geometry) liveParcels.push({ id: '__placement-site__', feature: authoredSite });

        rowHouseBlock = {
            parcels: liveParcels,
            parcelIds: ids,
            site: authoredSite,
            generatorSite: initialParameters?.placementBaseSite?.geometry
                ? cloneRowHouseFeature(initialParameters.placementBaseSite)
                : cloneRowHouseFeature(authoredSite),
            syntheticSite: ids.length === 0,
            valid: true,
            polygon: null
        };
        rowHouseBlockNameOverride = blockName || describeRowHouseParcelSelection(ids);
        return showRowHouseModal() === true;
    }

    // Export to window
    if (typeof window !== 'undefined') {
        window.openRowHouseForParcels = openRowHouseForParcels;
        window.closeRowHouseModal = closeRowHouseModal;
        window.setPendingRowHouseProposalContext = setPendingRowHouseProposalContext;
    }

})();
