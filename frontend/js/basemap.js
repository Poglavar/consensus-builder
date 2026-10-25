(function (global) {
    'use strict';

    var MAPTILER_API_KEY = 'kps68PDVgfwEhLNACcHe';
    var BASEMAP_STORAGE_KEY = 'cb_base_map';
    var BASEMAPS = {
        openstreetmap: global.BrowserSources.basemap('openstreetmap'),
        maptiler: global.BrowserSources.basemap('maptiler', { apiKey: MAPTILER_API_KEY })
    };

    var tileErrorTracker = {
        totalErrors: 0,
        lastErrorTime: null,
        errors: []
    };

    var currentBaseMapKey = null;
    var baseTileLayer = null;

    function imageryChoice() {
        var city = global.CityConfigManager?.getCurrentCityId?.();
        return city ? global.ParcelSourceSettings?.choiceForCity(city, global, 'imagery') : null;
    }

    function getStoredBasemapKey() {
        if (imageryChoice()) return 'imagery';
        try {
            if (typeof global.PersistentStorage !== 'undefined' && global.PersistentStorage && typeof global.PersistentStorage.getItem === 'function') {
                var stored = global.PersistentStorage.getItem(BASEMAP_STORAGE_KEY);
                if (stored && BASEMAPS[stored]) {
                    return stored;
                }
            }
        } catch (_) { }
        return 'openstreetmap';
    }

    function storeBasemapKey(key) {
        if (!BASEMAPS[key]) return;
        try {
            if (typeof global.PersistentStorage !== 'undefined' && global.PersistentStorage && typeof global.PersistentStorage.setItem === 'function') {
                global.PersistentStorage.setItem(BASEMAP_STORAGE_KEY, key);
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
        var source = key === 'imagery' ? imageryChoice() : null;
        var config = BASEMAPS[key] || BASEMAPS.openstreetmap;
        var layer;
        if (source) {
            var options = { maxZoom: 22, maxNativeZoom: source.maxZoom ?? 22, minZoom: source.minZoom ?? 0,
                attribution: global.ImagerySource.escapeAttribution(source.attribution || source.name) };
            if (source.bounds) options.bounds = [[source.bounds[1], source.bounds[0]], [source.bounds[3], source.bounds[2]]];
            var base = String(global.getBackendBase()).replace(/\/+$/, '');
            layer = L.tileLayer('', options);
            layer.getTileUrl = function (coords) { return global.ImagerySource.tileUrl(base, source, coords); };
            var failed = false;
            layer.on('tileload', function () { if (!failed) global.ParcelSourceSettings.clearFailure(global, 'imagery'); });
            layer.on('tileerror', function () {
                failed = true;
                var key = 'imagerySources.unavailable', translated = global.i18n?.t?.(key);
                global.ParcelSourceSettings.reportFailure(global, translated && translated !== key ? translated : 'Imagery could not be loaded. Retry or choose another source.',
                    'imagery', function () { currentBaseMapKey = null; applyBasemap(global.map, 'imagery'); });
            });
        } else layer = L.tileLayer(config.url, config.options);

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
        var targetKey = key === 'imagery' && imageryChoice() ? 'imagery' : BASEMAPS[key] ? key : 'openstreetmap';
        if (currentBaseMapKey === targetKey && baseTileLayer && map.hasLayer(baseTileLayer)) {
            return baseTileLayer;
        }
        if (baseTileLayer) {
            try {
                baseTileLayer.off();
                map.removeLayer(baseTileLayer);
            } catch (_) { }
        }

        tileErrorTracker.totalErrors = 0;
        tileErrorTracker.errors = [];

        global.ParcelSourceSettings?.clearFailure(global, 'imagery');
        baseTileLayer = buildBasemapLayer(targetKey);
        baseTileLayer.addTo(map);
        currentBaseMapKey = targetKey;
        storeBasemapKey(targetKey);
        syncBasemapSelector(targetKey);
        try { global.baseTileLayer = baseTileLayer; } catch (_) { }
        map.fire('basemapchange', { key: targetKey });
        return baseTileLayer;
    }

    function initBasemapSelector(map) {
        try {
            var select = document.getElementById('tile-source-select');
            if (!select) return;
            var source = imageryChoice();
            if (source) {
                var option = document.createElement('option'); option.value = 'imagery'; option.textContent = source.name; select.append(option);
            }
            var initialKey = getStoredBasemapKey();
            if (BASEMAPS[initialKey] || initialKey === 'imagery') {
                select.value = initialKey;
            }
            select.addEventListener('change', function () {
                if (select.value !== 'imagery') {
                    var city = global.CityConfigManager?.getCurrentCityId?.();
                    try { (global.BrowserWorkspace?.storage || global.localStorage).removeItem(global.ParcelSourceSettings.storageKey(city, global, 'imagery')); } catch (_) {}
                    var url = new URL(global.location.href); url.searchParams.delete('imagerySource'); global.history.replaceState(null, '', url.href);
                    select.querySelector('option[value="imagery"]')?.remove();
                }
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
        // A small, user-requested crop for the non-commercial illustrative boundary estimator.
        satelliteTileUrl: function (tile) {
            return 'https://api.maptiler.com/tiles/satellite-v2/' + tile.z + '/' + tile.x + '/' + tile.y + '.jpg?key=' + MAPTILER_API_KEY;
        },
        applyBasemap: applyBasemap,
        initBasemapSelector: initBasemapSelector,
        getTileLoadingStats: getTileLoadingStats,
        getStoredBasemapKey: getStoredBasemapKey,
        getCurrentBasemapKey: function () { return currentBaseMapKey; },
        getCurrentSource: function () { return currentBaseMapKey === 'imagery' ? imageryChoice() : null; },
        getCurrentAttribution: function () { return baseTileLayer?.options?.attribution || ''; },
        // 256px raster for thumbnail stitching (map-screenshot.js assumes 256px tiles).
        THUMBNAIL_TILE_URL: 'https://api.maptiler.com/maps/basic-v2/256/{z}/{x}/{y}.png?key=' + MAPTILER_API_KEY
    };
})(typeof window !== 'undefined' ? window : globalThis);
