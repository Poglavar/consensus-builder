(function (global) {
    'use strict';

    var MAPTILER_API_KEY = 'kps68PDVgfwEhLNACcHe';
    var BASEMAP_STORAGE_KEY = 'cb_base_map';
    var MAPTILER_BASIC_RASTER_URL = 'https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png?key=' + MAPTILER_API_KEY;

    var BASEMAPS = {
        openstreetmap: {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }
        },
        maptiler: {
            url: MAPTILER_BASIC_RASTER_URL,
            options: {
                maxZoom: 22,
                tileSize: 512,
                zoomOffset: -1,
                attribution: '© MapTiler © OpenStreetMap contributors'
            }
        }
    };

    var tileErrorTracker = {
        totalErrors: 0,
        lastErrorTime: null,
        errors: []
    };

    var currentBaseMapKey = null;
    var baseTileLayer = null;

    function getStoredBasemapKey() {
        var candidates = [];
        try {
            if (typeof global.PersistentStorage !== 'undefined' && global.PersistentStorage && typeof global.PersistentStorage.getItem === 'function') {
                candidates.push(global.PersistentStorage.getItem(BASEMAP_STORAGE_KEY));
            }
        } catch (_) { }
        try {
            if (typeof global.localStorage !== 'undefined' && global.localStorage && typeof global.localStorage.getItem === 'function') {
                candidates.push(global.localStorage.getItem(BASEMAP_STORAGE_KEY));
            }
        } catch (_) { }
        var valid = candidates.find(function (value) { return value && BASEMAPS[value]; });
        return valid || 'openstreetmap';
    }

    function storeBasemapKey(key) {
        if (!BASEMAPS[key]) return;
        try {
            if (typeof global.PersistentStorage !== 'undefined' && global.PersistentStorage && typeof global.PersistentStorage.setItem === 'function') {
                global.PersistentStorage.setItem(BASEMAP_STORAGE_KEY, key);
            }
        } catch (_) { }
        try {
            if (typeof global.localStorage !== 'undefined' && global.localStorage && typeof global.localStorage.setItem === 'function') {
                global.localStorage.setItem(BASEMAP_STORAGE_KEY, key);
            }
        } catch (_) { }
    }

    function syncBasemapSelector(key) {
        try {
            var select = document.getElementById('tile-source-select');
            if (select && select.value !== key) {
                select.value = key;
            }
        } catch (_) { }
    }

    function buildBasemapLayer(key) {
        var config = BASEMAPS[key] || BASEMAPS.openstreetmap;
        var layer = L.tileLayer(config.url, config.options);

        layer.on('tileerror', function (error) {
            var tile = error.tile;
            if (!tile) return;

            var tileCoords = null;
            if (error.coords) {
                tileCoords = error.coords;
            } else if (layer._tiles) {
                for (var k in layer._tiles) {
                    var cachedTile = layer._tiles[k];
                    if (cachedTile.el && cachedTile.el.src === tile.src) {
                        tileCoords = cachedTile.coords;
                        break;
                    }
                }
            }

            tileErrorTracker.totalErrors++;
            tileErrorTracker.lastErrorTime = Date.now();

            var errorInfo = {
                timestamp: new Date().toISOString(),
                tileUrl: tile.src || 'unknown',
                coords: tileCoords ? { x: tileCoords.x, y: tileCoords.y, z: tileCoords.z } : null,
                basemap: key
            };

            tileErrorTracker.errors.push(errorInfo);
            if (tileErrorTracker.errors.length > 50) {
                tileErrorTracker.errors.shift();
            }

            console.error('[Map Tile Error]', {
                message: 'Tile failed to load',
                url: errorInfo.tileUrl,
                coordinates: errorInfo.coords,
                basemap: errorInfo.basemap,
                totalErrors: tileErrorTracker.totalErrors,
                error: error
            });
        });

        return layer;
    }

    function applyBasemap(map, key) {
        if (!map) return null;
        var targetKey = BASEMAPS[key] ? key : 'openstreetmap';
        if (currentBaseMapKey === targetKey && baseTileLayer && map.hasLayer(baseTileLayer)) {
            return baseTileLayer;
        }
        if (baseTileLayer) {
            try {
                baseTileLayer.off('tileerror');
                map.removeLayer(baseTileLayer);
            } catch (_) { }
        }

        tileErrorTracker.totalErrors = 0;
        tileErrorTracker.errors = [];

        baseTileLayer = buildBasemapLayer(targetKey);
        baseTileLayer.addTo(map);
        currentBaseMapKey = targetKey;
        storeBasemapKey(targetKey);
        syncBasemapSelector(targetKey);
        try { global.baseTileLayer = baseTileLayer; } catch (_) { }
        return baseTileLayer;
    }

    function initBasemapSelector(map) {
        try {
            var select = document.getElementById('tile-source-select');
            if (!select) return;
            var initialKey = getStoredBasemapKey();
            if (BASEMAPS[initialKey]) {
                select.value = initialKey;
            }
            select.addEventListener('change', function () {
                applyBasemap(map, select.value);
            });
        } catch (_) { }
    }

    function getTileLoadingStats() {
        return {
            totalErrors: tileErrorTracker.totalErrors,
            lastErrorTime: tileErrorTracker.lastErrorTime,
            recentErrors: tileErrorTracker.errors.slice(-10),
            hasRecentErrors: tileErrorTracker.lastErrorTime && (Date.now() - tileErrorTracker.lastErrorTime) < 60000
        };
    }

    global.BasemapManager = {
        BASEMAPS: BASEMAPS,
        applyBasemap: applyBasemap,
        initBasemapSelector: initBasemapSelector,
        getTileLoadingStats: getTileLoadingStats,
        getStoredBasemapKey: getStoredBasemapKey
    };
})(typeof window !== 'undefined' ? window : globalThis);
