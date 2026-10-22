// Parcel preview layer: title polygons a council import has already parsed under the current view,
// drawn at once while the import and overlap resolution continue; cleared when the real ground lands.
(function (global) {
    'use strict';
    const PANE = 'parcelPreview';
    const byId = new Map();
    let layer = null;

    const boundsOverlap = (feature, bounds) => {
        if (!bounds) return true;
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        const visit = value => {
            if (typeof value?.[0] === 'number') {
                west = Math.min(west, value[0]); south = Math.min(south, value[1]);
                east = Math.max(east, value[0]); north = Math.max(north, value[1]);
            } else if (Array.isArray(value)) value.forEach(visit);
        };
        visit(feature?.geometry?.coordinates);
        return west <= bounds[2] && east >= bounds[0] && south <= bounds[3] && north >= bounds[1];
    };

    // Which of the offered features are new to the preview and inside the view: pure, so testable.
    function mergePreview(known, features, bounds = null) {
        const added = [];
        for (const feature of Array.isArray(features) ? features : []) {
            const id = feature?.id ?? feature?.properties?.id;
            if (!id || known.has(id) || feature?.properties?.preview !== true || !boundsOverlap(feature, bounds)) continue;
            known.set(id, feature); added.push(feature);
        }
        return added;
    }

    const viewBounds = bounds => bounds && typeof bounds.getWest === 'function'
        ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
        : Array.isArray(bounds) && bounds.length === 4 ? bounds : null;

    function ensureLayer() {
        if (layer) return layer;
        const L = global.L, map = global.map;
        if (!L || !map || typeof L.geoJSON !== 'function') return null;
        if (!map.getPane(PANE)) {
            map.createPane(PANE);
            map.getPane(PANE).classList.add('parcel-preview-pane');
        }
        const color = global.getComputedStyle(global.document.documentElement).getPropertyValue('--cb-parcel-preview-boundary').trim();
        layer = L.geoJSON(null, { pane: PANE, renderer: L.canvas({ pane: PANE }), interactive: false,
            style: () => ({ color, weight: 1, opacity: 0.9, fill: false, dashArray: '4 3' }) }).addTo(map);
        return layer;
    }

    function show(features, bounds) {
        const added = mergePreview(byId, features, viewBounds(bounds));
        if (!added.length) return 0;
        ensureLayer()?.addData({ type: 'FeatureCollection', features: added });
        return added.length;
    }
    function clear() {
        byId.clear();
        layer?.clearLayers();
    }

    global.ParcelPreview = Object.freeze({ show, clear, count: () => byId.size, mergePreview, boundsOverlap });
    global.addEventListener?.('cityChanged', clear);
})(typeof window !== 'undefined' ? window : globalThis);
