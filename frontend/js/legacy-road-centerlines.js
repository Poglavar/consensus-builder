// EXISTING-road centrelines (from the backend /osm-road endpoint, i.e. the osm_road linestrings) as
// a read-only reference layer, and as snap targets for the corridor drawing tool. Never proposals.
// Viewport-scoped: lines are fetched for the current bbox only once zoomed in enough that the count
// stays sane, cached by bbox key, and refetched (debounced) as the map moves. The visible layer (the
// sidebar toggle) and snapping (window.LegacyRoadCenterlines: ensureLoaded / features / snapLines,
// loaded whether or not the layer is shown) share ONE cache, so nothing is fetched twice.
(function attachLegacyRoadCenterlines(global) {
    'use strict';

    const PANE = 'legacyRoadCenterlinesPane';
    const MIN_ZOOM = 14;          // below this the viewport holds too many roads to fetch usefully
    const REFRESH_DEBOUNCE_MS = 400;
    const CACHE_LIMIT = 8;        // viewports kept, so panning back and forth refetches nothing
    const STYLE = { color: '#8a63d2', weight: 2, opacity: 0.75, interactive: true };

    let layer = null;
    let enabled = false;
    let refreshTimer = null;
    let lastKey = '';             // the viewport the visible layer shows

    // The shared cache: bbox key → features, least recently used first. `current` is the viewport
    // loaded last — what snapping reads; its snap lines are built once, on first use.
    const cache = new Map();
    let current = { key: '', features: [], lines: null };
    let inflight = null;          // { key, promise } of the fetch under way
    let requestSeq = 0;
    let loadTimer = null;

    function map() { return global.map; }

    function ensurePane() {
        const m = map();
        if (!m || typeof m.getPane !== 'function') return null;
        let pane = m.getPane(PANE);
        if (!pane && typeof m.createPane === 'function') {
            pane = m.createPane(PANE);
            // Above the parcel fill, below the corridor strips (630) and node handles — a quiet backdrop.
            pane.style.zIndex = 615;
        }
        return pane;
    }

    function bboxKey() {
        const m = map();
        if (!m || typeof m.getBounds !== 'function') return '';
        const b = m.getBounds();
        // WGS84 with its CRS named; the server transforms it (projections.md §4)
        return (typeof wgs84BboxParam === 'function') ? wgs84BboxParam(b) : '';
    }

    async function fetchCenterlines(bboxQuery) {
        const base = (typeof getBackendBase === 'function' && getBackendBase()) || 'http://localhost:3000';
        const url = `${base}/osm-road${bboxQuery ? `?${bboxQuery}` : ''}`;
        if (typeof fetchJsonWithRetry === 'function') return fetchJsonWithRetry(url);
        const res = await fetch(url);
        return res.ok ? res.json() : null;
    }

    function cacheFeatures(key, features) {
        cache.delete(key);
        cache.set(key, features);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }

    function makeCurrent(key, features) {
        if (current.key === key && current.features === features) return;
        current = { key, features, lines: null };
    }

    // The current viewport's lines, from the cache or the network. Resolves to its features; []
    // below MIN_ZOOM, where nothing is fetched (snapping keeps the last viewport's lines). `force`
    // refetches a viewport that is already cached. A slower response for a viewport the map has
    // already left is cached but never replaces the newer `current`.
    function loadViewport(force = false) {
        const m = map();
        if (!m) return Promise.resolve([]);
        if (typeof m.getZoom === 'function' && m.getZoom() < MIN_ZOOM) return Promise.resolve([]);
        const key = bboxKey();
        if (!key) return Promise.resolve([]);
        if (!force && cache.has(key)) {
            const features = cache.get(key);
            cacheFeatures(key, features);
            makeCurrent(key, features);
            return Promise.resolve(features);
        }
        if (!force && inflight && inflight.key === key) return inflight.promise;
        const seq = ++requestSeq;
        const promise = fetchCenterlines(key).then(data => {
            const features = data && Array.isArray(data.features) ? data.features : [];
            cacheFeatures(key, features);
            if (seq === requestSeq) makeCurrent(key, features);
            return features;
        }).finally(() => {
            if (inflight && inflight.promise === promise) inflight = null;
        });
        inflight = { key, promise };
        return promise;
    }

    // Every line part as a snap candidate: { points: [{lat, lng}], bbox: [minLng, minLat, maxLng,
    // maxLat], name, wayId }. A MultiLineString gives one candidate per part; parts of fewer than
    // two valid points are no line and are left out.
    // Ways a road should not be snapped onto: a footway or a path has no carriageway to join.
    const NOT_A_STREET = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor', 'platform']);

    function streetLinesOf(features) {
        const lines = [];
        (Array.isArray(features) ? features : []).forEach(feature => {
            const geometry = feature && feature.geometry;
            const properties = (feature && feature.properties) || {};
            if (!geometry) return;
            const highway = String(properties.highway || properties.highway_type || '').toLowerCase();
            if (NOT_A_STREET.has(highway)) return;
            const parts = geometry.type === 'LineString'
                ? [geometry.coordinates]
                : (geometry.type === 'MultiLineString' ? geometry.coordinates : []);
            (Array.isArray(parts) ? parts : []).forEach(coordinates => {
                const points = (Array.isArray(coordinates) ? coordinates : [])
                    .map(pair => ({ lat: Number(pair && pair[1]), lng: Number(pair && pair[0]) }))
                    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
                if (points.length < 2) return;
                const bbox = [Infinity, Infinity, -Infinity, -Infinity];
                points.forEach(point => {
                    bbox[0] = Math.min(bbox[0], point.lng);
                    bbox[1] = Math.min(bbox[1], point.lat);
                    bbox[2] = Math.max(bbox[2], point.lng);
                    bbox[3] = Math.max(bbox[3], point.lat);
                });
                const name = typeof properties.name === 'string' && properties.name.trim() ? properties.name.trim() : null;
                const wayId = properties.osm_id !== undefined && properties.osm_id !== null ? String(properties.osm_id) : null;
                lines.push({ points, bbox, name, wayId });
            });
        });
        return lines;
    }

    // The drawing tool's entry: the viewport's lines at zoom ≥ MIN_ZOOM, whether or not the layer
    // is shown. A failed fetch is logged and leaves snapping on whatever loaded before.
    function ensureLoaded() {
        return loadViewport(false).catch(error => {
            console.warn(`[${new Date().toISOString()}] [legacyRoadCenterlines] street lines for snapping did not load`, error);
            return current.features;
        });
    }

    // ensureLoaded, debounced — for moveend while drawing.
    function scheduleLoad() {
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(() => { loadTimer = null; ensureLoaded(); }, REFRESH_DEBOUNCE_MS);
    }

    function snapLines() {
        if (!current.lines) current.lines = streetLinesOf(current.features);
        return current.lines;
    }

    function clearLayer() {
        const m = map();
        if (layer && m && m.hasLayer(layer)) m.removeLayer(layer);
        layer = null;
    }

    function render(geojson) {
        clearLayer();
        if (!geojson || !Array.isArray(geojson.features) || !global.L) return;
        ensurePane();
        layer = global.L.geoJSON(geojson, {
            pane: PANE,
            style: STYLE,
            onEachFeature: (feature, lyr) => {
                const p = feature && feature.properties;
                const name = (p && (p.name || p.highway_type)) || 'Existing road';
                lyr.bindTooltip(String(name), { sticky: true });
            }
        });
        layer.addTo(map());
    }

    // `force` redraws a viewport the layer already shows; `refetch` also bypasses the shared cache
    // (the public refreshLegacyRoadCenterlines). Turning the layer on draws from the cache when the
    // drawing tool has already loaded this viewport for snapping.
    async function refresh(force = false, refetch = false) {
        if (!enabled) return;
        const m = map();
        if (!m) return;
        if (typeof m.getZoom === 'function' && m.getZoom() < MIN_ZOOM) {
            // Too far out — drop the layer rather than pull thousands of lines.
            clearLayer();
            lastKey = '';
            if (typeof updateStatus === 'function') {
                updateStatus('Zoom in to see existing road centrelines.');
            }
            return;
        }
        const key = bboxKey();
        if (!force && key && key === lastKey) return; // same viewport, nothing to do
        lastKey = key;
        try {
            const features = await loadViewport(refetch);
            if (!enabled) return; // toggled off while fetching
            if (key !== lastKey) return; // the map moved on; the newer refresh draws
            render({ type: 'FeatureCollection', features });
        } catch (error) {
            console.warn('[legacyRoadCenterlines] fetch failed', error);
        }
    }

    function scheduleRefresh() {
        if (!enabled) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, REFRESH_DEBOUNCE_MS);
    }

    function enable() {
        if (enabled) return;
        enabled = true;
        const m = map();
        if (m && typeof m.on === 'function') m.on('moveend zoomend', scheduleRefresh);
        refresh(true);
    }

    function disable() {
        enabled = false;
        const m = map();
        if (m && typeof m.off === 'function') m.off('moveend zoomend', scheduleRefresh);
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        clearLayer();
        lastKey = '';
    }

    // Wired to the sidebar checkbox (#showLegacyRoadCenterlines). Falls back to flipping state when
    // called without the checkbox present.
    function toggleLegacyRoadCenterlines() {
        const cb = (typeof document !== 'undefined') ? document.getElementById('showLegacyRoadCenterlines') : null;
        const on = cb ? cb.checked : !enabled;
        if (on) enable(); else disable();
    }

    global.toggleLegacyRoadCenterlines = toggleLegacyRoadCenterlines;
    global.refreshLegacyRoadCenterlines = () => refresh(true, true);

    const api = {
        MIN_ZOOM,
        ensureLoaded,
        scheduleLoad,
        features: () => current.features,
        snapLines,
        streetLinesOf
    };
    global.LegacyRoadCenterlines = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
