// Vertex-click mode for creating area monitors from the government road plan.
// User clicks plan vertices to build a closed polygon. Lines may not cross each other.
// Clicking the first vertex again (when ≥3 vertices selected) closes the shape.

(function (global) {
    'use strict';

    const V_NORMAL   = { radius: 4, color: '#e65100', weight: 1, fillColor: '#ff9800', fillOpacity: 0.85 };
    const V_HOVER    = { radius: 6, color: '#e65100', weight: 2, fillColor: '#ffcc02', fillOpacity: 1    };
    const V_SELECTED = { radius: 6, color: '#1565C0', weight: 2, fillColor: '#1E88E5', fillOpacity: 1    };
    const V_FIRST    = { radius: 7, color: '#1b5e20', weight: 2, fillColor: '#4caf50', fillOpacity: 1    }; // green = click to close
    const V_REJECTED = { radius: 5, color: '#b71c1c', weight: 2, fillColor: '#ef5350', fillOpacity: 1    };
    const PANE_NAME  = 'amVertexPane';

    // State
    let active = false;
    let allPlanCoords = null;        // all [lng, lat] from plan layer (cached)
    let vertexLayer  = null;         // LayerGroup of CircleMarkers for current viewport
    let viewportMarkers = new Map(); // coordKey -> CircleMarker for current viewport
    let path = [];                   // [lng, lat] arrays in order
    let closed = false;
    let polylineLayer = null;
    let polygonFillLayer = null;
    let _mapLayerAddWatcher = null;  // cleanup ref for when we watch map for plan layer creation

    function getMap() { return global.map; }

    function coordKey(lng, lat) { return lng + ',' + lat; }

    // --- Geometry: segment intersection (no turf needed) ---

    function cross2d(o, a, b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    function segmentsIntersect(p1, p2, p3, p4) {
        // Proper intersection only (excludes shared endpoints)
        const d1 = cross2d(p3, p4, p1), d2 = cross2d(p3, p4, p2);
        const d3 = cross2d(p1, p2, p3), d4 = cross2d(p1, p2, p4);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
               ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }

    function wouldIntersectPath(newPt, checkClosing) {
        const from = checkClosing ? path[path.length - 1] : path[path.length - 1];
        const to   = checkClosing ? path[0] : newPt;
        // When adding a new segment (from last → newPt), skip the segment that
        // shares the 'from' endpoint (index path.length-2 → path.length-1).
        // When closing (from last → first), skip segments touching either endpoint.
        const skipStart = checkClosing ? 1           : path.length - 2;
        const skipEnd   = checkClosing ? path.length - 2 : path.length - 2;
        for (let i = 0; i < path.length - 1; i++) {
            if (i >= skipStart && i <= skipEnd) continue;
            if (segmentsIntersect(from, to, path[i], path[i + 1])) return true;
        }
        return false;
    }

    // --- Plan vertex extraction ---

    function buildAllPlanCoords() {
        const layer = global.governmentRoadPlanLayer;
        if (!layer || typeof layer.eachLayer !== 'function') { allPlanCoords = []; return; }
        const coords = [];
        layer.eachLayer(sublayer => {
            try {
                const lls = sublayer.getLatLngs();
                const flat = Array.isArray(lls[0]) ? lls.flat(Infinity) : lls;
                for (const ll of flat) coords.push([ll.lng, ll.lat]);
            } catch (_) {}
        });
        allPlanCoords = coords;
        console.log('[PlanMode] total plan vertices: %d', coords.length);
        if (coords.length > 0) global.dispatchEvent(new CustomEvent('planVerticesReady'));
    }

    // If the plan has no data yet when we activate, listen for its first layeradd
    // so vertices render immediately when data arrives without requiring a map move.
    function watchForPlanData() {
        const layer = global.governmentRoadPlanLayer;

        if (layer) {
            // Layer object exists but is empty — wait for first sublayer.
            // Leaflet fires layeradd once per addLayer() call and GeoJSON adds all features
            // synchronously, so the once-callback only sees the first sublayer. Defer with
            // requestAnimationFrame so the full addData() loop completes first.
            layer.once('layeradd', () => {
                requestAnimationFrame(() => {
                    if (!active) return;
                    buildAllPlanCoords();
                    if (allPlanCoords && allPlanCoords.length > 0) renderVertexDots();
                });
            });
            return;
        }

        // governmentRoadPlanLayer is null — drawGovernmentRoadPlan() is async and hasn't
        // created the layer yet. Watch the map for any layer being added; once the plan
        // layer appears, defer one frame so addData() can finish populating it.
        const map = getMap();
        function onMapLayerAdd() {
            if (!active) {
                map.off('layeradd', onMapLayerAdd);
                _mapLayerAddWatcher = null;
                return;
            }
            if (!global.governmentRoadPlanLayer) return; // not the plan layer yet
            map.off('layeradd', onMapLayerAdd);
            _mapLayerAddWatcher = null;
            requestAnimationFrame(() => {
                if (!active) return;
                buildAllPlanCoords();
                if (allPlanCoords && allPlanCoords.length > 0) renderVertexDots();
            });
        }
        map.on('layeradd', onMapLayerAdd);
        _mapLayerAddWatcher = onMapLayerAdd;
    }

    // --- Vertex rendering ---

    function styleForCoord(lng, lat) {
        if (!path.length) return V_NORMAL;
        const key = coordKey(lng, lat);
        if (coordKey(path[0][0], path[0][1]) === key) return path.length >= 3 ? V_FIRST : V_SELECTED;
        for (let i = 1; i < path.length; i++) {
            if (coordKey(path[i][0], path[i][1]) === key) return V_SELECTED;
        }
        return V_NORMAL;
    }

    function isInPath(key) {
        return path.some(pt => coordKey(pt[0], pt[1]) === key);
    }

    function ensureVertexPane() {
        const map = getMap();
        if (!map.getPane(PANE_NAME)) {
            // z-index 650: above overlay pane (400) and marker pane (600), so clicks reach vertices first.
            map.createPane(PANE_NAME).style.zIndex = 650;
        }
    }

    function renderVertexDots() {
        const map = getMap();
        if (!map) return;
        if (!allPlanCoords || allPlanCoords.length === 0) {
            buildAllPlanCoords();
            if (!allPlanCoords || allPlanCoords.length === 0) return;
        }

        if (vertexLayer) map.removeLayer(vertexLayer);
        vertexLayer = L.layerGroup();
        viewportMarkers = new Map();

        const b = map.getBounds();
        const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();

        for (const [lng, lat] of allPlanCoords) {
            if (lat < s || lat > n || lng < w || lng > e) continue;
            const key = coordKey(lng, lat);
            const style = styleForCoord(lng, lat);
            const marker = L.circleMarker([lat, lng], { ...style, pane: PANE_NAME });
            marker.on('click',     makeVertexClickHandler(lng, lat, marker));
            marker.on('mouseover', () => { if (!isInPath(key)) marker.setStyle(V_HOVER); map.getContainer().style.cursor = 'pointer'; });
            marker.on('mouseout',  () => { marker.setStyle(styleForCoord(lng, lat)); map.getContainer().style.cursor = 'crosshair'; });
            viewportMarkers.set(key, marker);
            vertexLayer.addLayer(marker);
        }
        vertexLayer.addTo(map);
    }

    function refreshMarkerStyles() {
        for (const [key, marker] of viewportMarkers) {
            const [lng, lat] = key.split(',').map(Number);
            marker.setStyle(styleForCoord(lng, lat));
        }
    }

    // --- Vertex click handler ---

    function makeVertexClickHandler(lng, lat, marker) {
        return function (e) {
            L.DomEvent.stopPropagation(e);
            if (closed) return;

            const key = coordKey(lng, lat);
            const firstKey = path.length > 0 ? coordKey(path[0][0], path[0][1]) : null;

            // Click first vertex → close polygon
            if (firstKey && key === firstKey && path.length >= 3) {
                if (wouldIntersectPath(null, true)) {
                    flashMarker(marker);
                    return;
                }
                closePath();
                return;
            }

            // Click last vertex → undo it
            if (path.length > 1) {
                const lastKey = coordKey(path[path.length - 1][0], path[path.length - 1][1]);
                if (key === lastKey) {
                    removeLastVertex();
                    return;
                }
            }

            // Already in path (not first, not last) → ignore
            for (const pt of path) {
                if (coordKey(pt[0], pt[1]) === key) return;
            }

            // New vertex — check intersection
            if (path.length >= 2 && wouldIntersectPath([lng, lat], false)) {
                flashMarker(marker);
                return;
            }

            addVertex(lng, lat);
        };
    }

    function flashMarker(marker) {
        marker.setStyle(V_REJECTED);
        setTimeout(() => {
            const [lng, lat] = [marker.getLatLng().lng, marker.getLatLng().lat];
            marker.setStyle(styleForCoord(lng, lat));
        }, 400);
    }

    function addVertex(lng, lat) {
        path.push([lng, lat]);
        refreshMarkerStyles();
        updatePolyline();
    }

    function removeLastVertex() {
        if (!path.length) return;
        path.pop();
        refreshMarkerStyles();
        updatePolyline();
    }

    // Find parcel layers that intersect the given GeoJSON Polygon.
    function findParcelsInPolygon(polygon) {
        if (typeof turf === 'undefined' || !global.parcelLayer) return [];
        const polygonFeature = turf.feature(polygon);
        const [minX, minY, maxX, maxY] = turf.bbox(polygonFeature);
        const matched = [];
        global.parcelLayer.eachLayer(layer => {
            if (!layer.feature) return;
            const props = layer.feature.properties || {};
            const parcelId = global.getParcelId ? global.getParcelId(layer.feature) : (props.parcelId || props.parcel_id);
            if (!parcelId) return;
            const b = layer.getBounds ? layer.getBounds() : null;
            if (b && (b.getEast() < minX || b.getWest() > maxX || b.getNorth() < minY || b.getSouth() > maxY)) return;
            try {
                if (turf.booleanIntersects(polygonFeature, layer.feature)) {
                    matched.push({ parcelId: String(parcelId), feature: layer.feature });
                }
            } catch (_) {}
        });
        return matched;
    }

    function closePath() {
        // Build polygon before deactivate() resets path
        const ring = path.map(([lng, lat]) => [lng, lat]);
        ring.push(ring[0]);
        const polygon = { type: 'Polygon', coordinates: [ring] };
        const parcels = findParcelsInPolygon(polygon);

        // Brief fill so the user sees the closed shape before the modal opens
        const map = getMap();
        const lls = path.map(([lng, lat]) => [lat, lng]);
        polygonFillLayer = L.polygon(lls, {
            color: '#1565C0', weight: 2, fillColor: '#1E88E5', fillOpacity: 0.25
        }).addTo(map);
        if (polylineLayer) { map.removeLayer(polylineLayer); polylineLayer = null; }

        deactivate();

        global.dispatchEvent(new CustomEvent('areaMonitorDrawComplete', {
            detail: { polygon, parcels, source: 'paint' }
        }));
    }

    // --- Polyline ---

    function updatePolyline() {
        const map = getMap();
        if (polylineLayer) { map.removeLayer(polylineLayer); polylineLayer = null; }
        if (path.length < 2) return;
        const lls = path.map(([lng, lat]) => [lat, lng]);
        polylineLayer = L.polyline(lls, { color: '#1565C0', weight: 2, dashArray: '4 4' }).addTo(map);
    }

    // --- ESC key ---

    function onKeyDown(e) {
        if (!active) return;
        if (e.key === 'Escape') deactivate();
    }

    // --- Map move ---

    function onMapMove() { if (active) renderVertexDots(); }

    // --- Activation / deactivation ---

    function activate() {
        if (active) return;
        if (!getMap()) return;
        active = true;
        path = [];
        closed = false;
        allPlanCoords = null;
        ensureVertexPane();
        buildAllPlanCoords();
        if (allPlanCoords && allPlanCoords.length > 0) {
            renderVertexDots();
        } else {
            watchForPlanData();
        }
        getMap().on('moveend', onMapMove);
        getMap().getContainer().style.cursor = 'crosshair';
        document.addEventListener('keydown', onKeyDown);
    }

    function deactivate() {
        if (!active) return;
        active = false;
        const map = getMap();
        map.off('moveend', onMapMove);
        if (_mapLayerAddWatcher) {
            map.off('layeradd', _mapLayerAddWatcher);
            _mapLayerAddWatcher = null;
        }
        map.getContainer().style.cursor = '';
        document.removeEventListener('keydown', onKeyDown);
        if (vertexLayer)      { map.removeLayer(vertexLayer);      vertexLayer = null; }
        if (polylineLayer)    { map.removeLayer(polylineLayer);    polylineLayer = null; }
        if (polygonFillLayer) { map.removeLayer(polygonFillLayer); polygonFillLayer = null; }
        viewportMarkers = new Map();
        allPlanCoords = null;
        path = [];
        closed = false;
    }

    // --- Public API ---

    function getPolygon() {
        if (!closed || path.length < 3) return null;
        // Build a closed GeoJSON Polygon ring [lng, lat] with first === last.
        const ring = path.map(([lng, lat]) => [lng, lat]);
        ring.push(ring[0]);
        return { type: 'Polygon', coordinates: [ring] };
    }

    global.AreaMonitorPaint = {
        activate,
        deactivate,
        isActive: () => active,
        isClosed: () => closed,
        getPolygon,
        undoLastVertex: removeLastVertex
    };

})(typeof window !== 'undefined' ? window : globalThis);
