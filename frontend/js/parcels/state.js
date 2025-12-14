(function (global) {
    'use strict';

    const ParcelCityConfigManager = global.CityConfigManager || null;

    function getCurrentCityId() {
        if (!ParcelCityConfigManager || typeof ParcelCityConfigManager.getCurrentCityId !== 'function') {
            return 'zagreb';
        }
        return ParcelCityConfigManager.getCurrentCityId();
    }

    let CURRENT_CITY_ID = getCurrentCityId();
    if (global && typeof global.addEventListener === 'function') {
        global.addEventListener('cityChanged', () => {
            CURRENT_CITY_ID = getCurrentCityId();
        });
    }

    const PARCELS_LATLNG_PADDING = ParcelCityConfigManager ? ParcelCityConfigManager.getLatLngPadding() : 0.12;
    const PARCELS_GRID_SIZE = ParcelCityConfigManager ? ParcelCityConfigManager.getParcelGridSize() : 500;

    // Core parcel state (kept as globals for backward compatibility)
    let parcelLayer = null;
    let selectedParcelId = null;
    let currentParcel = null;
    let currentParcelCoordinates = null;
    let currentParcelMintStatusCache = null;
    let currentParcelMintStatusPromise = null;
    let currentParcelMintStatusParcelId = null;
    let splitLayer = null;
    let parcelsTimeout;
    const PARCEL_FETCH_LATLNG_PADDING = PARCELS_LATLNG_PADDING;
    const PARCEL_FETCH_DEBOUNCE_MS = 500;
    const PARCEL_FETCH_GRID_RADIUS = 1;
    const parcelCache = {
        grid: new Map(),
        gridSize: PARCELS_GRID_SIZE
    };
    const parcelLayerIndex = new Map();
    let parcelLayerIndexVersion = 0;
    let isFetchingParcels = false;
    let parcelCoverageVersion = 0;
    let parcelMergeInProgress = false;

    const api = {
        getCityId: () => CURRENT_CITY_ID,
        setCityId: id => { CURRENT_CITY_ID = id; },
        getParcelLayer: () => parcelLayer,
        setParcelLayer: layer => {
            parcelLayer = layer;
            try { global.parcelLayer = layer; } catch (_) { /* noop */ }
        },
        getSelectedParcelId: () => selectedParcelId,
        setSelectedParcelId: id => {
            selectedParcelId = id;
            try { global.selectedParcelId = id; } catch (_) { /* noop */ }
        },
        getCurrentParcel: () => currentParcel,
        setCurrentParcel: value => {
            currentParcel = value;
            try { global.currentParcel = value; } catch (_) { /* noop */ }
        },
        getCurrentParcelCoordinates: () => currentParcelCoordinates,
        setCurrentParcelCoordinates: coords => { currentParcelCoordinates = coords; },
        getCurrentParcelMintStatusCache: () => currentParcelMintStatusCache,
        setCurrentParcelMintStatusCache: value => { currentParcelMintStatusCache = value; },
        getCurrentParcelMintStatusPromise: () => currentParcelMintStatusPromise,
        setCurrentParcelMintStatusPromise: value => { currentParcelMintStatusPromise = value; },
        getCurrentParcelMintStatusParcelId: () => currentParcelMintStatusParcelId,
        setCurrentParcelMintStatusParcelId: value => { currentParcelMintStatusParcelId = value; },
        getSplitLayer: () => splitLayer,
        setSplitLayer: value => { splitLayer = value; },
        getParcelsTimeout: () => parcelsTimeout,
        setParcelsTimeout: value => { parcelsTimeout = value; },
        getParcelFetchPadding: () => PARCEL_FETCH_LATLNG_PADDING,
        getParcelFetchDebounce: () => PARCEL_FETCH_DEBOUNCE_MS,
        getParcelFetchGridRadius: () => PARCEL_FETCH_GRID_RADIUS,
        getParcelCache: () => parcelCache,
        getParcelLayerIndex: () => parcelLayerIndex,
        bumpParcelLayerIndexVersion: () => {
            parcelLayerIndexVersion += 1;
            try { global.parcelLayerIndexVersion = parcelLayerIndexVersion; } catch (_) { /* noop */ }
            return parcelLayerIndexVersion;
        },
        getParcelLayerIndexVersion: () => parcelLayerIndexVersion,
        getParcelCoverageVersion: () => parcelCoverageVersion,
        bumpParcelCoverageVersion: () => {
            parcelCoverageVersion += 1;
            try { global.parcelCoverageVersion = parcelCoverageVersion; } catch (_) { /* noop */ }
            return parcelCoverageVersion;
        },
        isFetchingParcels: () => isFetchingParcels,
        setIsFetchingParcels: value => {
            const next = !!value;
            // Always dispatch event when state changes, even if setting to same value
            // This ensures the cursor updates reliably
            const wasFetching = isFetchingParcels;
            isFetchingParcels = next;
            if (wasFetching !== isFetchingParcels) {
                const eventName = isFetchingParcels ? 'parcelFetchStarted' : 'parcelFetchFinished';
                try {
                    global.dispatchEvent(new CustomEvent(eventName, {
                        detail: { timestamp: Date.now() }
                    }));
                } catch (_) { }
            }
        },
        isParcelMergeInProgress: () => parcelMergeInProgress,
        setParcelMergeInProgressState: inProgress => {
            const next = !!inProgress;
            if (parcelMergeInProgress === next) return;
            parcelMergeInProgress = next;
            try { global.parcelMergeInProgress = parcelMergeInProgress; } catch (_) { }
            const eventName = parcelMergeInProgress ? 'parcelMergeStarted' : 'parcelMergeFinished';
            try {
                global.dispatchEvent(new CustomEvent(eventName, {
                    detail: { timestamp: Date.now() }
                }));
            } catch (_) { }
        }
    };

    // Expose globals for legacy callers
    global.ParcelCityConfigManager = ParcelCityConfigManager;
    global.getCurrentCityId = getCurrentCityId;
    global.CURRENT_CITY_ID = CURRENT_CITY_ID;
    global.PARCELS_LATLNG_PADDING = PARCELS_LATLNG_PADDING;
    global.PARCELS_GRID_SIZE = PARCELS_GRID_SIZE;
    global.PARCEL_FETCH_LATLNG_PADDING = PARCEL_FETCH_LATLNG_PADDING;
    global.PARCEL_FETCH_DEBOUNCE_MS = PARCEL_FETCH_DEBOUNCE_MS;
    global.PARCEL_FETCH_GRID_RADIUS = PARCEL_FETCH_GRID_RADIUS;
    global.parcelCache = parcelCache;
    global.parcelLayerIndex = parcelLayerIndex;
    global.parcelMergeInProgress = parcelMergeInProgress;
    global.isParcelMergeInProgress = () => parcelMergeInProgress;
    global.setParcelMergeInProgressState = api.setParcelMergeInProgressState;

    // Keep live bindings through getters/setters on the global object for parity with previous code
    Object.defineProperties(global, {
        parcelLayer: {
            get() { return parcelLayer; },
            set(value) { parcelLayer = value; }
        },
        selectedParcelId: {
            get() { return selectedParcelId; },
            set(value) { selectedParcelId = value; }
        },
        currentParcel: {
            get() { return currentParcel; },
            set(value) { currentParcel = value; }
        },
        currentParcelCoordinates: {
            get() { return currentParcelCoordinates; },
            set(value) { currentParcelCoordinates = value; }
        },
        currentParcelMintStatusCache: {
            get() { return currentParcelMintStatusCache; },
            set(value) { currentParcelMintStatusCache = value; }
        },
        currentParcelMintStatusPromise: {
            get() { return currentParcelMintStatusPromise; },
            set(value) { currentParcelMintStatusPromise = value; }
        },
        currentParcelMintStatusParcelId: {
            get() { return currentParcelMintStatusParcelId; },
            set(value) { currentParcelMintStatusParcelId = value; }
        },
        splitLayer: {
            get() { return splitLayer; },
            set(value) { splitLayer = value; }
        },
        parcelsTimeout: {
            get() { return parcelsTimeout; },
            set(value) { parcelsTimeout = value; }
        }
    });

    global.ParcelsState = api;
})(typeof window !== 'undefined' ? window : globalThis);

