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
    let rowHouseParcelLayer = null;
    let rowHouseBuildingLayer = null;
    let rowHousePolygonEditor = null;
    let rowHousePendingVertexActionIndex = null;
    let generatedRowHouseFeature = null;
    let rowHouseBlockNameOverride = null;
    let rowHouseBlock = null;
    let pendingRowHouseProposalContext = null;
    let rowHouseMapResizeObserver = null;

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

    // Cached superparcel data for boundary checking
    let cachedSuperparcel = null;
    let cachedSuperparcelMeters = null;
    let cachedCentroid = null;
    let cachedMetersPerDegLng = null;
    let cachedMetersPerDegLat = null;

    // 3D preview state
    let rowHouse3D = {
        handle: null,
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        frameId: null,
        container: null,
        originHTRS: null,
        modelGroup: null,
        contextGroup: null,
        resizeHandler: null,
        hasCenteredOnce: false,
        anchorLngLat: { lng: 0, lat: 0 }
    };
    let rowHouseThreeLoadPromise = null;

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
            return api.t(key, params);
        }
        return formatRowHouseText(fallback, params);
    }

    function showRowHouseAlert(key, fallback, params = {}) {
        const message = key
            ? translateRowHouseText(`alerts.messages.${key}`, fallback, params)
            : translateRowHouseText('', fallback, params);
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
            ? window.showStyledAlert
            : window.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    }

    function showRowHouseEditorAlert(key, fallback) {
        const message = translateRowHouseText(`rowHouses.modal.${key}`, fallback);
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
            ? window.showStyledAlert
            : window.alert;
        if (typeof alertFn === 'function') alertFn(message);
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
            if (!cachedSuperparcel?.geometry) return true;
            const outside = turf.difference(feature, cachedSuperparcel);
            return !outside || turf.area(outside) <= 0.05;
        } catch (_) {
            try { return turf.booleanWithin(feature, cachedSuperparcel); } catch (_) { return false; }
        }
    }

    function destroyRowHousePolygonEditor() {
        if (!rowHousePolygonEditor) return;
        try { rowHousePolygonEditor.destroy(); } catch (_) { }
        rowHousePolygonEditor = null;
    }

    // Keep the Leaflet map sized to its flex container so the full viewport stays interactive
    function invalidateRowHouseMapSize(reason = 'unknown') {
        if (!rowHouseMap || typeof rowHouseMap.invalidateSize !== 'function') return;

        const run = () => {
            try {
                rowHouseMap.invalidateSize();
                const container = typeof rowHouseMap.getContainer === 'function'
                    ? rowHouseMap.getContainer()
                    : null;
                if (container && typeof console !== 'undefined' && typeof console.debug === 'function') {
                    console.debug('[RowHouses] invalidate map size', reason, container.clientWidth, container.clientHeight);
                }
            } catch (err) {
                if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                    console.warn('[RowHouses] map size invalidate failed', err);
                }
            }
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 0);
        }
    }

    function attachRowHouseMapResizeObserver() {
        if (rowHouseMapResizeObserver || typeof ResizeObserver === 'undefined') return;
        const target = document.getElementById('rowhouse-main') || document.getElementById('rowhouse-map');
        if (!target) return;
        rowHouseMapResizeObserver = new ResizeObserver(() => invalidateRowHouseMapSize('resize-observer'));
        try { rowHouseMapResizeObserver.observe(target); } catch (_) { }
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
        return translateRowHouseText('rowHouses.modal.messages.multiParcelLabel', '{{count}} Parcels', { count: ids.length });
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
        const metersPerDegLng = 111320 * Math.cos(cLat * Math.PI / 180);
        const metersPerDegLat = 110540;

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

        // Create superparcel by merging all parcels
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = robustUnionLocal(parcelFeatures);

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
        const metersPerDegLng = 111320 * Math.cos(cLat * Math.PI / 180);
        const metersPerDegLat = 110540;

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

        // Create superparcel by merging all parcels
        const parcelFeatures = block.parcels.map(p => p.feature);
        let superparcel = robustUnionLocal(parcelFeatures);

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
        const metersPerDegLng = 111320 * Math.cos(cLat * Math.PI / 180);
        const metersPerDegLat = 110540;

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
    function startDrag(e) {
        const originalTarget = e?.originalEvent?.target;
        if (originalTarget && typeof originalTarget.closest === 'function'
            && originalTarget.closest('.polygon-geometry-editor__vertex, .polygon-geometry-editor__delete-marker')) return;
        isDragging = true;
        dragStartLatLng = e.latlng;
        dragStartOffset = [currentOffsetX, currentOffsetY];
        dragStartFeature = cloneRowHouseFeature(generatedRowHouseFeature);
        dragLastValidFeature = cloneRowHouseFeature(generatedRowHouseFeature);
        rowHousePendingVertexActionIndex = null;
        destroyRowHousePolygonEditor();

        rowHouseMap.dragging.disable();
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
    }

    // Handle drag movement
    function onDragMove(e) {
        if (!isDragging || !rowHouseMap || !dragStartLatLng) return;

        const containerPoint = rowHouseMap.mouseEventToContainerPoint(e);
        const latlng = rowHouseMap.containerPointToLatLng(containerPoint);

        const projector = getRowHouseProjector();
        if (!projector || !dragStartFeature?.geometry || !window.SingleBuildingGeometry?.translateGeometry) return;
        const startPoint = projector.project(dragStartLatLng);
        const currentPoint = projector.project(latlng);
        const geometry = window.SingleBuildingGeometry.translateGeometry(
            projector,
            dragStartFeature.geometry,
            currentPoint[0] - startPoint[0],
            currentPoint[1] - startPoint[1]
        );
        const candidate = cloneRowHouseFeature(dragStartFeature);
        if (!candidate || !geometry) return;
        candidate.geometry = geometry;
        if (!rowHouseFeatureValid(candidate)) return;

        const startMeters = latLngToMeters(dragStartLatLng);
        const currentMeters = latLngToMeters(latlng);
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
        try { updateRowHouse3DScene(candidate); } catch (_) { }
    }

    // End drag interaction
    function onDragEnd() {
        const finalFeature = dragLastValidFeature || dragStartFeature;
        isDragging = false;
        dragStartLatLng = null;
        dragStartOffset = null;
        dragStartFeature = null;
        dragLastValidFeature = null;
        if (rowHouseMap) rowHouseMap.dragging.enable();
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        if (finalFeature) {
            generatedRowHouseFeature = finalFeature;
            displayRowHouseBuildingInModal(finalFeature);
            autosaveRowHouseDraft();
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
        generatedRowHouseFeature = candidate;
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
            leaflet: L,
            turf,
            ring,
            boundary: () => cachedSuperparcel,
            initialSelectedVertexIndex,
            showInitialDeleteAction: Number.isInteger(initialSelectedVertexIndex),
            vertexTitle: translateRowHouseText('rowHouses.modal.vertexLabel', 'Drag to reshape'),
            deleteTitle: translateRowHouseText('rowHouses.modal.deleteVertexLabel', 'Delete selected vertex'),
            onCommit: ({ ring: committedRing, reason, vertexIndex }) => {
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
                getRowHouseProjector(),
                generatedRowHouseFeature.geometry,
                deltaDegrees
            );
            if (geometry) {
                candidate = cloneRowHouseFeature(generatedRowHouseFeature);
                candidate.geometry = geometry;
            }
        } catch (_) { }
        if (!candidate || !rowHouseFeatureValid(candidate)) return;
        currentRotation += deltaDegrees * Math.PI / 180;
        candidate.properties = {
            ...(generatedRowHouseFeature.properties || {}),
            rotation: currentRotation,
            footprintMode: 'polygon'
        };
        generatedRowHouseFeature = candidate;
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
            const constrained = window.PolygonGeometryEditor.constrainRingToBoundary(ring, cachedSuperparcel, turf) || ring;
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
            generatedRowHouseFeature = candidate;
            displayRowHouseBuildingInModal(candidate);
            autosaveRowHouseDraft();
        };
        reader.onerror = () => showRowHouseEditorAlert('uploadError', 'Could not read that file.');
        reader.readAsText(file);
    }

    // Display building on the modal map
    function displayRowHouseBuildingInModal(feature) {
        if (!rowHouseMap) return;

        destroyRowHousePolygonEditor();
        if (rowHouseBuildingLayer) {
            rowHouseMap.removeLayer(rowHouseBuildingLayer);
            rowHouseBuildingLayer = null;
        }

        if (!feature || !feature.geometry) return;

        rowHouseBuildingLayer = L.geoJSON(feature, {
            style: {
                fillColor: '#0d6efd',
                fillOpacity: 0.5,
                color: '#0d6efd',
                weight: 2,
                cursor: 'move'
            },
            onEachFeature: function (feat, layer) {
                // Enable dragging on the polygon
                layer.on('mousedown', (e) => {
                    L.DomEvent.stopPropagation(e);
                    startDrag(e);
                });
            }
        }).addTo(rowHouseMap);

        // Vertex/edge interaction is shared with block-manual and freeform-building editors.
        renderRowHousePolygonEditor();

        // Update metrics display
        updateBuildingMetrics(feature);

        // Update 3D view
        try { updateRowHouse3DScene(feature); } catch (_) { }
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
            circumferenceEl.textContent = circumference.toFixed(1);

            // Calculate area using turf
            const area = turf.area(feature);
            areaEl.textContent = area.toFixed(1);

            // Calculate volume (area * height)
            const height = feature.properties.height || currentBuildingHeight || DEFAULT_BUILDING_HEIGHT;
            const volume = area * height;
            volumeEl.textContent = volume.toFixed(1);
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
        block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const id = String(parcelId);
            parcelIds.push(id);
            parentDetails.push({ id, number: String(props?.BROJ_CESTICE || id) });
        });
        const feature = JSON.parse(JSON.stringify(generatedRowHouseFeature));
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
                typology: 'row'
            },
            buildingFeature: feature,
            buildings: [feature]
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
            // Ensure 3D is initialized
            try { if (!rowHouse3D || !rowHouse3D.renderer) initRowHouse3DSimple(); } catch (_) { }

            // Check if current parameters fit, if not try to adjust offset
            if (!checkBuildingFitsInSuperparcel(currentBuildingLength, currentBuildingWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
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

    // --- 3D Preview ---

    async function ensureThreeForRowHouse() {
        if (typeof THREE !== 'undefined') return true;

        const loadScript = (src) => new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });

        if (!rowHouseThreeLoadPromise) {
            rowHouseThreeLoadPromise = loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js');
        }
        await rowHouseThreeLoadPromise;

        if (typeof THREE === 'undefined') return false;

        if (typeof THREE.OrbitControls === 'undefined') {
            await loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js');
        }

        return typeof THREE !== 'undefined';
    }

    function getRowHouseProjector() {
        const crs = (rowHouseMap && rowHouseMap.options && rowHouseMap.options.crs) || L.CRS.EPSG3857;
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

    function computeRowHouseOrigin(feature, projector) {
        try {
            if (!feature || !feature.geometry || !projector) return [0, 0];
            const coords = [];
            const geom = feature.geometry;
            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(ring => {
                    ring.forEach(coord => coords.push(coord));
                });
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => {
                    poly.forEach(ring => {
                        ring.forEach(coord => coords.push(coord));
                    });
                });
            }
            if (!coords.length) return [0, 0];
            let sumX = 0, sumY = 0;
            coords.forEach(([lng, lat]) => {
                const [x, y] = projector.project(L.latLng(lat, lng));
                sumX += x;
                sumY += y;
            });
            return [sumX / coords.length, sumY / coords.length];
        } catch (_) {
            return [0, 0];
        }
    }

    async function initRowHouse3DSimple() {
        const ok = await ensureThreeForRowHouse();
        if (!ok) return;
        const container = document.getElementById('rowhouse-3d');
        if (!container) return;

        disposeRowHouse3D();

        const handle = window.ThreeEditScene.create({ container, defaultHeight: 200 });

        const modelGroup = new THREE.Group();
        handle.scene.add(modelGroup);

        rowHouse3D.handle = handle;
        rowHouse3D.container = handle.container;
        rowHouse3D.renderer = handle.renderer;
        rowHouse3D.scene = handle.scene;
        rowHouse3D.camera = handle.camera;
        rowHouse3D.controls = handle.controls;
        rowHouse3D.modelGroup = modelGroup;
        rowHouse3D.contextGroup = handle.contextGroup;
    }

    function disposeRowHouse3D() {
        if (rowHouse3D.handle && typeof rowHouse3D.handle.dispose === 'function') {
            rowHouse3D.handle.dispose();
        }
        rowHouse3D.handle = null;
        rowHouse3D.renderer = null;
        rowHouse3D.scene = null;
        rowHouse3D.camera = null;
        rowHouse3D.controls = null;
        rowHouse3D.frameId = null;
        rowHouse3D.container = null;
        rowHouse3D.originHTRS = null;
        rowHouse3D.modelGroup = null;
        rowHouse3D.contextGroup = null;
        rowHouse3D.resizeHandler = null;
    }

    function loadRowHouseContextBuildings(queryFeature, origin) {
        if (!rowHouse3D.contextGroup || !window.ContextBuildings3D || !queryFeature || !queryFeature.geometry) return;
        const projector = getRowHouseProjector();
        if (!projector) return;
        const safeOrigin = Array.isArray(origin) ? origin : [0, 0];
        const latLngToLocalXY = (lng, lat) => {
            const [x, y] = projector.project(L.latLng(lat, lng));
            return [x - safeOrigin[0], y - safeOrigin[1]];
        };
        try {
            window.ContextBuildings3D.loadInto(rowHouse3D.contextGroup, {
                geometry: queryFeature.geometry,
                latLngToLocalXY
            });
        } catch (e) {
            console.warn('[row-house] context buildings load failed:', e);
        }
    }

    function clearThreeGroup(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            try {
                if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
            } catch (_) { }
            try {
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => { if (mat && typeof mat.dispose === 'function') mat.dispose(); });
                    } else if (typeof child.material.dispose === 'function') {
                        child.material.dispose();
                    }
                }
            } catch (_) { }
            try { group.remove(child); } catch (_) { }
        }
    }

    function updateRowHouse3DScene(feature) {
        if (!rowHouse3D.modelGroup || typeof THREE === 'undefined' || !feature || !feature.geometry) return;

        clearThreeGroup(rowHouse3D.modelGroup);

        const projector = getRowHouseProjector();
        const origin = computeRowHouseOrigin(feature, projector);
        rowHouse3D.originHTRS = origin;
        loadRowHouseContextBuildings(feature, origin);

        const geom = feature.geometry;
        if (geom.type !== 'Polygon') return;

        const height = feature.properties?.height || currentBuildingHeight || DEFAULT_BUILDING_HEIGHT;
        const ring = geom.coordinates[0];

        if (!Array.isArray(ring) || ring.length < 4) return;

        const shape = new THREE.Shape();
        ring.forEach(([lng, lat], idx) => {
            const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : [lng, lat];
            const px = x - origin[0];
            const py = y - origin[1];
            if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
        });

        const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
        const material = new THREE.MeshLambertMaterial({ color: 0x0d6efd, transparent: true, opacity: 0.8 });
        const mesh = new THREE.Mesh(extrudeGeom, material);
        rowHouse3D.modelGroup.add(mesh);

        // Add edges
        const edgeGeom = new THREE.EdgesGeometry(extrudeGeom);
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x333333 });
        const edges = new THREE.LineSegments(edgeGeom, edgeMaterial);
        rowHouse3D.modelGroup.add(edges);

        // Fit camera
        fitRowHouseCamera(height);
    }

    function fitRowHouseCamera(height = 20) {
        if (!rowHouse3D.camera || !rowHouse3D.controls || !rowHouse3D.modelGroup) return;

        const box = new THREE.Box3().setFromObject(rowHouse3D.modelGroup);
        if (box.isEmpty()) return;

        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z, 50);
        const dist = maxDim * 1.5;

        rowHouse3D.camera.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.4);
        rowHouse3D.controls.target.copy(center);
        rowHouse3D.camera.lookAt(center);
    }

    // --- Modal management ---

    function showRowHouseModal() {
        const block = getActiveRowHouseBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('No block selected');
            }
            return;
        }

        rowHouseBlock = block;
        const blockLabel = getRowHouseDisplayName();

        console.log('[RowHouses] showRowHouseModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

        // Create modal if it doesn't exist
        if (!document.getElementById('rowhouse-modal')) {
            const modalDiv = document.createElement('div');
            modalDiv.id = 'rowhouse-modal';
            // Use same structure as blockify modal for consistent styling
            modalDiv.className = 'rowhouse-modal-overlay';

            const container = document.createElement('div');
            container.id = 'rowhouse-container';

            container.innerHTML = `
                <div id="rowhouse-main">
                    <div id="rowhouse-header">
                        <h2 data-i18n-key="rowHouses.modal.title">Row Houses</h2>
                        <button id="rowhouse-close" type="button" class="close-circle-btn close-circle-btn--lg" data-i18n-key="rowHouses.modal.closeAria" data-i18n-attr="aria-label" aria-label="Close row houses modal">×</button>
                    </div>
                    <div id="rowhouse-map"></div>
                    <div id="rowhouse-3d"></div>
                    <div id="rowhouse-controls">
                        <div id="rowhouse-info" data-i18n-attr="text"></div>
                        <div id="rowhouse-buttons" style="display: flex; justify-content: center;">
                            <button class="btn btn-proposal" id="btn-rowhouse-done" style="width: auto; padding: 8px 24px;" data-i18n-key="rowHouses.modal.done" data-i18n-attr="text">Done</button>
                        </div>
                    </div>
                </div>
                <div id="rowhouse-sidebar">
                    <h3 data-i18n-key="rowHouses.modal.parametersTitle">Parameters</h3>
                    <div class="parameter-group">
                        <label for="rowhouse-length-slider">
                            <span data-i18n-key="rowHouses.modal.labels.length" data-i18n-attr="text">Length (m):</span>
                            <span id="rowhouse-length-value">${DEFAULT_BUILDING_LENGTH.toFixed(1)}</span>
                        </label>
                        <input type="range" id="rowhouse-length-slider" min="4" max="200" value="${DEFAULT_BUILDING_LENGTH}" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-width-slider">
                            <span data-i18n-key="rowHouses.modal.labels.width" data-i18n-attr="text">Width (m):</span>
                            <span id="rowhouse-width-value">${DEFAULT_BUILDING_WIDTH.toFixed(1)}</span>
                        </label>
                        <input type="range" id="rowhouse-width-slider" min="2" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-height-slider">
                            <span data-i18n-key="rowHouses.modal.labels.height" data-i18n-attr="text">Height (m):</span>
                            <span id="rowhouse-height-value">${DEFAULT_BUILDING_HEIGHT.toFixed(0)}</span>
                        </label>
                        <input type="range" id="rowhouse-height-slider" min="3" max="80" value="${DEFAULT_BUILDING_HEIGHT}" step="1">
                    </div>
                    <div class="parameter-group">
                        <label for="rowhouse-chamfer-slider">
                            <span data-i18n-key="rowHouses.modal.labels.chamfer" data-i18n-attr="text">Chamfer (m):</span>
                            <span id="rowhouse-chamfer-value">${DEFAULT_CHAMFER.toFixed(1)}</span>
                        </label>
                        <input type="range" id="rowhouse-chamfer-slider" min="0" max="10" value="${DEFAULT_CHAMFER}" step="0.5">
                    </div>
                    <div class="parameter-group">
                        <label data-i18n-key="rowHouses.modal.labels.rotation" data-i18n-attr="text">Rotate footprint</label>
                        <div class="single-building-rotation-buttons">
                            <button id="rowhouse-rotate-counterclockwise" class="btn btn-light" type="button" data-i18n-key="rowHouses.modal.rotateCounterclockwise" data-i18n-attr="aria-label" aria-label="Rotate counterclockwise 5 degrees">&#8634; 5°</button>
                            <button id="rowhouse-rotate-clockwise" class="btn btn-light" type="button" data-i18n-key="rowHouses.modal.rotateClockwise" data-i18n-attr="aria-label" aria-label="Rotate clockwise 5 degrees">&#8635; 5°</button>
                        </div>
                    </div>
                    <div class="parameter-group">
                        <button id="rowhouse-geojson-upload" class="btn btn-secondary" type="button" style="width:100%;" data-i18n-key="rowHouses.modal.uploadGeojson" data-i18n-attr="text">Upload GeoJSON</button>
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
                </div>
            `;

            modalDiv.appendChild(container);
            document.body.appendChild(modalDiv);

            setRowHouseInfo('rowHouses.modal.generating', 'Generating row houses...');

            // Apply translations
            try {
                if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                    window.i18n.applyTranslations(container);
                }
            } catch (_) { }

            document.dispatchEvent(new CustomEvent('rowHouseModalOpened'));
            document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

            // Add event listeners
            document.getElementById('rowhouse-close').addEventListener('click', requestCloseRowHouseModal);
            document.addEventListener('keydown', handleRowHouseKeydown);
            const doneButton = document.getElementById('btn-rowhouse-done');
            if (doneButton) {
                doneButton.addEventListener('click', saveRowHouseDesignForProposal);
                doneButton.disabled = true;
            }

            // Slider event listeners with boundary checking
            document.getElementById('rowhouse-length-slider').addEventListener('input', function (e) {
                const proposedLength = parseFloat(e.target.value);
                // Check if proposed length fits (try to adjust position first)
                if (checkBuildingFitsInSuperparcel(proposedLength, currentBuildingWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
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
                document.getElementById('rowhouse-length-value').textContent = currentBuildingLength.toFixed(1);
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-chamfer-slider').addEventListener('input', function (e) {
                currentChamfer = parseFloat(e.target.value);
                document.getElementById('rowhouse-chamfer-value').textContent = currentChamfer.toFixed(1);
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-width-slider').addEventListener('input', function (e) {
                const proposedWidth = parseFloat(e.target.value);
                // Check if proposed width fits (try to adjust position first)
                if (checkBuildingFitsInSuperparcel(currentBuildingLength, proposedWidth, currentChamfer, currentOffsetX, currentOffsetY, currentRotation)) {
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
                document.getElementById('rowhouse-width-value').textContent = currentBuildingWidth.toFixed(1);
                generateRowHouseInModal();
            });

            document.getElementById('rowhouse-height-slider').addEventListener('input', function (e) {
                currentBuildingHeight = parseFloat(e.target.value);
                document.getElementById('rowhouse-height-value').textContent = currentBuildingHeight.toFixed(0);
                // Height affects 3D extrusion and volume metric
                if (generatedRowHouseFeature) {
                    generatedRowHouseFeature.properties.height = Math.round(currentBuildingHeight);
                    updateRowHouse3DScene(generatedRowHouseFeature);
                    updateBuildingMetrics(generatedRowHouseFeature);
                    autosaveRowHouseDraft();
                }
            });

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

            // Ensure 3D canvas is interactive
            const threeDiv = document.getElementById('rowhouse-3d');
            if (threeDiv) {
                threeDiv.style.pointerEvents = 'auto';
            }
        }

        // Initialize the map if needed
        if (!rowHouseMap) {
            rowHouseMap = L.map('rowhouse-map', {
                zoomControl: true,
                dragging: true,
                scrollWheelZoom: true,
                maxZoom: 22
            });

            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 22,
                maxNativeZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(rowHouseMap);

            attachRowHouseMapResizeObserver();
        }

        invalidateRowHouseMapSize('modal-open');

        // Display the block on the map
        displayBlockOnRowHouseMap(block);

        // Allow layout to settle and then ensure the map tiles fill the container
        setTimeout(() => invalidateRowHouseMapSize('post-open'), 150);

        // Calculate max dimensions based on superparcel (also sets baseRotation and cached values)
        const { maxLength, maxWidth, maxSliderValue } = calculateMaxBuildingDimensions(block);
        maxBuildingLength = maxLength;

        // Reset parameter values - start at max dimensions (1m from border)
        currentBuildingLength = maxLength;
        currentBuildingWidth = maxLength / 2; // Start with 2:1 aspect ratio
        currentBuildingHeight = DEFAULT_BUILDING_HEIGHT;
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
            document.getElementById('rowhouse-length-value').textContent = currentBuildingLength.toFixed(1);
        }
        if (widthSlider) {
            widthSlider.max = maxSliderValue;
            widthSlider.value = Math.min(currentBuildingWidth, maxSliderValue);
            currentBuildingWidth = parseFloat(widthSlider.value);
            document.getElementById('rowhouse-width-value').textContent = currentBuildingWidth.toFixed(1);
        }
        if (heightSlider) {
            heightSlider.value = currentBuildingHeight;
            document.getElementById('rowhouse-height-value').textContent = currentBuildingHeight.toFixed(0);
        }
        if (chamferSlider) {
            chamferSlider.value = currentChamfer;
            document.getElementById('rowhouse-chamfer-value').textContent = currentChamfer.toFixed(1);
        }

        // Generate row house immediately
        setTimeout(() => {
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
            style: {
                fillColor: 'red',
                fillOpacity: 0.2,
                color: 'red',
                weight: 2
            }
        }).addTo(rowHouseMap);

        // Fit the map to the bounds of the block
        rowHouseMap.fitBounds(rowHouseParcelLayer.getBounds(), {
            padding: [50, 50]
        });

        invalidateRowHouseMapSize('fit-block');

        // Safeguard: double-check sizing after the next frame in case flex layout shifts
        setTimeout(() => invalidateRowHouseMapSize('fit-block-late'), 50);

        // Initialize 3D preview
        try { initRowHouse3DSimple(); } catch (e) { console.warn('3D init failed', e); }
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

    // Escape closes the editor exactly like the X does (discard, after confirming).
    function handleRowHouseKeydown(event) {
        if (event.key !== 'Escape') return;
        if (!document.getElementById('rowhouse-modal')) return;
        event.preventDefault();
        requestCloseRowHouseModal();
    }

    // Pure teardown: the design is committed (or not) by the caller — "Done" saves first,
    // X/Esc discards the design session first.
    function closeRowHouseModal(options = {}) {
        const { preservePending = false } = options;
        document.removeEventListener('keydown', handleRowHouseKeydown);
        destroyRowHousePolygonEditor();
        rowHousePendingVertexActionIndex = null;

        if (rowHouseMapResizeObserver) {
            try { rowHouseMapResizeObserver.disconnect(); } catch (_) { }
            rowHouseMapResizeObserver = null;
        }

        // Remove the map instance
        if (rowHouseMap) {
            if (rowHouseParcelLayer) {
                rowHouseMap.removeLayer(rowHouseParcelLayer);
                rowHouseParcelLayer = null;
            }
            if (rowHouseBuildingLayer) {
                rowHouseMap.removeLayer(rowHouseBuildingLayer);
                rowHouseBuildingLayer = null;
            }
            rowHouseMap.remove();
            rowHouseMap = null;
        }

        // Clear state
        generatedRowHouseFeature = null;
        rowHouseSeedFeature = null;
        rowHouseBlock = null;
        rowHouseBlockNameOverride = null;

        // Clear cached superparcel data
        cachedSuperparcel = null;
        cachedSuperparcelMeters = null;
        cachedCentroid = null;
        cachedMetersPerDegLng = null;
        cachedMetersPerDegLat = null;

        // Dispose 3D resources
        disposeRowHouse3D();

        // Remove the modal from DOM
        const modal = document.getElementById('rowhouse-modal');
        if (modal) {
            modal.remove();
            document.dispatchEvent(new CustomEvent('rowHouseModalClosed'));
            document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));
        }

        // Force a reflow of the main map
        if (typeof map !== 'undefined' && map) {
            map.invalidateSize();
        }

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

        block.parcels.forEach(parcel => {
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

        if (!normalizedParcelIds.length) {
            setRowHouseInfo('rowHouses.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
            return;
        }

        const clonedFeature = JSON.parse(JSON.stringify(generatedRowHouseFeature));
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
                typology: 'row'
            },
            buildingFeature: clonedFeature
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
    function openRowHouseForParcels({ blockName, parcels, initialParameters = null, initialFeature = null }) {
        const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
        if (!rawParcels.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select parcels before launching the row house tool.');
            }
            return;
        }
        rowHouseSeedParameters = initialParameters || null;
        rowHouseSeedFeature = initialFeature?.geometry ? cloneRowHouseFeature(initialFeature) : null;

        const seenIds = new Set();
        const normalizedParcels = [];
        rawParcels.forEach(layer => {
            try {
                const props = layer?.feature?.properties;
                const parcelId = typeof ensureParcelId === 'function'
                    ? ensureParcelId(layer?.feature)
                    : (props?.parcelId ?? props?.parcel_id ?? props?.id);
                if (!parcelId) return;
                const idStr = parcelId.toString();
                if (seenIds.has(idStr)) return;
                seenIds.add(idStr);
                normalizedParcels.push(layer);
            } catch (_) { }
        });

        if (!normalizedParcels.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Could not resolve parcel data for the selected parcels.');
            }
            return;
        }

        const parcelIds = Array.from(seenIds);
        rowHouseBlock = {
            parcels: normalizedParcels,
            parcelIds,
            valid: true,
            polygon: null
        };
        rowHouseBlockNameOverride = blockName || describeRowHouseParcelSelection(parcelIds);
        showRowHouseModal();
    }

    // Export to window
    if (typeof window !== 'undefined') {
        window.openRowHouseForParcels = openRowHouseForParcels;
        window.closeRowHouseModal = closeRowHouseModal;
        window.setPendingRowHouseProposalContext = setPendingRowHouseProposalContext;
    }

})();
