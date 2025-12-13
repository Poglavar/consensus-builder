(function (global) {
    'use strict';

    const getCache = () => (global.ParcelsState && global.ParcelsState.getParcelCache)
        ? global.ParcelsState.getParcelCache()
        : global.parcelCache;

    const getLayerIndex = () => (global.ParcelsState && global.ParcelsState.getParcelLayerIndex)
        ? global.ParcelsState.getParcelLayerIndex()
        : global.parcelLayerIndex;

    const bumpLayerIndexVersion = () => (global.ParcelsState && global.ParcelsState.bumpParcelLayerIndexVersion)
        ? global.ParcelsState.bumpParcelLayerIndexVersion()
        : (function () {
            global.parcelLayerIndexVersion = (global.parcelLayerIndexVersion || 0) + 1;
            return global.parcelLayerIndexVersion;
        })();

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

    function resolveParcelLayerById(parcelId) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) return null;
        const layerRef = global.parcelLayer;
        if (!layerRef || typeof layerRef.eachLayer !== 'function') return null;
        let resolved = null;
        layerRef.eachLayer(layer => {
            const candidate = layer?.feature?.properties?.CESTICA_ID;
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                resolved = layer;
            }
        });
        return resolved;
    }

    function removeParcelLayerById(parcelId) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId || !global.parcelLayer || typeof global.parcelLayer.eachLayer !== 'function') {
            console.warn(`[removeParcelLayerById] Invalid input or parcelLayer not available: parcelId=${parcelId}, normalizedId=${normalizedId}`);
            return;
        }
        const layersToRemove = [];
        global.parcelLayer.eachLayer(layer => {
            const candidate = layer?.feature?.properties?.CESTICA_ID;
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalizedId) {
                layersToRemove.push(layer);
            }
        });
        
        if (layersToRemove.length === 0) {
            // No layers found - this is fine, it's an idempotent operation
            // Parcels may not exist on the map yet (e.g., on initial load)
            return;
        }
        
        console.log(`[removeParcelLayerById] Removing ${layersToRemove.length} layer(s) for parcel ID: ${normalizedId}`);
        
        layersToRemove.forEach(layer => {
            unindexParcelLayer(layer);
            // Remove from parcelLayer first
            global.parcelLayer.removeLayer(layer);
            // Explicitly remove from map if it's directly on the map
            try {
                if (typeof global.map !== 'undefined' && global.map) {
                    if (global.map.hasLayer(layer)) {
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

        console.log(`[removeParcelLayerById] Successfully removed ${layersToRemove.length} layer(s) for parcel ID: ${normalizedId}`);
    }

    function ensureParcelLayerInitialized() {
        if (!global.parcelLayer) {
            global.parcelLayer = L.featureGroup();
            if (typeof global.map !== 'undefined' && global.map) {
                global.parcelLayer.addTo(global.map);
            }
        }
    }

    // Expose globally for legacy callers
    global.getGridKey = getGridKey;
    global.getRequiredGridCells = getRequiredGridCells;
    global.computeGridKeysForBounds = computeGridKeysForBounds;
    global.indexParcelLayer = indexParcelLayer;
    global.unindexParcelLayer = unindexParcelLayer;
    global.clearParcelLayerIndex = clearParcelLayerIndex;
    global.resolveParcelLayerById = resolveParcelLayerById;
    global.removeParcelLayerById = removeParcelLayerById;
    global.ensureParcelLayerInitialized = ensureParcelLayerInitialized;
})(typeof window !== 'undefined' ? window : globalThis);

