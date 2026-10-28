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
        if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof bounds.getNorthEast !== 'function'
            || !Number.isFinite(size) || !(size > 0)
            || typeof global.wgs84ToDataset !== 'function') return cells;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        if (sw?.lat === null || sw?.lat === undefined || ne?.lat === null || ne?.lat === undefined
            || sw?.lng === null || sw?.lng === undefined || ne?.lng === null || ne?.lng === undefined) return cells;
        const south = Number(sw?.lat);
        const north = Number(ne?.lat);
        const west = Number(sw?.lng);
        const east = Number(ne?.lng);
        if (![south, north, west, east].every(Number.isFinite) || south > north || west > east) return cells;

        // Project the whole perimeter, not just SW and NE. Native projections can rotate or curve
        // a geographic rectangle, so those two diagonal points alone need not define its extent.
        // Sampling each edge also captures the curvature of common local projected CRSs while
        // keeping the fetched cells limited to the viewport's rectangular dataset-space envelope.
        const projected = [];
        const edgeSamples = 16;
        const project = (lat, lng) => {
            const value = global.wgs84ToDataset(lat, lng);
            if (!Array.isArray(value) || value.length < 2
                || value[0] === null || value[0] === undefined
                || value[1] === null || value[1] === undefined) return false;
            const easting = Number(value[0]);
            const northing = Number(value[1]);
            if (!Number.isFinite(easting) || !Number.isFinite(northing)) return false;
            projected.push([easting, northing]);
            return true;
        };
        for (let i = 0; i <= edgeSamples; i += 1) {
            const fraction = i / edgeSamples;
            const lat = south + (north - south) * fraction;
            const lng = west + (east - west) * fraction;
            if (!project(south, lng) || !project(north, lng)
                || !project(lat, west) || !project(lat, east)) return cells;
        }
        if (!projected.length) return cells;
        const minE = Math.min(...projected.map(point => point[0]));
        const maxE = Math.max(...projected.map(point => point[0]));
        const minN = Math.min(...projected.map(point => point[1]));
        const maxN = Math.max(...projected.map(point => point[1]));
        if (![minE, maxE, minN, maxN].every(Number.isFinite)) return cells;

        // CURRENT_CITY_CONFIG is map-core.js's top-level const, never on window: the check never ran.
        // Only the Croatian cities declare datasetBounds (the country, in HTRS96/TM).
        const currentConfig = global.CityConfigManager && typeof global.CityConfigManager.getCurrentCityConfig === 'function'
            ? global.CityConfigManager.getCurrentCityConfig() : null;
        const datasetBounds = currentConfig && currentConfig.projection && currentConfig.projection.datasetBounds;
        if (datasetBounds && (maxE < datasetBounds.minX || minE > datasetBounds.maxX
            || maxN < datasetBounds.minY || minN > datasetBounds.maxY)) return cells;

        // Snap numerical noise at cell edges using a tolerance scaled to the grid and coordinate
        // magnitude rather than assuming metres/degrees. Lower bounds are inclusive; upper bounds
        // are exclusive at an exact grid line.
        const boundaryEpsilon = value => Math.max(size * 1e-10, Number.EPSILON * Math.max(1, Math.abs(value)) * 8);
        const inclusiveLowerCell = value => Math.floor((value + boundaryEpsilon(value)) / size);
        const exclusiveUpperCell = value => {
            return Math.floor((value - boundaryEpsilon(value)) / size);
        };
        const minGridE = inclusiveLowerCell(minE);
        const minGridN = inclusiveLowerCell(minN);
        const maxGridE = exclusiveUpperCell(maxE);
        const maxGridN = exclusiveUpperCell(maxN);
        const requestedRadius = Number.isFinite(Number(extraRadius)) ? Math.max(0, Math.floor(Number(extraRadius))) : 0;
        const firstE = minGridE - requestedRadius;
        const lastE = Math.max(minGridE, maxGridE) + requestedRadius;
        const firstN = minGridN - requestedRadius;
        const lastN = Math.max(minGridN, maxGridN) + requestedRadius;
        for (let e = firstE; e <= lastE; e += 1) {
            for (let n = firstN; n <= lastN; n += 1) cells.add(`${e},${n}`);
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
            presenterRevision: global.LiveParcelFabric ? global.LiveParcelFabric.revision() : null
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
