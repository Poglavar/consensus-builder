// Deep zoom while a road is being edited. Leaflet takes the map's zoom ceiling from its tile layers,
// and OpenStreetMap stops at 19 — about 0.2 m per pixel, which is coarse for placing a centerline or
// reading a footway edge against a facade. Editing a corridor turns the ceiling up (the tiles stop at
// their own native zoom and get upscaled; the vector overlays stay crisp), and leaving turns it back.
//
// Turning it back is the delicate half: dropping the ceiling under someone who is zoomed past it
// either yanks their view or blanks the basemap, so the restore waits until the view comes back
// within the basemap's own range on its own.
(function (global) {
    'use strict';

    const DEEP_ZOOM = 22;

    // What a tile layer needs so it keeps drawing above its own range: its declared maximum IS its
    // native tile limit, so Leaflet should keep requesting tiles at that zoom and upscale them past
    // it. A layer that already reaches the deep ceiling needs nothing. Returns null for "leave alone".
    function roadEditingZoomLayerPatch(options, deepZoom) {
        if (!options || !Number.isFinite(options.maxZoom) || options.maxZoom >= deepZoom) return null;
        return {
            maxZoom: deepZoom,
            // An explicit native zoom is the layer's own statement about its tiles; never overwrite it.
            maxNativeZoom: Number.isFinite(options.maxNativeZoom) ? options.maxNativeZoom : options.maxZoom
        };
    }

    // Restoring the ceiling below the current zoom would clamp the view (a jump) or leave the tile
    // layer out of range (a blank map), so a zoomed-in user keeps the deep ceiling until they come back.
    function roadEditingZoomShouldDefer(currentZoom, baselineMaxZoom) {
        return Number.isFinite(currentZoom) && Number.isFinite(baselineMaxZoom) && currentZoom > baselineMaxZoom + 1e-9;
    }

    // Reasons are a SET, not a count: enter/exit are then idempotent, and two overlapping editing
    // surfaces (the cross-section editor opened over a drawing) cannot leave the count off by one.
    const reasons = new Set();
    let active = false;
    let touched = [];
    let baselineOptionMaxZoom;
    let baselineMaxZoom = null;

    const mapOf = () => (global.map && typeof global.map.getMaxZoom === 'function') ? global.map : null;

    function patchLayer(layer) {
        // Tile layers only — getTileUrl is what separates them from the vector grid layers.
        if (!layer || !layer.options || typeof layer.getTileUrl !== 'function') return;
        const patch = roadEditingZoomLayerPatch(layer.options, DEEP_ZOOM);
        if (!patch) return;
        touched.push({ layer, maxZoom: layer.options.maxZoom, maxNativeZoom: layer.options.maxNativeZoom });
        layer.options.maxNativeZoom = patch.maxNativeZoom;
        layer.options.maxZoom = patch.maxZoom;
    }

    // A basemap switched mid-edit arrives with its own ceiling and would blank out above it.
    function onLayerAdd(event) {
        if (active) patchLayer(event && event.layer);
    }

    function applyDeepZoom() {
        const map = mapOf();
        if (!map || active) return;
        active = true;
        touched = [];
        baselineOptionMaxZoom = map.options.maxZoom; // often undefined: derived from the layers
        baselineMaxZoom = map.getMaxZoom();
        map.eachLayer(patchLayer);
        map.on('layeradd', onLayerAdd);
        map.options.maxZoom = DEEP_ZOOM;
        map.fire('zoomlevelschange');
    }

    function restoreDeepZoom() {
        const map = mapOf();
        if (!map || !active) return;
        touched.forEach(entry => {
            entry.layer.options.maxZoom = entry.maxZoom;
            if (entry.maxNativeZoom === undefined) delete entry.layer.options.maxNativeZoom;
            else entry.layer.options.maxNativeZoom = entry.maxNativeZoom;
        });
        touched = [];
        map.off('layeradd', onLayerAdd);
        map.off('zoomend', settle);
        if (baselineOptionMaxZoom === undefined) delete map.options.maxZoom;
        else map.options.maxZoom = baselineOptionMaxZoom;
        active = false;
        map.fire('zoomlevelschange');
    }

    // Restore when nothing is holding the deep ceiling and the view is back inside the basemap's
    // own range; otherwise wait for the zoom that brings it back.
    function settle() {
        const map = mapOf();
        if (!map || !active || reasons.size) return;
        if (roadEditingZoomShouldDefer(map.getZoom(), baselineMaxZoom)) {
            map.off('zoomend', settle);
            map.on('zoomend', settle);
            return;
        }
        restoreDeepZoom();
    }

    function enter(reason) {
        reasons.add(String(reason || 'road-editing'));
        applyDeepZoom();
        const map = mapOf();
        if (map) map.off('zoomend', settle);
    }

    function exit(reason) {
        reasons.delete(String(reason || 'road-editing'));
        if (!reasons.size) settle();
    }

    if (global.document && typeof global.document.addEventListener === 'function') {
        // Drawing a corridor is road editing too, and it already announces itself.
        global.document.addEventListener('corridor-drawing-mode-changed', event => {
            if (event && event.detail && event.detail.road) enter('drawing');
            else exit('drawing');
        });
    }

    const api = {
        enter,
        exit,
        isActive: () => active,
        roadEditingZoomLayerPatch,
        roadEditingZoomShouldDefer,
        DEEP_ZOOM
    };

    global.RoadEditingZoom = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
