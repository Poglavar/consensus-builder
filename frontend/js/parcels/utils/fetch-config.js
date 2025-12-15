(function (global) {
    'use strict';

    var DEFAULTS = {
        padding: 0.12,
        debounceMs: 500,
        gridRadius: 0,
        zoomRange: { min: 17, max: Infinity }
    };

    function coerceNumber(value, fallback) {
        var num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function readFromParcelsState(fnName) {
        try {
            var state = global.ParcelsState;
            if (state && typeof state[fnName] === 'function') {
                return state[fnName]();
            }
        } catch (_) { /* ignore */ }
        return undefined;
    }

    function getPadding() {
        var fromState = readFromParcelsState('getParcelFetchPadding');
        if (fromState !== undefined) return coerceNumber(fromState, DEFAULTS.padding);

        if (global.PARCEL_FETCH_LATLNG_PADDING !== undefined) {
            return coerceNumber(global.PARCEL_FETCH_LATLNG_PADDING, DEFAULTS.padding);
        }
        return DEFAULTS.padding;
    }

    function getDebounce() {
        var fromState = readFromParcelsState('getParcelFetchDebounce');
        if (fromState !== undefined) return coerceNumber(fromState, DEFAULTS.debounceMs);

        if (global.PARCEL_FETCH_DEBOUNCE_MS !== undefined) {
            return coerceNumber(global.PARCEL_FETCH_DEBOUNCE_MS, DEFAULTS.debounceMs);
        }
        return DEFAULTS.debounceMs;
    }

    function getGridRadius() {
        var fromState = readFromParcelsState('getParcelFetchGridRadius');
        if (fromState !== undefined) return coerceNumber(fromState, DEFAULTS.gridRadius);

        if (global.PARCEL_FETCH_GRID_RADIUS !== undefined) {
            return coerceNumber(global.PARCEL_FETCH_GRID_RADIUS, DEFAULTS.gridRadius);
        }
        return DEFAULTS.gridRadius;
    }

    function getZoomRange() {
        var fromState = readFromParcelsState('getParcelFetchZoomRange');
        var range = (fromState && typeof fromState === 'object') ? fromState : global.GLOBAL_PARCEL_ZOOM_RANGE;
        var min = coerceNumber(range && range.min, DEFAULTS.zoomRange.min);
        var max = Number.isFinite(range && range.max) ? range.max : DEFAULTS.zoomRange.max;
        return { min: min, max: max };
    }

    var api = {
        getPadding: getPadding,
        getDebounce: getDebounce,
        getGridRadius: getGridRadius,
        getZoomRange: getZoomRange
    };

    global.ParcelFetchConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
