// Read-only reference layer of EXISTING-road centrelines (from the backend /osm-road endpoint, i.e.
// the osm_road linestrings). Purely a visual aid — never proposals. Viewport-scoped: it fetches the
// current bbox on toggle and refetches (debounced) as the map moves, and only fetches once zoomed in
// enough that the count stays sane. This is the groundwork for later snapping new roads onto legacy
// ones; for now it just draws the lines.
(function attachLegacyRoadCenterlines(global) {
    'use strict';

    const PANE = 'legacyRoadCenterlinesPane';
    const MIN_ZOOM = 14;          // below this the viewport holds too many roads to fetch usefully
    const REFRESH_DEBOUNCE_MS = 400;
    const STYLE = { color: '#8a63d2', weight: 2, opacity: 0.75, interactive: true };

    let layer = null;
    let enabled = false;
    let refreshTimer = null;
    let lastKey = '';
    // Snap segments for the currently-shown centrelines, so road drawing can start a new road on an
    // existing one. Only populated while the layer is enabled (see getLegacyRoadSnapEntries).
    let currentSnapEntries = [];

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
        return (typeof getBboxFromBounds === 'function') ? getBboxFromBounds(b) : '';
    }

    async function fetchCenterlines(bboxHTRS) {
        const base = (typeof getBackendBase === 'function' && getBackendBase()) || 'http://localhost:3000';
        const url = `${base}/osm-road${bboxHTRS ? `?bbox=${encodeURIComponent(bboxHTRS)}` : ''}`;
        if (typeof fetchJsonWithRetry === 'function') return fetchJsonWithRetry(url);
        const res = await fetch(url);
        return res.ok ? res.json() : null;
    }

    function clearLayer() {
        const m = map();
        if (layer && m && m.hasLayer(layer)) m.removeLayer(layer);
        layer = null;
        currentSnapEntries = [];
    }

    function render(geojson) {
        clearLayer();
        currentSnapEntries = (geojson && global.RoadSnapLegacy)
            ? global.RoadSnapLegacy.geojsonToSnapSegments(geojson)
            : [];
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

    async function refresh(force = false) {
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
            const data = await fetchCenterlines(key);
            if (!enabled) return; // toggled off while fetching
            render(data);
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
    global.refreshLegacyRoadCenterlines = () => refresh(true);
    // Snap targets for road drawing — only while the reference layer is on and drawn.
    global.getLegacyRoadSnapEntries = () => (enabled ? currentSnapEntries : []);
})(typeof window !== 'undefined' ? window : globalThis);
