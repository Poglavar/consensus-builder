// Loads immutable, OSM-derived transport alignments once and exposes the same normalized
// records to station placement and 3D rendering. Proposal corridors remain a separate source.
(function (root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TransitAlignments = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const INDEX_CELL_DEGREES = 0.005;
    let state = emptyState();

    function emptyState() {
        return {
            signature: null,
            status: 'idle',
            sources: [],
            records: [],
            spatialIndex: null,
            promise: null,
            error: null
        };
    }

    function normalizeStationTypes(value) {
        const values = Array.isArray(value) ? value : [];
        return [...new Set(values.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
    }

    function normalizeSource(sourceValue, index = 0) {
        const source = sourceValue || {};
        const url = String(source.url || '').trim();
        if (!url) return null;
        const mode = String(source.mode || 'rail').trim().toLowerCase();
        const id = String(source.id || `${mode}-${index + 1}`).trim();
        const elevation = Number(source.elevationM);
        return Object.freeze({
            id,
            url,
            mode,
            stationTypes: Object.freeze(normalizeStationTypes(source.stationTypes)),
            elevationM: Number.isFinite(elevation) ? elevation : 0,
            render3d: String(source.render3d || 'surface').trim().toLowerCase()
        });
    }

    function normalizeConfig(configValue) {
        const sources = Array.isArray(configValue?.sources) ? configValue.sources : [];
        return sources.map(normalizeSource).filter(Boolean);
    }

    function lineParts(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'LineString') return [geometry.coordinates || []];
        if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
        return [];
    }

    function coordinate(value) {
        if (!Array.isArray(value) || value.length < 2) return null;
        const lng = Number(value[0]);
        const lat = Number(value[1]);
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    function featureIdentity(feature, featureIndex) {
        const properties = feature?.properties || {};
        const value = properties.osmId ?? properties.osm_id ?? properties.id ?? feature?.id ?? featureIndex;
        return String(value);
    }

    function coordinateBounds(points) {
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        for (const point of points || []) {
            west = Math.min(west, point[0]);
            south = Math.min(south, point[1]);
            east = Math.max(east, point[0]);
            north = Math.max(north, point[1]);
        }
        return Number.isFinite(west) ? Object.freeze([west, south, east, north]) : null;
    }

    function buildAlignmentRecords(sourceValue, featureCollection) {
        const source = normalizeSource(sourceValue);
        if (!source) return [];
        const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
        const records = [];
        features.forEach((feature, featureIndex) => {
            const featureId = featureIdentity(feature, featureIndex);
            lineParts(feature?.geometry).forEach((part, partIndex) => {
                const points = (part || []).map(coordinate).filter(Boolean);
                if (points.length < 2) return;
                records.push(Object.freeze({
                    sourceKind: 'reference',
                    sourceId: source.id,
                    featureId,
                    recordId: `${source.id}:${featureId}:${partIndex}`,
                    mode: source.mode,
                    stationTypes: source.stationTypes,
                    elevationM: source.elevationM,
                    render3d: source.render3d,
                    points: Object.freeze(points.map(point => Object.freeze(point))),
                    bounds: coordinateBounds(points),
                    properties: Object.freeze({ ...(feature.properties || {}) })
                }));
            });
        });
        return records;
    }

    function indexCell(value, cellSize = INDEX_CELL_DEGREES) {
        return Math.floor(Number(value) / cellSize);
    }

    function buildSpatialIndex(records, cellSize = INDEX_CELL_DEGREES) {
        const cells = new Map();
        for (const record of records || []) {
            const bounds = record?.bounds;
            if (!Array.isArray(bounds) || bounds.length < 4) continue;
            for (let x = indexCell(bounds[0], cellSize); x <= indexCell(bounds[2], cellSize); x++) {
                for (let y = indexCell(bounds[1], cellSize); y <= indexCell(bounds[3], cellSize); y++) {
                    const key = `${x}:${y}`;
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(record);
                }
            }
        }
        return Object.freeze({ cellSize, cells });
    }

    function querySpatialIndex(index, centerValue, radiusM = 24) {
        const center = coordinate(centerValue);
        if (!index?.cells || !center) return [];
        const latPad = Math.max(0, Number(radiusM) || 0) / 111320;
        const cosLat = Math.max(0.15, Math.cos(center[1] * Math.PI / 180));
        const lngPad = latPad / cosLat;
        const searchBounds = [center[0] - lngPad, center[1] - latPad, center[0] + lngPad, center[1] + latPad];
        const matches = [];
        const seen = new Set();
        for (let x = indexCell(searchBounds[0], index.cellSize); x <= indexCell(searchBounds[2], index.cellSize); x++) {
            for (let y = indexCell(searchBounds[1], index.cellSize); y <= indexCell(searchBounds[3], index.cellSize); y++) {
                for (const record of index.cells.get(`${x}:${y}`) || []) {
                    if (seen.has(record.recordId)) continue;
                    seen.add(record.recordId);
                    const bounds = record.bounds;
                    const intersects = bounds[2] >= searchBounds[0] && bounds[0] <= searchBounds[2]
                        && bounds[3] >= searchBounds[1] && bounds[1] <= searchBounds[3];
                    if (intersects) matches.push(record);
                }
            }
        }
        return matches;
    }

    function configuredSources() {
        try {
            return normalizeConfig(global.CityConfigManager?.getTransitAlignmentConfig?.() || null);
        } catch (_) {
            return [];
        }
    }

    function sourceSignature(sources) {
        return JSON.stringify(sources.map(source => ({
            id: source.id,
            url: source.url,
            mode: source.mode,
            stationTypes: source.stationTypes,
            elevationM: source.elevationM,
            render3d: source.render3d
        })));
    }

    function ensureLoaded(configValue, fetchValue) {
        const sources = configValue === undefined ? configuredSources() : normalizeConfig(configValue);
        const signature = sourceSignature(sources);
        if (state.signature === signature && state.promise) return state.promise;
        if (!sources.length) {
            state = { ...emptyState(), signature, status: 'ready', promise: Promise.resolve([]) };
            return state.promise;
        }
        const fetchImpl = fetchValue || global.fetch;
        if (typeof fetchImpl !== 'function') {
            const error = new Error('Transit alignment loading requires fetch.');
            state = { ...emptyState(), signature, status: 'error', error, promise: Promise.reject(error) };
            return state.promise;
        }

        const promise = Promise.all(sources.map(async source => {
            const response = await fetchImpl(source.url);
            if (!response?.ok) throw new Error(`${source.id} responded ${response?.status ?? 'without a status'}`);
            const featureCollection = await response.json();
            return Object.freeze({
                ...source,
                featureCollection,
                records: Object.freeze(buildAlignmentRecords(source, featureCollection))
            });
        })).then(loadedSources => {
            if (state.signature !== signature) return state.records;
            const records = loadedSources.flatMap(source => source.records);
            const spatialIndex = buildSpatialIndex(records);
            state = {
                signature,
                status: 'ready',
                sources: Object.freeze(loadedSources),
                records: Object.freeze(records),
                spatialIndex,
                promise: Promise.resolve(records),
                error: null
            };
            try {
                global.dispatchEvent?.(new global.CustomEvent('transitAlignments:ready', {
                    detail: { sourceCount: loadedSources.length, recordCount: records.length }
                }));
            } catch (_) { }
            return state.records;
        }).catch(error => {
            if (state.signature === signature) {
                state = { ...emptyState(), signature, status: 'error', error, promise: null };
            }
            throw error;
        });
        state = { ...emptyState(), signature, status: 'loading', promise };
        return promise;
    }

    function reset() {
        state = emptyState();
    }

    function getRecords() {
        return state.records;
    }

    function getLoadedSources() {
        return state.sources;
    }

    function queryNearby(center, radiusM) {
        return querySpatialIndex(state.spatialIndex, center, radiusM);
    }

    function getStatus() {
        return Object.freeze({ status: state.status, error: state.error });
    }

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('cityChanged', () => {
            reset();
            ensureLoaded().catch(error => console.error('[transit-alignments] reload failed', error));
        });
    }
    if (global.CityConfigManager) {
        ensureLoaded().catch(error => console.error('[transit-alignments] initial load failed', error));
    }

    return Object.freeze({
        normalizeSource,
        normalizeConfig,
        buildAlignmentRecords,
        buildSpatialIndex,
        querySpatialIndex,
        ensureLoaded,
        getRecords,
        getLoadedSources,
        queryNearby,
        getStatus,
        reset
    });
});
