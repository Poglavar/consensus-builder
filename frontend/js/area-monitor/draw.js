(function (global) {
    'use strict';

    const CLOSE_THRESHOLD_PX = 15;
    const POLYGON_STYLE = {
        color: '#2196F3',
        weight: 2,
        dashArray: '6, 4',
        fillColor: '#2196F3',
        fillOpacity: 0.08
    };
    const VERTEX_STYLE = {
        radius: 5,
        color: '#1565C0',
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 2
    };
    const FIRST_VERTEX_STYLE = {
        ...VERTEX_STYLE,
        radius: 7,
        color: '#E91E63',
        fillColor: '#E91E63',
        fillOpacity: 0.6
    };

    let active = false;
    let vertices = [];         // Array of L.LatLng
    let previewLayer = null;   // L.featureGroup for live preview
    let vertexMarkers = [];    // L.circleMarker[]
    let previewLine = null;    // L.polyline for in-progress drawing
    let cursorLine = null;     // L.polyline from last vertex to mouse

    function getMap() {
        return global.map;
    }

    function setDrawingModeActive(value) {
        global.areaMonitorDrawingMode = value;
    }

    function cleanupDrawingArtifacts() {
        const map = getMap();

        if (map) {
            map.off('click', onMapClick);
            map.off('mousemove', onMouseMove);
            map.getContainer().style.cursor = '';
        }

        document.removeEventListener('keydown', onKeyDown);

        if (previewLayer) {
            previewLayer.clearLayers();
            if (map) {
                map.removeLayer(previewLayer);
            }
            previewLayer = null;
        }

        previewLine = null;
        cursorLine = null;
        vertexMarkers = [];
        vertices = [];
    }

    function activate() {
        if (active) return;

        const map = getMap();
        if (!map) return;

        active = true;
        setDrawingModeActive(true);
        vertices = [];
        vertexMarkers = [];

        previewLayer = L.featureGroup().addTo(map);
        map.getContainer().style.cursor = 'crosshair';

        map.on('click', onMapClick);
        map.on('mousemove', onMouseMove);
        document.addEventListener('keydown', onKeyDown);

        global.dispatchEvent(new CustomEvent('areaMonitorDrawStart'));
    }

    function deactivate(options = {}) {
        if (!active) return;

        const suppressCancelEvent = options && options.suppressCancelEvent === true;
        active = false;
        setDrawingModeActive(false);
        cleanupDrawingArtifacts();

        if (!suppressCancelEvent) {
            global.dispatchEvent(new CustomEvent('areaMonitorDrawCancel'));
        }
    }

    function onMapClick(e) {
        if (!active) return;

        const latlng = e.latlng;

        // Check if clicking near first vertex to close
        if (vertices.length >= 3) {
            const map = getMap();
            const firstPoint = map.latLngToContainerPoint(vertices[0]);
            const clickPoint = map.latLngToContainerPoint(latlng);
            const dist = firstPoint.distanceTo(clickPoint);
            if (dist < CLOSE_THRESHOLD_PX) {
                closePolygon();
                return;
            }
        }

        vertices.push(latlng);
        addVertexMarker(latlng, vertices.length === 1);
        updatePreviewLine();
    }

    function onMouseMove(e) {
        if (!active || !vertices.length || !previewLayer) return;

        const lastVertex = vertices[vertices.length - 1];
        if (cursorLine) {
            cursorLine.setLatLngs([lastVertex, e.latlng]);
        } else {
            cursorLine = L.polyline([lastVertex, e.latlng], {
                color: '#2196F3',
                weight: 1.5,
                dashArray: '4, 4',
                opacity: 0.6
            }).addTo(previewLayer);
        }
    }

    function onKeyDown(e) {
        if (!active) return;

        if (e.key === 'Escape') {
            if (vertices.length > 0) {
                undoLastVertex();
            } else {
                deactivate();
            }
        }
    }

    function addVertexMarker(latlng, isFirst) {
        if (!previewLayer) return;
        const style = isFirst ? FIRST_VERTEX_STYLE : VERTEX_STYLE;
        const marker = L.circleMarker(latlng, style).addTo(previewLayer);
        vertexMarkers.push(marker);
    }

    function updatePreviewLine() {
        if (!previewLayer || vertices.length < 2) return;
        if (previewLine) {
            previewLine.setLatLngs(vertices);
        } else {
            previewLine = L.polyline(vertices, {
                color: POLYGON_STYLE.color,
                weight: POLYGON_STYLE.weight,
                dashArray: POLYGON_STYLE.dashArray
            }).addTo(previewLayer);
        }
    }

    function undoLastVertex() {
        if (!vertices.length) return;
        vertices.pop();
        const marker = vertexMarkers.pop();
        if (marker && previewLayer) previewLayer.removeLayer(marker);

        if (previewLine) {
            if (vertices.length < 2) {
                previewLayer.removeLayer(previewLine);
                previewLine = null;
            } else {
                previewLine.setLatLngs(vertices);
            }
        }

        if (cursorLine && !vertices.length) {
            previewLayer.removeLayer(cursorLine);
            cursorLine = null;
        }
    }

    function closePolygon() {
        if (vertices.length < 3) return;

        // Build GeoJSON polygon (lng, lat order)
        const coords = vertices.map(v => [v.lng, v.lat]);
        coords.push([vertices[0].lng, vertices[0].lat]); // close ring

        const polygon = {
            type: 'Polygon',
            coordinates: [coords]
        };

        // Find intersecting parcels
        const parcels = findParcelsInPolygon(polygon);

        deactivate({ suppressCancelEvent: true });

        global.dispatchEvent(new CustomEvent('areaMonitorDrawComplete', {
            detail: { polygon, parcels, vertices: coords }
        }));
    }

    function findParcelsInPolygon(polygon) {
        const parcelLayer = global.parcelLayer;
        if (!parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
            return [];
        }

        if (typeof turf === 'undefined') {
            console.warn('Turf.js not loaded, cannot compute parcel intersection');
            return [];
        }

        const polygonFeature = turf.polygon(polygon.coordinates);
        const matched = [];

        parcelLayer.eachLayer(layer => {
            const feature = layer.feature;
            if (!feature || !feature.geometry) return;

            const parcelId = global.getParcelId ? global.getParcelId(feature) : (feature.properties?.parcelId || feature.properties?.id);
            if (!parcelId) return;

            try {
                // Check if parcel intersects or is contained by the polygon
                if (turf.booleanIntersects(polygonFeature, feature) || turf.booleanContains(polygonFeature, feature)) {
                    matched.push({
                        parcelId: String(parcelId),
                        feature
                    });
                }
            } catch (_) {
                // Skip invalid geometries
            }
        });

        return matched;
    }

    // Public API
    global.AreaMonitorDraw = {
        activate,
        deactivate,
        isActive: () => active,
        getVertices: () => [...vertices],
        undoLastVertex,
        findParcelsInPolygon
    };
    global.isAreaMonitorDrawingActive = () => active;
    setDrawingModeActive(false);

    global.addEventListener('pagehide', () => {
        if (!active) return;
        active = false;
        setDrawingModeActive(false);
        cleanupDrawingArtifacts();
    });

})(typeof window !== 'undefined' ? window : globalThis);
