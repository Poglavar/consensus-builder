// Which parcels are roads: the stored road-parcel registry and the curated road classification
// that fills it. Always loaded, because roads bound blocks and shade the map from the first parcel
// on; the road DETECTION tools (OSM/GUP/WFS) stay an optional tool in road-detection.js.
(function (global) {
    'use strict';

    // ========================================================================
    // Road Parcels Storage Module
    // Centralized storage for road parcel IDs using a single array in PersistentStorage
    // ========================================================================
    const ROAD_PARCELS_KEY = 'roadParcels';

    // In-memory cache for fast lookups
    let roadParcelsSet = new Set();
    let roadParcelsLoaded = false;

    /**
     * Load road parcels from PersistentStorage into memory
     */
    function loadRoadParcels() {
        if (roadParcelsLoaded) return;
        try {
            const stored = global.PersistentStorage.getItem(ROAD_PARCELS_KEY);
            if (stored) {
                const arr = JSON.parse(stored);
                if (Array.isArray(arr)) {
                    // New writes enter through markRoadFeature(), which resolves explicit cadastral
                    // provenance before touching this registry. Stored values are identifiers, not a
                    // second geometry source, and are never reinterpreted from their spelling.
                    roadParcelsSet = new Set(arr.map(String).filter(Boolean));
                }
            }
            roadParcelsLoaded = true;
        } catch (e) {
            console.warn('Failed to load roadParcels from storage:', e);
            roadParcelsSet = new Set();
            roadParcelsLoaded = true;
        }
    }

    /**
     * Save road parcels to PersistentStorage
     */
    function saveRoadParcels() {
        try {
            const arr = Array.from(roadParcelsSet);
            global.PersistentStorage.setItem(ROAD_PARCELS_KEY, JSON.stringify(arr));
        } catch (e) {
            console.warn('Failed to save roadParcels to storage:', e);
        }
    }

    /**
     * Check if a parcel is marked as a road
     * @param {string} parcelId
     * @returns {boolean}
     */
    function isRoadParcel(parcelId) {
        if (!parcelId) return false;
        loadRoadParcels();
        return roadParcelsSet.has(String(parcelId));
    }

    /**
     * Mark parcels as roads; the registry is written once, however many are new.
     * @param {string[]} parcelIds
     * @returns {string[]} the ids that were not roads before
     */
    function addRoadParcels(parcelIds) {
        loadRoadParcels();
        const added = [];
        (parcelIds || []).forEach(parcelId => {
            const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
            if (!id || roadParcelsSet.has(id)) return;
            roadParcelsSet.add(id);
            added.push(id);
        });
        if (added.length) saveRoadParcels();
        return added;
    }

    /**
     * Mark a parcel as a road
     * @param {string} parcelId
     */
    function addRoadParcel(parcelId) {
        if (!parcelId) return;
        addRoadParcels([parcelId]);
    }

    /**
     * Remove road status from a parcel
     * @param {string} parcelId
     */
    function removeRoadParcel(parcelId) {
        if (!parcelId) return;
        loadRoadParcels();
        const id = String(parcelId);
        if (roadParcelsSet.has(id)) {
            roadParcelsSet.delete(id);
            saveRoadParcels();
        }
    }

    /**
     * Clear all road parcels
     */
    function clearAllRoadParcels() {
        roadParcelsSet.clear();
        roadParcelsLoaded = true;
        global.PersistentStorage.removeItem(ROAD_PARCELS_KEY);
    }

    /**
     * Get all road parcel IDs
     * @returns {string[]}
     */
    function getAllRoadParcels() {
        loadRoadParcels();
        return Array.from(roadParcelsSet);
    }

    /**
     * Get the count of road parcels
     * @returns {number}
     */
    function getRoadParcelCount() {
        loadRoadParcels();
        return roadParcelsSet.size;
    }

    // ------------------------------------------------------------------------
    // Curated road source (city-config `curatedRoads`): the backend serves the parcels the
    // road_parcel_classification materialized view already marked as roads (Zagreb only for now).
    // One bbox fetch replaces the whole client-side OSM/GUP/WFS detection for such cities, and it
    // auto-runs in the background after every parcel ingest so roads appear without the Tools sheet.
    // ------------------------------------------------------------------------

    let curatedRoadFetchTimer = null;

    function curatedRoadsAvailable() {
        try { return global.CadastralParcelRepository?.roadClassificationAvailable?.() === true; }
        catch (_) { return false; }
    }

    // Repaint only the parcels whose class just changed. Every other layer was styled from the
    // registry when it was drawn (parcels/styles.js asks isRoad); restyling the whole fabric here
    // cost 35–390 ms of main thread per fetch, growing with the ground loaded.
    function restyleMarkedRoads(parcelIds) {
        const presenter = global.ParcelPresenter;
        if (!presenter || typeof presenter.getLayer !== 'function') return;
        // One canvas redraw for the whole batch, as the presenter's own commits do.
        const renderer = typeof global.parcelCanvasRenderer === 'function' ? global.parcelCanvasRenderer() : null;
        const canHold = renderer && typeof renderer.holdRedraws === 'function';
        if (canHold) renderer.holdRedraws();
        try {
            parcelIds.forEach(parcelId => {
                const layer = presenter.getLayer(parcelId);
                if (!layer || typeof layer.setStyle !== 'function') return;
                // Road parcels get no name labels; any tooltip a previous build bound is taken off.
                const boundTooltip = layer.getTooltip?.();
                if (boundTooltip?.options?.className === 'road-name-tooltip') layer.unbindTooltip();
                layer.setStyle(global.getParcelBaseStyle(parcelId, layer, { isRoad: true }));
            });
        } finally {
            if (canHold) renderer.releaseRedraws();
        }
    }

    // `bounds` defaults to the view; block detection passes the wider ground it has just loaded, whose
    // roads must be known before a flood fill may cross it.
    async function fetchCuratedRoadParcels(bounds) {
        const ground = global.CadastralParcelRepository;
        const map = global.map;
        if (!ground?.ensureRoadIds || !curatedRoadsAvailable() || !map) return 0;
        const result = await ground.ensureRoadIds(bounds || map.getBounds());
        const marked = addRoadParcels(result.ids);
        const added = marked.length;
        if (added > 0) {
            restyleMarkedRoads(marked);
            // Roads bound blocks, so a block formed before these were known may span one.
            global.dispatchEvent(new global.CustomEvent('roadParcelsMarked', { detail: { parcelIds: marked } }));
        }
        console.log(`[${new Date().toISOString()}] [curated-roads] ${result.ids.length} road parcels in view, ${added} newly marked`);
        return added;
    }

    // Auto-run: parcels land in bursts per moveend, so debounce like the buildings viewport fetch.
    function scheduleCuratedRoadRefresh() {
        if (!curatedRoadsAvailable()) return;
        if (curatedRoadFetchTimer) clearTimeout(curatedRoadFetchTimer);
        curatedRoadFetchTimer = setTimeout(() => {
            curatedRoadFetchTimer = null;
            fetchCuratedRoadParcels().catch(error => console.error('[curated-roads] background fetch failed', error));
        }, 800);
    }
    global.addEventListener('parcelDataLoaded', scheduleCuratedRoadRefresh);

    const api = {
        addRoadParcel,
        addRoadParcels,
        clearAllRoadParcels,
        curatedRoadsAvailable,
        fetchCuratedRoadParcels,
        getAllRoadParcels,
        getRoadParcelCount,
        isRoadParcel,
        removeRoadParcel
    };
    global.__roadParcels = api;
    // The registry's long-standing globals: every map, block, 3D and selection module asks these.
    global.isRoadParcel = isRoadParcel;
    global.addRoadParcel = addRoadParcel;
    global.removeRoadParcel = removeRoadParcel;
    global.clearAllRoadParcels = clearAllRoadParcels;
    global.getAllRoadParcels = getAllRoadParcels;
    global.getRoadParcelCount = getRoadParcelCount;
    global.curatedRoadsAvailable = curatedRoadsAvailable;
    global.fetchCuratedRoadParcels = fetchCuratedRoadParcels;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
