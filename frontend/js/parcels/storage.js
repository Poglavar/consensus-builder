(function (global) {
    'use strict';

    const getCache = () => (global.ParcelsState && global.ParcelsState.getParcelCache)
        ? global.ParcelsState.getParcelCache()
        : global.parcelCache;

    const getLayerIndex = () => (global.ParcelsState && global.ParcelsState.getParcelLayerIndex)
        ? global.ParcelsState.getParcelLayerIndex()
        : global.parcelLayerIndex;

    function getFeatureParcelId(feature) {
        if (!feature) return null;
        const props = feature.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id : null;
    }

    function getLayerParcelId(layer) {
        if (!layer) return null;
        if (layer.feature) return getFeatureParcelId(layer.feature);
        return getFeatureParcelId(layer);
    }

    const bumpLayerIndexVersion = () => (global.ParcelsState && global.ParcelsState.bumpParcelLayerIndexVersion)
        ? global.ParcelsState.bumpParcelLayerIndexVersion()
        : (function () {
            global.parcelLayerIndexVersion = (global.parcelLayerIndexVersion || 0) + 1;
            return global.parcelLayerIndexVersion;
        })();

    function getParcelLayerIdMap() {
        if (!global.parcelLayerById || !(global.parcelLayerById instanceof Map)) {
            global.parcelLayerById = new Map();
        }
        return global.parcelLayerById;
    }

    function setParcelLayerById(parcelId, layer) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId || !layer) return;
        getParcelLayerIdMap().set(normalizedId, layer);
    }

    function deleteParcelLayerById(parcelId) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) return;
        const mapById = getParcelLayerIdMap();
        if (mapById.has(normalizedId)) {
            mapById.delete(normalizedId);
        }
    }

    function getGridKey(easting, northing) {
        const cache = getCache();
        if (!cache || !Number.isFinite(cache.gridSize) || cache.gridSize <= 0) {
            return null;
        }
        const gridE = Math.floor(easting / cache.gridSize);
        const gridN = Math.floor(northing / cache.gridSize);
        return `${gridE},${gridN}`;
    }

    function getRequiredGridCells(bounds, extraRadius = 0) {
        const cache = getCache();
        const cells = new Set();
        if (!bounds || typeof bounds.getSouthWest !== 'function' || !cache || !cache.gridSize) {
            return cells;
        }
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const center = bounds.getCenter && bounds.getCenter() || {
            lat: (sw.lat + ne.lat) / 2,
            lng: (sw.lng + ne.lng) / 2
        };
        const enforceRadius = Number.isFinite(extraRadius) ? Math.max(0, Math.floor(extraRadius)) : 0;
        const [centerEasting, centerNorthing] = global.wgs84ToHTRS96(center.lat, center.lng);
        const centerGridE = Math.floor(centerEasting / cache.gridSize);
        const centerGridN = Math.floor(centerNorthing / cache.gridSize);
        const [rawSwEasting, rawSwNorthing] = global.wgs84ToHTRS96(sw.lat, sw.lng);
        const [rawNeEasting, rawNeNorthing] = global.wgs84ToHTRS96(ne.lat, ne.lng);
        const minEasting = Math.min(rawSwEasting, rawNeEasting);
        const maxEasting = Math.max(rawSwEasting, rawNeEasting);
        const minNorthing = Math.min(rawSwNorthing, rawNeNorthing);
        const maxNorthing = Math.max(rawNeNorthing, rawSwNorthing);
        const epsilon = 1e-6;
        const minGridE = Math.floor(minEasting / cache.gridSize);
        const maxGridE = Math.max(minGridE, Math.floor((maxEasting - epsilon) / cache.gridSize));
        const minGridN = Math.floor(minNorthing / cache.gridSize);
        const maxGridN = Math.max(minGridN, Math.floor((maxNorthing - epsilon) / cache.gridSize));
        let radiusEast = Math.max(0, centerGridE - minGridE, maxGridE - centerGridE);
        let radiusNorth = Math.max(0, centerGridN - minGridN, maxGridN - centerGridN);
        radiusEast = Math.max(radiusEast, enforceRadius);
        radiusNorth = Math.max(radiusNorth, enforceRadius);
        const radius = Math.max(radiusEast, radiusNorth);
        for (let e = centerGridE - radius; e <= centerGridE + radius; e++) {
            for (let n = centerGridN - radius; n <= centerGridN + radius; n++) {
                cells.add(`${e},${n}`);
            }
        }
        return cells;
    }

    function computeGridKeysForBounds(bounds) {
        if (!bounds || typeof bounds.getSouthWest !== 'function') {
            return [];
        }
        if (typeof getRequiredGridCells === 'function') {
            const keys = Array.from(getRequiredGridCells(bounds, 0));
            if (keys.length) return keys;
        }
        try {
            if (typeof bounds.getCenter === 'function' && typeof global.wgs84ToHTRS96 === 'function') {
                const center = bounds.getCenter();
                const coords = global.wgs84ToHTRS96(center.lat, center.lng);
                if (Array.isArray(coords) && coords.length >= 2) {
                    return [getGridKey(coords[0], coords[1])];
                }
            }
        } catch (_) { }
        return [];
    }

    function indexParcelLayer(layer) {
        const index = getLayerIndex();
        if (!layer || typeof layer.getBounds !== 'function' || !index) return;
        unindexParcelLayer(layer);
        let keys = [];
        try {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                keys = computeGridKeysForBounds(bounds);
            }
        } catch (_) { }
        if (!Array.isArray(keys) || !keys.length) return;
        const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
        if (!uniqueKeys.length) return;
        layer.__parcelGridKeys = uniqueKeys;
        uniqueKeys.forEach(key => {
            let bucket = index.get(key);
            if (!bucket) {
                bucket = new Set();
                index.set(key, bucket);
            }
            bucket.add(layer);
        });
        bumpLayerIndexVersion();
    }

    function unindexParcelLayer(layer) {
        const index = getLayerIndex();
        if (!index || !layer || !Array.isArray(layer.__parcelGridKeys) || !layer.__parcelGridKeys.length) return;
        const keys = layer.__parcelGridKeys.slice();
        delete layer.__parcelGridKeys;
        keys.forEach(key => {
            if (!key) return;
            const bucket = index.get(key);
            if (!bucket) return;
            bucket.delete(layer);
            if (bucket.size === 0) {
                index.delete(key);
            }
        });
        bumpLayerIndexVersion();
    }

    function clearParcelLayerIndex() {
        const index = getLayerIndex();
        if (index) {
            index.clear();
        }
        bumpLayerIndexVersion();
    }

    /**
     * Efficiently get parcel layers within viewport bounds using the grid index.
     * This avoids iterating over all parcels when only viewport parcels are needed.
     * @param {L.LatLngBounds} bounds - The viewport bounds
     * @returns {Array<L.Layer>} Array of parcel layers within or intersecting the bounds
     */
    function getParcelLayersWithinBounds(bounds) {
        if (!bounds || typeof bounds.getSouthWest !== 'function') {
            return [];
        }
        const index = getLayerIndex();
        if (!index || index.size === 0) {
            // If index is empty, fallback to empty array (caller should handle this)
            return [];
        }
        const gridKeys = computeGridKeysForBounds(bounds);
        if (!Array.isArray(gridKeys) || gridKeys.length === 0) {
            return [];
        }
        const layersSet = new Set();
        const uniqueKeys = Array.from(new Set(gridKeys.filter(Boolean)));
        for (const key of uniqueKeys) {
            const bucket = index.get(key);
            if (bucket && bucket.size > 0) {
                bucket.forEach(layer => {
                    if (layer && typeof layer.getBounds === 'function') {
                        try {
                            const layerBounds = layer.getBounds();
                            if (layerBounds && layerBounds.isValid && layerBounds.isValid()) {
                                // Only include layers that actually intersect the bounds
                                if (bounds.intersects(layerBounds)) {
                                    layersSet.add(layer);
                                }
                            }
                        } catch (_) {
                            // If bounds check fails, include the layer anyway (better safe than sorry)
                            layersSet.add(layer);
                        }
                    } else {
                        // If layer has no bounds method, include it (shouldn't happen but be safe)
                        layersSet.add(layer);
                    }
                });
            }
        }
        return Array.from(layersSet);
    }

    function resolveParcelLayerById(parcelId) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) return null;

        // Fast path: use the map if available
        const mapById = global.parcelLayerById instanceof Map ? global.parcelLayerById : null;
        if (mapById && mapById.has(normalizedId)) {
            return mapById.get(normalizedId) || null;
        }

        // Fallback: scan parcelLayer
        const layerRef = global.parcelLayer;
        if (!layerRef || typeof layerRef.eachLayer !== 'function') return null;
        let resolved = null;
        layerRef.eachLayer(layer => {
            const candidate = getLayerParcelId(layer);
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                resolved = layer;
            }
        });
        return resolved;
    }

    /**
     * Remove duplicate layers from parcelLayer.
     * Keeps the first occurrence of each parcel ID and removes subsequent duplicates.
     * This fixes data quality issues where the same parcel appears multiple times in source data.
     */
    function deduplicateParcelLayer() {
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            return 0;
        }

        const currentVersion = (global.ParcelsState && global.ParcelsState.getParcelLayerIndexVersion)
            ? global.ParcelsState.getParcelLayerIndexVersion()
            : (global.parcelLayerIndexVersion || 0);
        if (typeof deduplicateParcelLayer.lastVersion === 'number' && deduplicateParcelLayer.lastVersion === currentVersion) {
            return 0;
        }

        const seenParcelIds = new Map(); // Map of parcelId -> first layer
        const duplicatesToRemove = [];
        const DEBUG_ID = '40833596';

        // First pass: identify duplicates
        global.parcelLayer.eachLayer(layer => {
            const parcelId = getLayerParcelId(layer);
            if (parcelId === undefined || parcelId === null) return;
            const normalizedId = parcelId.toString();

            if (seenParcelIds.has(normalizedId)) {
                // This is a duplicate - mark for removal
                duplicatesToRemove.push(layer);
                if (normalizedId === DEBUG_ID) {
                    console.warn(`[deduplicateParcelLayer] DEBUG: Found duplicate layer for parcel ${normalizedId}`, {
                        firstLayer: seenParcelIds.get(normalizedId),
                        duplicateLayer: layer,
                        stack: new Error().stack
                    });
                }
            } else {
                // First occurrence - keep it
                seenParcelIds.set(normalizedId, layer);
            }
        });

        // Second pass: remove duplicates
        let removedCount = 0;
        duplicatesToRemove.forEach(layer => {
            const parcelId = getLayerParcelId(layer);
            const normalizedId = parcelId ? parcelId.toString() : null;
            const isDebugParcel = normalizedId === DEBUG_ID;

            if (global.parcelLayer && global.parcelLayer.hasLayer(layer)) {
                if (isDebugParcel) {
                    console.warn(`[deduplicateParcelLayer] DEBUG: Removing duplicate layer for parcel ${normalizedId}`);
                }
                global.parcelLayer.removeLayer(layer);
                // Unindex the duplicate layer
                if (typeof global.unindexParcelLayer === 'function') {
                    global.unindexParcelLayer(layer);
                }
                // Remove mapping entry for the duplicate
                deleteParcelLayerById(normalizedId);
                removedCount++;
            }
        });

        if (removedCount > 0) {
            console.warn(`[deduplicateParcelLayer] Removed ${removedCount} duplicate parcel layer(s) from parcelLayer`);
        }

        deduplicateParcelLayer.lastVersion = currentVersion;

        return removedCount;
    }

    function removeParcelLayerById(parcelId, options = {}) {
        const skipMapScan = options.skipMapScan === true;
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) {
            console.warn(`[removeParcelLayerById] Invalid input: parcelId=${parcelId}`);
            return;
        }

        const DEBUG_ID = '40833596';
        const isDebugParcel = normalizedId === DEBUG_ID;

        if (isDebugParcel) {
            console.log(`[removeParcelLayerById] DEBUG: Removing parcel ${normalizedId}`, {
                stack: new Error().stack
            });
        }

        const layersToRemove = [];

        // Fast path: use the id map if present
        const mapById = global.parcelLayerById instanceof Map ? global.parcelLayerById : null;
        const mappedLayer = mapById ? mapById.get(normalizedId) : null;
        if (skipMapScan && !mappedLayer) {
            // Fast skip: caller requested no scans and map has no entry
            return;
        }
        if (mappedLayer) {
            layersToRemove.push(mappedLayer);
            if (isDebugParcel) {
                console.log(`[removeParcelLayerById] DEBUG: Found layer via map for ${normalizedId}`, {
                    inParcelLayer: global.parcelLayer && global.parcelLayer.hasLayer(mappedLayer),
                    onMap: global.map && global.map.hasLayer(mappedLayer)
                });
            }
        }

        // Fallback: scan parcelLayer
        if (!mappedLayer && global.parcelLayer && typeof global.parcelLayer.eachLayer === 'function') {
            global.parcelLayer.eachLayer(layer => {
                const candidate = getLayerParcelId(layer);
                if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                    layersToRemove.push(layer);
                    if (isDebugParcel) {
                        console.log(`[removeParcelLayerById] DEBUG: Found layer in parcelLayer for ${normalizedId}`, {
                            layer,
                            inParcelLayer: global.parcelLayer.hasLayer(layer),
                            onMap: global.map && global.map.hasLayer(layer)
                        });
                    }
                }
            });
        }

        // Also check directly on the map for layers that might have been added outside parcelLayer
        // (e.g., from old buggy code that added layers directly)
        if (!skipMapScan && typeof global.map !== 'undefined' && global.map && typeof global.map.eachLayer === 'function') {
            global.map.eachLayer(layer => {
                // Skip if it's a tile layer, marker, or other non-geoJSON layer
                if (!layer.feature || !layer.feature.properties) return;
                // Skip if already in layersToRemove
                if (layersToRemove.includes(layer)) return;
                // Skip if it's part of parcelLayer (already checked above)
                if (global.parcelLayer && global.parcelLayer.hasLayer(layer)) return;

                const candidate = getLayerParcelId(layer);
                if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                    layersToRemove.push(layer);
                    if (isDebugParcel) {
                        console.log(`[removeParcelLayerById] DEBUG: Found layer directly on map (not in parcelLayer) for ${normalizedId}`, {
                            layer,
                            onMap: global.map.hasLayer(layer)
                        });
                    }
                }
            });
        }

        if (layersToRemove.length === 0) {
            // No layers found - this is fine, it's an idempotent operation
            if (isDebugParcel) {
                console.log(`[removeParcelLayerById] DEBUG: No layers found to remove for ${normalizedId}`);
            }
            return;
        }


        layersToRemove.forEach(layer => {
            unindexParcelLayer(layer);
            deleteParcelLayerById(normalizedId);
            // Remove from parcelLayer if it's there
            if (global.parcelLayer && global.parcelLayer.hasLayer(layer)) {
                if (isDebugParcel) console.log(`[removeParcelLayerById] DEBUG: Removing from parcelLayer for ${normalizedId}`);
                global.parcelLayer.removeLayer(layer);
            }
            // Explicitly remove from map if it's directly on the map
            try {
                if (typeof global.map !== 'undefined' && global.map) {
                    if (global.map.hasLayer(layer)) {
                        if (isDebugParcel) console.log(`[removeParcelLayerById] DEBUG: Removing from map directly for ${normalizedId}`);
                        global.map.removeLayer(layer);
                    }
                    // Also call layer.remove() to ensure it's fully removed from DOM
                    if (typeof layer.remove === 'function') {
                        layer.remove();
                    }
                }
            } catch (err) {
                console.warn(`[removeParcelLayerById] Error removing layer from map:`, err);
            }
        });

        if (isDebugParcel) {
            // Verify removal
            const stillExists = global.resolveParcelLayerById ? global.resolveParcelLayerById(normalizedId) : null;
            console.log(`[removeParcelLayerById] DEBUG: After removal, parcel ${normalizedId} still exists:`, !!stillExists);
        }
    }

    /**
     * Fast bulk removal using the id->layer map only; skips parcelLayer and map scans.
     * @param {Iterable<string|number>} parcelIds
     * @returns {number} number of layers removed
     */
    function fastRemoveParcelLayersByIds(parcelIds) {
        const mapById = global.parcelLayerById instanceof Map ? global.parcelLayerById : null;
        if (!mapById || !parcelIds) return 0;
        let removed = 0;
        for (const id of parcelIds) {
            const normalizedId = id !== undefined && id !== null ? id.toString() : null;
            if (!normalizedId) continue;
            const layer = mapById.get(normalizedId);
            if (!layer) continue;

            // Remove from parcelLayer
            if (global.parcelLayer && typeof global.parcelLayer.removeLayer === 'function') {
                if (global.parcelLayer.hasLayer(layer)) {
                    global.parcelLayer.removeLayer(layer);
                }
            }

            // Unindex and delete mapping
            if (typeof unindexParcelLayer === 'function') {
                unindexParcelLayer(layer);
            }
            mapById.delete(normalizedId);
            removed++;
        }
        return removed;
    }

    function ensureParcelLayerInitialized() {
        if (!global.parcelLayer) {
            global.parcelLayer = L.featureGroup();
            // NOTE: Do NOT automatically add parcelLayer to map here.
            // Adding parcels to the map should be controlled by zoom level checks.
            // The parcel layer will be added to the map by:
            // - addParcelLayerToMapIfAppropriate() - respects zoom level
            // - zoomend/moveend handlers in map-core.js - respects zoom level
            // - showAllParcels() in visibility.js - respects zoom level
        }
        // NOTE: Do NOT add parcelLayer to map if it's not already there.
        // This function should only initialize the layer group, not control visibility.
        // Visibility is managed by zoom-aware functions.
    }

    /**
     * Add parcel layer to map only if zoom is within the allowed range.
     * This is the ONLY function that should be used to add parcelLayer to the map
     * from general code paths (excluding explicit user actions like checkbox toggle).
     * @returns {boolean} true if the layer was added, false otherwise
     */
    function addParcelLayerToMapIfAppropriate() {
        if (!global.parcelLayer || !global.map) {
            return false;
        }

        // Check if zoom is within parcel display range
        const isZoomWithinRange = (typeof global.isZoomWithinParcelRange === 'function')
            ? global.isZoomWithinParcelRange()
            : true; // Default to true if function not available (backwards compatibility)

        if (!isZoomWithinRange) {
            // Zoom is out of range - ensure parcel layer is NOT on map
            if (global.map.hasLayer(global.parcelLayer)) {
                try { global.map.removeLayer(global.parcelLayer); } catch (_) { }
            }
            return false;
        }

        // Zoom is appropriate - add parcel layer if not already there
        if (!global.map.hasLayer(global.parcelLayer)) {
            try {
                global.parcelLayer.addTo(global.map);
                return true;
            } catch (_) {
                return false;
            }
        }
        return true; // Already on map
    }

    // Expose globally for legacy callers
    global.getGridKey = getGridKey;
    global.getRequiredGridCells = getRequiredGridCells;
    global.computeGridKeysForBounds = computeGridKeysForBounds;
    global.indexParcelLayer = indexParcelLayer;
    global.unindexParcelLayer = unindexParcelLayer;
    global.clearParcelLayerIndex = clearParcelLayerIndex;
    global.getParcelLayersWithinBounds = getParcelLayersWithinBounds;
    global.resolveParcelLayerById = resolveParcelLayerById;
    global.fastRemoveParcelLayersByIds = fastRemoveParcelLayersByIds;
    // Debug function to check for duplicate parcels
    function debugParcelCount(parcelId) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) return { error: 'Invalid parcel ID' };

        const inParcelLayer = [];
        const onMapDirectly = [];
        const domPaths = [];

        if (global.parcelLayer && typeof global.parcelLayer.eachLayer === 'function') {
            global.parcelLayer.eachLayer(layer => {
                const candidate = getLayerParcelId(layer);
                if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                    const pathElement = layer._path;
                    const pathD = pathElement ? pathElement.getAttribute('d') : null;
                    inParcelLayer.push({
                        layer,
                        inParcelLayer: true,
                        onMap: global.map && global.map.hasLayer(layer),
                        hasPath: !!pathElement,
                        pathD: pathD ? pathD.substring(0, 50) + '...' : null
                    });

                    if (pathElement) {
                        domPaths.push({
                            element: pathElement,
                            d: pathD,
                            parent: pathElement.parentElement,
                            style: window.getComputedStyle(pathElement).fill
                        });
                    }
                }
            });
        }

        if (typeof global.map !== 'undefined' && global.map && typeof global.map.eachLayer === 'function') {
            global.map.eachLayer(layer => {
                if (!layer.feature || !layer.feature.properties) return;
                if (global.parcelLayer && global.parcelLayer.hasLayer(layer)) return; // Already counted

                const candidate = getLayerParcelId(layer);
                if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                    const pathElement = layer._path;
                    onMapDirectly.push({
                        layer,
                        inParcelLayer: false,
                        onMap: true,
                        hasPath: !!pathElement
                    });
                }
            });
        }

        // Check for duplicate path elements in DOM with same 'd' attribute
        const pathDElements = new Map();
        domPaths.forEach(({ d, element }) => {
            if (d) {
                if (!pathDElements.has(d)) {
                    pathDElements.set(d, []);
                }
                pathDElements.get(d).push(element);
            }
        });
        const duplicatePaths = Array.from(pathDElements.entries()).filter(([d, elements]) => elements.length > 1);

        return {
            parcelId: normalizedId,
            inParcelLayer: inParcelLayer.length,
            onMapDirectly: onMapDirectly.length,
            total: inParcelLayer.length + onMapDirectly.length,
            duplicatePathsInDOM: duplicatePaths.length,
            parcelLayerOnMap: global.map && global.map.hasLayer(global.parcelLayer),
            details: {
                inParcelLayer,
                onMapDirectly,
                duplicatePaths: duplicatePaths.map(([d, elements]) => ({
                    pathD: d.substring(0, 50) + '...',
                    count: elements.length,
                    elements: elements.map(el => ({
                        parent: el.parentElement?.tagName,
                        style: window.getComputedStyle(el).fill
                    }))
                }))
            }
        };
    }


    /**
     * Enable monkey-patch on parcelLayer.addLayer to trace ALL additions.
     * Call from console: window.enableParcelLayerAddTrace()
     */
    function enableParcelLayerAddTrace() {
        if (!global.parcelLayer) {
            console.error('[enableParcelLayerAddTrace] parcelLayer not available yet');
            return false;
        }

        if (global.parcelLayer._originalAddLayer) {
            console.log('[enableParcelLayerAddTrace] Already enabled');
            return true;
        }

        const original = global.parcelLayer.addLayer.bind(global.parcelLayer);
        global.parcelLayer._originalAddLayer = original;
        global.parcelLayer._addLayerCalls = [];

        global.parcelLayer.addLayer = function (layer) {
            const parcelId = getLayerParcelId(layer)?.toString();
            const DEBUG_ID = '40833596';

            const callInfo = {
                parcelId,
                layerId: layer._leaflet_id,
                timestamp: new Date().toISOString(),
                stack: new Error().stack.split('\n').slice(1, 8).join('\n')
            };
            global.parcelLayer._addLayerCalls.push(callInfo);

            if (parcelId === DEBUG_ID) {
                const existingCalls = global.parcelLayer._addLayerCalls.filter(c => c.parcelId === DEBUG_ID);
                console.error(`🚨 [parcelLayer.addLayer] Adding parcel ${DEBUG_ID} (call #${existingCalls.length})`, callInfo);
            }

            return original(layer);
        };

        console.log('[enableParcelLayerAddTrace] Enabled - all addLayer calls will be logged for parcel 40833596');
        return true;
    }

    /**
     * Get all addLayer calls for a specific parcel.
     * Call from console: window.getAddLayerCalls('40833596')
     */
    function getAddLayerCalls(parcelId) {
        if (!global.parcelLayer || !global.parcelLayer._addLayerCalls) {
            console.error('[getAddLayerCalls] Trace not enabled. Call window.enableParcelLayerAddTrace() first');
            return null;
        }

        const calls = global.parcelLayer._addLayerCalls.filter(c => c.parcelId === parcelId);
        console.log(`[getAddLayerCalls] Found ${calls.length} addLayer calls for parcel ${parcelId}:`, calls);
        return calls;
    }

    /**
     * Inspect ALL layers on the map to find where a parcel might be rendered.
     * Call from console: window.findParcelEverywhere('40833596')
     */
    function findParcelEverywhere(parcelId) {
        const normalizedId = parcelId?.toString();
        if (!normalizedId) {
            console.error('Please provide a parcel ID');
            return null;
        }

        const results = {
            parcelId: normalizedId,
            inParcelLayer: [],
            inOtherLayerGroups: [],
            directlyOnMap: [],
            allMapLayers: [],
            svgPathsWithParcelId: []
        };

        // Check parcelLayer
        if (global.parcelLayer && typeof global.parcelLayer.eachLayer === 'function') {
            global.parcelLayer.eachLayer(layer => {
                const id = getLayerParcelId(layer)?.toString();
                if (id === normalizedId) {
                    results.inParcelLayer.push({
                        layerId: layer._leaflet_id,
                        hasPath: !!layer._path,
                        pathId: layer._path?.id,
                        bounds: layer.getBounds ? layer.getBounds() : null
                    });
                }
            });
        }

        // Check all layers directly on the map
        if (global.map && typeof global.map.eachLayer === 'function') {
            global.map.eachLayer(layer => {
                const layerInfo = {
                    layerId: layer._leaflet_id,
                    type: layer.constructor?.name || 'unknown',
                    isParcelLayer: layer === global.parcelLayer,
                    hasLayers: typeof layer.getLayers === 'function'
                };
                results.allMapLayers.push(layerInfo);

                // Check if it's a layer group containing our parcel
                if (typeof layer.eachLayer === 'function' && layer !== global.parcelLayer) {
                    layer.eachLayer(subLayer => {
                        const id = getLayerParcelId(subLayer)?.toString();
                        if (id === normalizedId) {
                            results.inOtherLayerGroups.push({
                                parentLayerId: layer._leaflet_id,
                                parentType: layer.constructor?.name,
                                layerId: subLayer._leaflet_id,
                                hasPath: !!subLayer._path
                            });
                        }
                    });
                }

                // Check if it's the parcel directly
                const id = getLayerParcelId(layer)?.toString();
                if (id === normalizedId && layer !== global.parcelLayer) {
                    results.directlyOnMap.push({
                        layerId: layer._leaflet_id,
                        hasPath: !!layer._path,
                        inParcelLayer: global.parcelLayer && global.parcelLayer.hasLayer(layer)
                    });
                }
            });
        }

        // Check SVG paths in the DOM
        const allPaths = document.querySelectorAll('svg path');
        allPaths.forEach(path => {
            // Check if this path belongs to a layer with our parcel ID
            // We can check by looking at the data-parcel-id attribute if it exists
            // or by matching the path's d attribute
            const pathD = path.getAttribute('d');
            if (pathD) {
                // Check all layers to see if any match this path
                if (global.parcelLayer) {
                    global.parcelLayer.eachLayer(layer => {
                        const id = getLayerParcelId(layer)?.toString();
                        if (id === normalizedId && layer._path === path) {
                            results.svgPathsWithParcelId.push({
                                pathElement: path,
                                pathD: pathD.substring(0, 50) + '...',
                                layerId: layer._leaflet_id
                            });
                        }
                    });
                }
            }
        });

        console.log(`🔍 [findParcelEverywhere] Results for parcel ${normalizedId}:`, results);
        console.log(`   In parcelLayer: ${results.inParcelLayer.length}`);
        console.log(`   In other layer groups: ${results.inOtherLayerGroups.length}`);
        console.log(`   Directly on map: ${results.directlyOnMap.length}`);
        console.log(`   Total layers on map: ${results.allMapLayers.length}`);

        if (results.inOtherLayerGroups.length > 0) {
            console.error(`🚨 FOUND PARCEL IN OTHER LAYER GROUPS:`, results.inOtherLayerGroups);
        }
        if (results.directlyOnMap.length > 0) {
            console.error(`🚨 FOUND PARCEL DIRECTLY ON MAP:`, results.directlyOnMap);
        }

        return results;
    }


    /**
     * Analyze MultiPolygon parcels to see how they're being handled.
     * Call from console: window.analyzeMultiPolygonParcels()
     */
    function analyzeMultiPolygonParcels() {
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            console.error('[analyzeMultiPolygonParcels] parcelLayer not available');
            return null;
        }

        const results = {
            totalParcels: 0,
            polygonCount: 0,
            multiPolygonCount: 0,
            multiPolygonParcels: [],
            invalidGeometries: [],
            multiPolygonDetails: []
        };

        global.parcelLayer.eachLayer(layer => {
            results.totalParcels++;
            const feature = layer?.feature;
            if (!feature || !feature.geometry) {
                results.invalidGeometries.push({
                    parcelId: getFeatureParcelId(feature),
                    reason: 'No geometry'
                });
                return;
            }

            const geomType = feature.geometry.type;
            const parcelId = getFeatureParcelId(feature)?.toString();

            if (geomType === 'Polygon') {
                results.polygonCount++;
            } else if (geomType === 'MultiPolygon') {
                results.multiPolygonCount++;
                const coords = feature.geometry.coordinates;

                const detail = {
                    parcelId,
                    polygonCount: Array.isArray(coords) ? coords.length : 0,
                    coordinates: coords,
                    layerId: layer._leaflet_id,
                    hasPath: !!layer._path,
                    pathD: layer._path ? layer._path.getAttribute('d')?.substring(0, 100) : null,
                    bounds: layer.getBounds ? layer.getBounds() : null
                };

                // Validate MultiPolygon structure
                if (!Array.isArray(coords) || coords.length === 0) {
                    detail.valid = false;
                    detail.error = 'Invalid MultiPolygon coordinates structure';
                    results.invalidGeometries.push(detail);
                } else {
                    detail.valid = true;
                    // Count rings in each polygon
                    detail.ringsPerPolygon = coords.map((poly, idx) => {
                        if (!Array.isArray(poly) || poly.length === 0) {
                            return { polygonIndex: idx, ringCount: 0, valid: false };
                        }
                        return {
                            polygonIndex: idx,
                            ringCount: poly.length,
                            exteriorRingLength: Array.isArray(poly[0]) ? poly[0].length : 0,
                            valid: Array.isArray(poly[0]) && poly[0].length >= 3
                        };
                    });
                }

                results.multiPolygonParcels.push(parcelId);
                results.multiPolygonDetails.push(detail);
            } else {
                results.invalidGeometries.push({
                    parcelId,
                    reason: `Unexpected geometry type: ${geomType}`
                });
            }
        });

        console.log('📊 [analyzeMultiPolygonParcels] Results:');
        console.log(`   Total parcels: ${results.totalParcels}`);
        console.log(`   Polygon: ${results.polygonCount}`);
        console.log(`   MultiPolygon: ${results.multiPolygonCount}`);
        console.log(`   Invalid geometries: ${results.invalidGeometries.length}`);

        if (results.multiPolygonCount > 0) {
            console.log('\n🔍 MultiPolygon parcels:', results.multiPolygonParcels.slice(0, 20));
            console.log('\n📋 MultiPolygon details (first 5):');
            results.multiPolygonDetails.slice(0, 5).forEach(detail => {
                console.log(`   Parcel ${detail.parcelId}:`, {
                    polygonCount: detail.polygonCount,
                    ringsPerPolygon: detail.ringsPerPolygon,
                    valid: detail.valid,
                    hasPath: detail.hasPath
                });
            });
        }

        if (results.invalidGeometries.length > 0) {
            console.error('\n❌ Invalid geometries:', results.invalidGeometries.slice(0, 10));
        }

        return results;
    }

    /**
     * Get detailed info about a specific MultiPolygon parcel.
     * Call from console: window.getMultiPolygonDetails('40833596')
     */
    function getMultiPolygonDetails(parcelId) {
        const normalizedId = parcelId?.toString();
        if (!normalizedId) {
            console.error('Please provide a parcel ID');
            return null;
        }

        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            console.error('[getMultiPolygonDetails] parcelLayer not available');
            return null;
        }

        let foundLayer = null;
        global.parcelLayer.eachLayer(layer => {
            const id = getLayerParcelId(layer)?.toString();
            if (id === normalizedId) {
                foundLayer = layer;
            }
        });

        if (!foundLayer) {
            console.error(`[getMultiPolygonDetails] Parcel ${normalizedId} not found in parcelLayer`);
            return null;
        }

        const feature = foundLayer.feature;
        const geometry = feature?.geometry;
        const coords = geometry?.coordinates;

        const details = {
            parcelId: normalizedId,
            geometryType: geometry?.type,
            layerId: foundLayer._leaflet_id,
            hasPath: !!foundLayer._path,
            pathD: foundLayer._path ? foundLayer._path.getAttribute('d') : null,
            bounds: foundLayer.getBounds ? foundLayer.getBounds() : null,
            coordinates: coords,
            polygonCount: Array.isArray(coords) ? coords.length : 0,
            polygons: []
        };

        if (geometry?.type === 'MultiPolygon' && Array.isArray(coords)) {
            coords.forEach((polygon, polyIdx) => {
                const polyDetail = {
                    polygonIndex: polyIdx,
                    ringCount: Array.isArray(polygon) ? polygon.length : 0,
                    rings: []
                };

                if (Array.isArray(polygon)) {
                    polygon.forEach((ring, ringIdx) => {
                        polyDetail.rings.push({
                            ringIndex: ringIdx,
                            coordinateCount: Array.isArray(ring) ? ring.length : 0,
                            firstCoordinate: Array.isArray(ring) && ring.length > 0 ? ring[0] : null,
                            lastCoordinate: Array.isArray(ring) && ring.length > 0 ? ring[ring.length - 1] : null,
                            isClosed: Array.isArray(ring) && ring.length > 0 &&
                                ring[0][0] === ring[ring.length - 1][0] &&
                                ring[0][1] === ring[ring.length - 1][1]
                        });
                    });
                }

                details.polygons.push(polyDetail);
            });
        }

        // Also check the actual coordinates to see if conversion failed
        if (geometry?.type === 'MultiPolygon' && Array.isArray(coords)) {
            const firstPolygon = coords[0];
            const firstRing = Array.isArray(firstPolygon) ? firstPolygon[0] : null;
            const firstCoord = Array.isArray(firstRing) && firstRing.length > 0 ? firstRing[0] : null;

            details.coordinateAnalysis = {
                firstCoordinate: firstCoord,
                looksLikeWGS84: firstCoord && Math.abs(firstCoord[0]) <= 180 && Math.abs(firstCoord[1]) <= 90,
                looksLikeHTRS96: firstCoord && (Math.abs(firstCoord[0]) > 1000 || Math.abs(firstCoord[1]) > 1000),
                allZero: firstCoord && firstCoord[0] === 0 && firstCoord[1] === 0
            };
        }

        console.log(`🔍 [getMultiPolygonDetails] Parcel ${normalizedId}:`, details);

        if (details.pathD === 'M0 0' || details.pathD === 'M 0 0') {
            console.error(`❌ [getMultiPolygonDetails] Parcel ${normalizedId} has invalid path (M0 0) - coordinate conversion likely failed!`);
            console.error('   First coordinate:', details.coordinateAnalysis?.firstCoordinate);
            console.error('   Looks like WGS84:', details.coordinateAnalysis?.looksLikeWGS84);
            console.error('   Looks like HTRS96:', details.coordinateAnalysis?.looksLikeHTRS96);
        }

        return details;
    }

    /**
     * Check if a parcel is visible on the map by searching for it.
     * Can search by parcelId.
     * Call from console: window.checkParcelVisibility('21606957') or window.checkParcelVisibility('1812', 'BROJ_CESTICE')
     */
    function checkParcelVisibility(searchValue, searchProperty = 'parcelId') {
        if (!global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            console.error('[checkParcelVisibility] parcelLayer not available');
            return null;
        }

        let foundLayers = [];
        global.parcelLayer.eachLayer(layer => {
            const props = layer?.feature?.properties;
            if (!props) return;

            const value = (searchProperty === 'parcelId')
                ? getFeatureParcelId(layer.feature)?.toString()
                : props[searchProperty]?.toString();
            if (value === searchValue?.toString()) {
                const pathD = layer._path ? layer._path.getAttribute('d') : null;
                const bounds = layer.getBounds ? layer.getBounds() : null;
                const isVisible = global.map && global.map.hasLayer(layer);
                const isInViewport = bounds && global.map ? global.map.getBounds().intersects(bounds) : false;

                foundLayers.push({
                    layer,
                    layerId: layer._leaflet_id,
                    parcelId: getFeatureParcelId(layer.feature),
                    brojCestice: props.BROJ_CESTICE,
                    hasPath: !!layer._path,
                    pathD: pathD ? (pathD.length > 100 ? pathD.substring(0, 100) + '...' : pathD) : null,
                    pathDLength: pathD ? pathD.length : 0,
                    bounds: bounds,
                    isVisible: isVisible,
                    isInViewport: isInViewport,
                    geometryType: layer.feature?.geometry?.type
                });
            }
        });

        if (foundLayers.length === 0) {
            console.log(`❌ [checkParcelVisibility] No parcel found with ${searchProperty}="${searchValue}"`);
            return null;
        }

        console.log(`✅ [checkParcelVisibility] Found ${foundLayers.length} parcel(s) with ${searchProperty}="${searchValue}":`, foundLayers);

        // If found, try to zoom to it
        if (foundLayers.length > 0 && global.map && foundLayers[0].bounds) {
            try {
                global.map.fitBounds(foundLayers[0].bounds, { padding: [50, 50] });
                console.log(`📍 [checkParcelVisibility] Zoomed to parcel bounds`);
            } catch (e) {
                console.warn(`[checkParcelVisibility] Error zooming to parcel:`, e);
            }
        }

        return foundLayers;
    }

    global.removeParcelLayerById = removeParcelLayerById;
    global.getParcelLayerIdMap = getParcelLayerIdMap;
    global.setParcelLayerById = setParcelLayerById;
    global.deleteParcelLayerById = deleteParcelLayerById;
    global.ensureParcelLayerInitialized = ensureParcelLayerInitialized;
    global.addParcelLayerToMapIfAppropriate = addParcelLayerToMapIfAppropriate;
    global.debugParcelCount = debugParcelCount;
    global.enableParcelLayerAddTrace = enableParcelLayerAddTrace;
    global.getAddLayerCalls = getAddLayerCalls;
    global.findParcelEverywhere = findParcelEverywhere;
    global.analyzeMultiPolygonParcels = analyzeMultiPolygonParcels;
    global.getMultiPolygonDetails = getMultiPolygonDetails;
    global.checkParcelVisibility = checkParcelVisibility;
})(typeof window !== 'undefined' ? window : globalThis);

