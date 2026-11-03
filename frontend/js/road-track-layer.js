// Independent, noninteractive view of the OSM road and track boundaries used by block detection.
(function (win) {
    'use strict';
    if (!win?.document) return;
    const KEY = 'cb-road-track-layer-enabled';
    let wired = false, enabled = false, version = 0, pending = null, group = null, pane = null, coverage = null;
    const el = id => win.document.getElementById(id);
    function status(key, fallback) {
        const node = el('road-track-layer-status');
        if (key === 'off') { if (node) node.textContent = ''; return; }
        const translation = win.i18n?.t?.(`roadTrackLayer.${key}`);
        if (node) node.textContent = translation && translation !== `roadTrackLayer.${key}` ? translation : fallback;
    }
    function cancel() { version++; pending?.abort(); pending = null; }
    function clear() { group?.clearLayers(); coverage = null; }
    function bboxOf(bounds) {
        const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
        return [sw.lng, sw.lat, ne.lng, ne.lat];
    }
    function expanded(b) {
        const [w,s,e,n] = b, dx = (e-w)*.25, dy = (n-s)*.25;
        if (e <= w || n <= s || (e-w)*1.5 > .06 || (n-s)*1.5 > .06 || w-dx < -180 || e+dx > 180 || s-dy < -90 || n+dy > 90) return null;
        return [w-dx,s-dy,e+dx,n+dy];
    }
    const contains = (a,b) => a && b[0]>=a[0] && b[1]>=a[1] && b[2]<=a[2] && b[3]<=a[3];
    async function refresh() {
        if (!enabled || !win.map) return false;
        if (win.map.getZoom() < 15) { cancel(); clear(); status('zoom', 'Zoom in to neighbourhood scale to show roads and tracks.'); return false; }
        const view = bboxOf(win.map.getBounds());
        if (contains(coverage, view)) return true;
        const bbox = expanded(view);
        if (!bbox) { cancel(); clear(); status('zoom', 'Zoom in to neighbourhood scale to show roads and tracks.'); return false; }
        cancel(); clear(); const own = version, ctrl = new win.AbortController(); pending = ctrl;
        status('loading', 'Loading eligible roads and tracks…');
        try {
            const roads = await win.ParcelBlockDetection.fetchBoundaries(win, bbox, ctrl.signal);
            if (!enabled || own !== version) return false;
            if (!Array.isArray(roads?.features)) throw new Error('Invalid road boundary data');
            if (roads.complete !== true || roads.partial || roads.truncated) throw new Error('OSM road data is incomplete. Zoom in and retry.');
            const features = roads.features.filter(f => win.UrbanBlocksModel.isRoadTrackBoundary(f?.properties || {}));
            if (features.length) win.L.geoJSON({ type: 'FeatureCollection', features }, {
                pane: 'roadTrackPane', interactive: false, style: () => ({ className: 'road-track-line' })
            }).addTo(group);
            coverage = bbox; status('ready', 'Showing eligible roads and tracks.');
            return true;
        } catch (err) {
            if (own !== version || err?.name === 'AbortError') return false;
            status('error', 'Could not load roads and tracks. Please retry.');
            return false;
        } finally { if (own === version) pending = null; }
    }
    function setEnabled(value) {
        enabled = Boolean(value); cancel(); clear();
        try { win.localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (_) { }
        if (el('road-track-layer-checkbox')) el('road-track-layer-checkbox').checked = enabled;
        if (!enabled) { if (group && win.map?.hasLayer(group)) win.map.removeLayer(group); status('off', ''); return Promise.resolve(true); }
        if (group && !win.map.hasLayer(group)) group.addTo(win.map);
        return refresh();
    }
    function initialize() {
        if (wired || !win.map || !el('road-track-layer-checkbox')) return;
        wired = true;
        pane = win.map.createPane('roadTrackPane'); pane.classList.add('road-track-pane');
        group = win.L.layerGroup();
        el('road-track-layer-checkbox').addEventListener('change', e => setEnabled(e.target.checked));
        win.map.on('moveend', refresh);
        win.addEventListener('cityChanged', () => { cancel(); clear(); if (enabled) refresh(); });
        let saved = false; try { saved = win.localStorage.getItem(KEY) === '1'; } catch (_) { }
        setEnabled(saved);
    }
    win.RoadTrackLayer = { initialize, setEnabled, isEnabled: () => enabled };
})(typeof window !== 'undefined' ? window : null);
