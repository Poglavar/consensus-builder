// Viewport helpers around the authoritative parcel architecture.
//
// Parcel geometry is owned by LiveParcelFabric; Leaflet layers are owned by ParcelPresenter.
// This file intentionally contains no layer insertion/removal and no geometry cache.
(function attachParcelStorageFacade(global) {
    'use strict';

    function parcelGridSize() {
        const configured = global.ParcelsState?.getParcelGridSize?.()
            ?? global.CityConfigManager?.getParcelGridSize?.()
            ?? global.PARCELS_GRID_SIZE;
        return Number(configured);
    }

    function getGridKey(easting, northing) {
        const size = parcelGridSize();
        if (!(size > 0)) return null;
        return `${Math.floor(Number(easting) / size)},${Math.floor(Number(northing) / size)}`;
    }

    function getRequiredGridCells(bounds, extraRadius = 0) {
        const size = parcelGridSize();
        const cells = new Set();
        if (!bounds || typeof bounds.getSouthWest !== 'function' || !(size > 0)
            || typeof global.wgs84ToDataset !== 'function') return cells;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const center = typeof bounds.getCenter === 'function' ? bounds.getCenter() : {
            lat: (sw.lat + ne.lat) / 2,
            lng: (sw.lng + ne.lng) / 2
        };
        const [centerE, centerN] = global.wgs84ToDataset(center.lat, center.lng);
        const [swE, swN] = global.wgs84ToDataset(sw.lat, sw.lng);
        const [neE, neN] = global.wgs84ToDataset(ne.lat, ne.lng);
        if (![centerE, centerN, swE, swN, neE, neN].every(Number.isFinite)) return cells;

        const datasetBounds = global.CURRENT_CITY_CONFIG && global.CURRENT_CITY_CONFIG.projection
            && global.CURRENT_CITY_CONFIG.projection.datasetBounds;
        const minE = Math.min(swE, neE);
        const maxE = Math.max(swE, neE);
        const minN = Math.min(swN, neN);
        const maxN = Math.max(swN, neN);
        if (datasetBounds && (maxE < datasetBounds.minX || minE > datasetBounds.maxX
            || maxN < datasetBounds.minY || minN > datasetBounds.maxY)) return cells;

        const centerGridE = Math.floor(centerE / size);
        const centerGridN = Math.floor(centerN / size);
        const epsilon = 1e-6;
        const minGridE = Math.floor(minE / size);
        const maxGridE = Math.max(minGridE, Math.floor((maxE - epsilon) / size));
        const minGridN = Math.floor(minN / size);
        const maxGridN = Math.max(minGridN, Math.floor((maxN - epsilon) / size));
        const requestedRadius = Number.isFinite(Number(extraRadius)) ? Math.max(0, Math.floor(Number(extraRadius))) : 0;
        const radius = Math.max(
            requestedRadius,
            centerGridE - minGridE,
            maxGridE - centerGridE,
            centerGridN - minGridN,
            maxGridN - centerGridN
        );
        for (let e = centerGridE - radius; e <= centerGridE + radius; e += 1) {
            for (let n = centerGridN - radius; n <= centerGridN + radius; n += 1) cells.add(`${e},${n}`);
        }
        return cells;
    }

    function computeGridKeysForBounds(bounds) {
        return Array.from(getRequiredGridCells(bounds, 0));
    }

    function presenter() {
        return global.ParcelPresenter || null;
    }

    function getPresentedParcelLayer(parcelId) {
        const value = presenter();
        return value && typeof value.getLayer === 'function' ? value.getLayer(parcelId) : null;
    }

    function getPresentedParcelId(layer) {
        const value = presenter();
        return value && typeof value.getIdForLayer === 'function'
            ? value.getIdForLayer(layer)
            : null;
    }

    function getLiveParcelFeature(layerOrId) {
        const id = typeof layerOrId === 'string' || typeof layerOrId === 'number'
            ? String(layerOrId)
            : getPresentedParcelId(layerOrId);
        return id && global.LiveParcelFabric && typeof global.LiveParcelFabric.get === 'function'
            ? global.LiveParcelFabric.get(id)
            : null;
    }

    function resolveLiveParcelLayers(parcelIds, options = {}) {
        const value = presenter();
        return value && typeof value.resolveLiveLayers === 'function'
            ? value.resolveLiveLayers(parcelIds, options)
            : [];
    }

    function getParcelLayersWithinBounds(bounds) {
        const value = presenter();
        return value && typeof value.getLayersWithinBounds === 'function'
            ? value.getLayersWithinBounds(bounds)
            : [];
    }

    function getParcelsInBounds(bounds) {
        const target = bounds || (global.map && typeof global.map.getBounds === 'function' ? global.map.getBounds() : null);
        return getParcelLayersWithinBounds(target);
    }

    function eachVisibleParcel(callback, bounds) {
        if (typeof callback !== 'function') return;
        getParcelsInBounds(bounds).forEach(callback);
    }

    function ensureParcelLayerInitialized() {
        const value = presenter();
        return value && typeof value.ensureGroup === 'function' ? value.ensureGroup() : null;
    }

    function addParcelLayerToMapIfAppropriate() {
        const value = presenter();
        return !!(value && typeof value.addGroupToMapIfAppropriate === 'function'
            && value.addGroupToMapIfAppropriate());
    }

    function debugParcelCount(parcelId) {
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const layer = getPresentedParcelLayer(id);
        const fabricFeature = global.LiveParcelFabric && global.LiveParcelFabric.get(id);
        return {
            parcelId: id,
            inLiveFabric: !!fabricFeature,
            inParcelLayer: layer ? 1 : 0,
            total: layer ? 1 : 0,
            duplicatePathsInDOM: 0,
            presenterRevision: global.LiveParcelFabric ? global.LiveParcelFabric.snapshot().revision : null
        };
    }

    function analyzeMultiPolygonParcels() {
        const features = global.LiveParcelFabric ? global.LiveParcelFabric.list() : [];
        const multi = features.filter(feature => feature && feature.geometry && feature.geometry.type === 'MultiPolygon');
        return {
            totalParcels: features.length,
            polygonCount: features.length - multi.length,
            multiPolygonCount: multi.length,
            multiPolygonParcels: multi.map(feature => ({
                parcelId: feature.properties && feature.properties.parcelId,
                componentCount: feature.geometry.coordinates.length
            })),
            invalidGeometries: []
        };
    }

    function getMultiPolygonDetails(parcelId) {
        const feature = global.LiveParcelFabric && global.LiveParcelFabric.get(parcelId);
        if (!feature || !feature.geometry || feature.geometry.type !== 'MultiPolygon') return null;
        return { parcelId: String(parcelId), componentCount: feature.geometry.coordinates.length, feature };
    }

    function checkParcelVisibility(parcelId) {
        const layer = getPresentedParcelLayer(parcelId);
        const group = ensureParcelLayerInitialized();
        return {
            parcelId: String(parcelId),
            exists: !!layer,
            visible: !!(layer && group && typeof group.hasLayer === 'function' && group.hasLayer(layer))
        };
    }

    global.getGridKey = getGridKey;
    global.getRequiredGridCells = getRequiredGridCells;
    global.computeGridKeysForBounds = computeGridKeysForBounds;
    global.resolveLiveParcelLayers = resolveLiveParcelLayers;
    global.getPresentedParcelId = getPresentedParcelId;
    global.getLiveParcelFeature = getLiveParcelFeature;
    global.getParcelLayersWithinBounds = getParcelLayersWithinBounds;
    global.getParcelsInBounds = getParcelsInBounds;
    global.eachVisibleParcel = eachVisibleParcel;
    global.ensureParcelLayerInitialized = ensureParcelLayerInitialized;
    global.addParcelLayerToMapIfAppropriate = addParcelLayerToMapIfAppropriate;
    global.debugParcelCount = debugParcelCount;
    global.analyzeMultiPolygonParcels = analyzeMultiPolygonParcels;
    global.getMultiPolygonDetails = getMultiPolygonDetails;
    global.checkParcelVisibility = checkParcelVisibility;
})(typeof window !== 'undefined' ? window : globalThis);
