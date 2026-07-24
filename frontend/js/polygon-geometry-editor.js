// Shared Leaflet polygon editor used by block manual mode, freeform buildings, and row houses. It
// owns vertex dragging, edge-click insertion, selection, and deletion so every tool has one model.

(function (global, factory) {
    'use strict';

    const api = factory();
    if (typeof window !== 'undefined') {
        window.PolygonGeometryEditor = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function coordinatesEqual(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
    }

    function openRing(ring) {
        if (!Array.isArray(ring)) return [];
        const points = ring
            .filter(coord => Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1]))
            .map(coord => [coord[0], coord[1]]);
        if (points.length > 1 && coordinatesEqual(points[0], points[points.length - 1])) points.pop();
        return points;
    }

    function insertVertexAfterEdge(ring, edgeIndex, coordinate) {
        const points = openRing(ring);
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length) return null;
        if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
        points.splice(edgeIndex + 1, 0, [coordinate[0], coordinate[1]]);
        return points;
    }

    function removeVertexAt(ring, vertexIndex) {
        const points = openRing(ring);
        if (points.length <= 3) return null;
        if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= points.length) return null;
        points.splice(vertexIndex, 1);
        return points;
    }

    function nearestVertexIndex(ring, coordinate) {
        const points = openRing(ring);
        if (!Array.isArray(coordinate) || !points.length) return null;
        let nearestIndex = null;
        let nearestDistance = Infinity;
        points.forEach((point, index) => {
            const dx = point[0] - coordinate[0];
            const dy = point[1] - coordinate[1];
            const distance = dx * dx + dy * dy;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });
        return nearestIndex;
    }

    function planarRingArea(ring) {
        const points = openRing(ring);
        let twiceArea = 0;
        points.forEach((point, index) => {
            const next = points[(index + 1) % points.length];
            twiceArea += point[0] * next[1] - next[0] * point[1];
        });
        return Math.abs(twiceArea) / 2;
    }

    // Accept the usual GeoJSON wrappers and return the largest polygon's editable outer ring.
    // Keeping this here gives every polygon editor exactly the same import semantics.
    function extractOuterRingFromGeoJSON(input, turfApi) {
        const polygons = [];
        const collect = value => {
            if (!value || typeof value !== 'object') return;
            if (value.type === 'FeatureCollection') {
                (Array.isArray(value.features) ? value.features : []).forEach(collect);
            } else if (value.type === 'Feature') {
                collect(value.geometry);
            } else if (value.type === 'GeometryCollection') {
                (Array.isArray(value.geometries) ? value.geometries : []).forEach(collect);
            } else if (value.type === 'Polygon' && Array.isArray(value.coordinates)) {
                polygons.push(value.coordinates);
            } else if (value.type === 'MultiPolygon' && Array.isArray(value.coordinates)) {
                value.coordinates.forEach(coordinates => polygons.push(coordinates));
            }
        };
        collect(input);

        let largestRing = null;
        let largestArea = -Infinity;
        polygons.forEach(coordinates => {
            const ring = openRing(coordinates && coordinates[0]);
            if (ring.length < 3) return;
            let area = planarRingArea(ring);
            if (turfApi) {
                try {
                    const closed = ring.concat([[ring[0][0], ring[0][1]]]);
                    area = turfApi.area(turfApi.polygon([closed]));
                } catch (_) { }
            }
            if (area > largestArea) {
                largestArea = area;
                largestRing = ring;
            }
        });
        return largestRing;
    }

    // The clickable edge is intentionally wider than the visible line for touch/mouse usability.
    // Project the pointer back onto the real edge so insertion adds topology without unexpectedly
    // changing the footprint's shape just because the click landed a few pixels off-centre.
    function coordinateOnEdge(ring, edgeIndex, coordinate, turfApi) {
        const points = openRing(ring);
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length) return null;
        if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
        if (!turfApi) return [coordinate[0], coordinate[1]];
        try {
            const edge = turfApi.lineString([points[edgeIndex], points[(edgeIndex + 1) % points.length]]);
            const snapped = turfApi.nearestPointOnLine(edge, turfApi.point(coordinate));
            const snappedCoordinate = snapped && snapped.geometry && snapped.geometry.coordinates;
            if (Array.isArray(snappedCoordinate)) return [snappedCoordinate[0], snappedCoordinate[1]];
        } catch (_) { }
        return [coordinate[0], coordinate[1]];
    }

    function resolveBoundary(boundary) {
        try {
            return typeof boundary === 'function' ? boundary() : boundary;
        } catch (_) {
            return null;
        }
    }

    function lineFeatures(value) {
        if (!value) return [];
        if (value.type === 'FeatureCollection') return Array.isArray(value.features) ? value.features : [];
        return [value];
    }

    // Keep the existing block-manual behavior: an outside vertex follows the cursor while dragging,
    // then lands on the nearest parcel boundary only when the pointer is released.
    function snapCoordinateToBoundary(coordinate, boundary, turfApi) {
        if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
        const polygon = resolveBoundary(boundary);
        if (!polygon || !polygon.geometry || !turfApi) return [coordinate[0], coordinate[1]];

        try {
            const point = turfApi.point(coordinate);
            if (turfApi.booleanPointInPolygon(point, polygon)) return [coordinate[0], coordinate[1]];

            const boundaryLines = lineFeatures(turfApi.polygonToLine(polygon));
            let nearestCoordinate = null;
            let nearestDistance = Infinity;
            boundaryLines.forEach(line => {
                if (!line || !line.geometry) return;
                try {
                    const snapped = turfApi.nearestPointOnLine(line, point, { units: 'meters' });
                    const snappedCoordinate = snapped && snapped.geometry && snapped.geometry.coordinates;
                    if (!Array.isArray(snappedCoordinate)) return;
                    const distance = Number(snapped.properties && snapped.properties.dist);
                    const comparableDistance = Number.isFinite(distance)
                        ? distance
                        : turfApi.distance(point, snapped, { units: 'meters' });
                    if (comparableDistance < nearestDistance) {
                        nearestDistance = comparableDistance;
                        nearestCoordinate = [snappedCoordinate[0], snappedCoordinate[1]];
                    }
                } catch (_) { }
            });
            return nearestCoordinate || [coordinate[0], coordinate[1]];
        } catch (_) {
            return [coordinate[0], coordinate[1]];
        }
    }

    function largestPolygon(feature, turfApi) {
        if (!feature || !feature.geometry) return null;
        if (feature.geometry.type === 'Polygon') return feature;
        if (feature.geometry.type !== 'MultiPolygon' || !Array.isArray(feature.geometry.coordinates)) return null;
        let largest = null;
        let largestArea = -Infinity;
        feature.geometry.coordinates.forEach(coordinates => {
            try {
                const candidate = turfApi.polygon(coordinates);
                const area = turfApi.area(candidate);
                if (area > largestArea) {
                    largest = candidate;
                    largestArea = area;
                }
            } catch (_) { }
        });
        return largest;
    }

    // A vertex can be inside a concave boundary while one of its adjacent edges crosses outside.
    // Match block manual mode by clipping the completed ring on release instead of rejecting a
    // visually legal gesture because of boundary precision or a small concavity crossing.
    function constrainRingToBoundary(ring, boundary, turfApi) {
        const points = openRing(ring);
        const polygonBoundary = resolveBoundary(boundary);
        if (points.length < 3 || !polygonBoundary || !polygonBoundary.geometry || !turfApi) return null;
        try {
            const closed = points.concat([[points[0][0], points[0][1]]]);
            const footprint = turfApi.polygon([closed]);
            // Turf booleanWithin only checks polygon vertices in this case and can miss an edge
            // crossing the notch of a concave parcel. Difference measures the actual outside area.
            let outside = null;
            let outsideMeasured = false;
            try {
                outside = turfApi.difference(footprint, polygonBoundary);
                outsideMeasured = true;
            } catch (_) {
                if (turfApi.booleanWithin(footprint, polygonBoundary)) return points;
            }
            if (outsideMeasured && (!outside || turfApi.area(outside) <= 0.05)) return points;
            const clipped = largestPolygon(turfApi.intersect(footprint, polygonBoundary), turfApi);
            const clippedRing = clipped && clipped.geometry && clipped.geometry.coordinates[0];
            const constrained = openRing(clippedRing);
            return constrained.length >= 3 ? constrained : null;
        } catch (_) {
            return null;
        }
    }

    function isTextEditingTarget(target) {
        const tagName = target && target.tagName && String(target.tagName).toLowerCase();
        return !!(target && target.isContentEditable)
            || tagName === 'input'
            || tagName === 'textarea'
            || tagName === 'select';
    }

    class SharedPolygonEditor {
        constructor(options = {}) {
            this.options = options;
            this.map = options.map || null;
            this.L = options.leaflet || (typeof window !== 'undefined' ? window.L : null);
            this.turf = options.turf || (typeof window !== 'undefined' ? window.turf : null);
            this.document = options.document || (typeof document !== 'undefined' ? document : null);
            if (!this.map || !this.L) throw new Error('PolygonGeometryEditor requires a Leaflet map and API.');

            this.ring = openRing(typeof options.getRing === 'function' ? options.getRing() : options.ring);
            const initialSelectedIndex = options.initialSelectedVertexIndex;
            this.selectedVertexIndex = Number.isInteger(initialSelectedIndex)
                && initialSelectedIndex >= 0
                && initialSelectedIndex < this.ring.length
                ? initialSelectedIndex
                : null;
            this.vertexMarkers = [];
            this.layerGroup = null;
            this.liveLayer = null;
            this.deleteMarker = null;
            this.deleteActionVisible = this.selectedVertexIndex !== null && options.showInitialDeleteAction === true;
            this.destroyed = false;
            this.boundKeydown = event => this.handleKeydown(event);
            this.boundMapClick = () => this.hideDeleteAction({ clearSelection: true });

            if (this.document) this.document.addEventListener('keydown', this.boundKeydown);
            if (typeof this.map.on === 'function') this.map.on('click', this.boundMapClick);
        }

        readExternalRing() {
            if (typeof this.options.getRing !== 'function') return this.ring;
            const externalRing = openRing(this.options.getRing());
            return externalRing.length >= 3 ? externalRing : this.ring;
        }

        emit(callbackName, reason, vertexIndex) {
            const callback = this.options[callbackName];
            if (typeof callback !== 'function') return undefined;
            return callback({
                ring: openRing(this.ring),
                reason,
                vertexIndex,
                editor: this
            });
        }

        createVertexIcon(vertexIndex) {
            const selected = vertexIndex === this.selectedVertexIndex;
            const className = [
                this.options.markerClassName || 'blockify-handle blockify-handle--vertex',
                'polygon-geometry-editor__vertex',
                selected ? 'is-selected' : ''
            ].filter(Boolean).join(' ');
            return this.L.divIcon({
                className,
                html: this.options.markerHtml || '<span></span>',
                iconSize: this.options.iconSize || [24, 24],
                iconAnchor: this.options.iconAnchor || [12, 12]
            });
        }

        deleteIconAnchor(coordinate) {
            if (Array.isArray(this.options.deleteIconAnchor)) return this.options.deleteIconAnchor;
            let anchorX = -9; // negative anchor places the icon just to the right of the vertex
            let anchorY = 13;
            try {
                if (typeof this.map.latLngToContainerPoint === 'function' && typeof this.map.getSize === 'function') {
                    const point = this.map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
                    const size = this.map.getSize();
                    if (point && size && point.x > size.x - 42) anchorX = 35;
                    if (point && point.y < 32) anchorY = -9;
                }
            } catch (_) { }
            return [anchorX, anchorY];
        }

        removeDeleteMarker() {
            if (!this.deleteMarker) return;
            try {
                if (this.layerGroup && typeof this.layerGroup.removeLayer === 'function') {
                    this.layerGroup.removeLayer(this.deleteMarker);
                } else if (this.map) {
                    this.map.removeLayer(this.deleteMarker);
                }
            } catch (_) { }
            this.deleteMarker = null;
        }

        refreshVertexSelectionStyles() {
            this.vertexMarkers.forEach((marker, index) => {
                const element = typeof marker.getElement === 'function' ? marker.getElement() : marker._icon;
                if (element && element.classList) element.classList.toggle('is-selected', index === this.selectedVertexIndex);
            });
        }

        hideDeleteAction(options = {}) {
            this.deleteActionVisible = false;
            this.removeDeleteMarker();
            if (options.clearSelection) {
                this.selectedVertexIndex = null;
                this.refreshVertexSelectionStyles();
            }
        }

        showDeleteAction() {
            this.removeDeleteMarker();
            const canDelete = this.options.showDeleteAction !== false
                && Number.isInteger(this.selectedVertexIndex)
                && this.selectedVertexIndex >= 0
                && this.selectedVertexIndex < this.ring.length
                && this.ring.length > 3
                && this.layerGroup;
            this.deleteActionVisible = !!canDelete;
            if (!canDelete) return;

            const coordinate = this.ring[this.selectedVertexIndex];
            const title = this.options.deleteTitle || 'Delete selected vertex';
            const marker = this.L.marker([coordinate[1], coordinate[0]], {
                keyboard: true,
                interactive: true,
                title,
                alt: title,
                bubblingMouseEvents: false,
                zIndexOffset: 2000,
                icon: this.L.divIcon({
                    className: 'polygon-geometry-editor__delete-marker',
                    html: '<span aria-hidden="true">&#128465;</span>',
                    iconSize: [26, 26],
                    iconAnchor: this.deleteIconAnchor(coordinate)
                })
            }).addTo(this.layerGroup);
            marker.on('mousedown', event => this.stopLeafletEvent(event));
            marker.on('touchstart', event => this.stopLeafletEvent(event));
            marker.on('click', event => {
                this.stopLeafletEvent(event);
                this.removeSelectedVertex();
            });
            const element = typeof marker.getElement === 'function' ? marker.getElement() : marker._icon;
            if (element) {
                try {
                    element.setAttribute('role', 'button');
                    element.setAttribute('aria-label', title);
                } catch (_) { }
            }
            this.deleteMarker = marker;
        }

        clearLayers() {
            if (this.liveLayer && this.map) {
                try { this.map.removeLayer(this.liveLayer); } catch (_) { }
            }
            this.liveLayer = null;
            if (this.layerGroup && this.map) {
                try { this.map.removeLayer(this.layerGroup); } catch (_) { }
            }
            this.layerGroup = null;
            this.vertexMarkers = [];
            this.deleteMarker = null;
        }

        render(options = {}) {
            if (this.destroyed) return this;
            if (options.refreshRing !== false) this.ring = openRing(this.readExternalRing());
            if (this.selectedVertexIndex !== null && this.selectedVertexIndex >= this.ring.length) {
                this.selectedVertexIndex = null;
                this.deleteActionVisible = false;
            }
            this.clearLayers();
            if (this.ring.length < 3) return this;

            this.layerGroup = this.L.layerGroup().addTo(this.map);
            this.ring.forEach((coordinate, edgeIndex) => {
                const next = this.ring[(edgeIndex + 1) % this.ring.length];
                const edge = this.L.polyline([
                    [coordinate[1], coordinate[0]],
                    [next[1], next[0]]
                ], {
                    className: 'polygon-geometry-editor__edge',
                    color: '#000000',
                    opacity: 0,
                    weight: Number(this.options.edgeHitWidth) || 18,
                    interactive: true,
                    bubblingMouseEvents: false
                }).addTo(this.layerGroup);
                edge.on('click', event => this.handleEdgeClick(edgeIndex, event));
            });

            this.ring.forEach(([lng, lat], vertexIndex) => {
                const marker = this.L.marker([lat, lng], {
                    draggable: true,
                    keyboard: true,
                    title: this.options.vertexTitle || 'Drag to reshape',
                    icon: this.createVertexIcon(vertexIndex),
                    bubblingMouseEvents: false,
                    autoPan: true
                }).addTo(this.layerGroup);
                marker.on('click', event => {
                    this.stopLeafletEvent(event);
                    this.selectVertex(vertexIndex);
                });
                marker.on('dragstart', event => this.handleVertexDragStart(vertexIndex, event));
                marker.on('drag', event => this.handleVertexDrag(vertexIndex, event));
                marker.on('dragend', event => this.handleVertexDragEnd(vertexIndex, event));
                this.vertexMarkers.push(marker);
            });

            if (this.deleteActionVisible) this.showDeleteAction();
            try { this.layerGroup.bringToFront(); } catch (_) { }
            return this;
        }

        stopLeafletEvent(event) {
            try {
                const original = event && event.originalEvent;
                if (original && this.L.DomEvent) this.L.DomEvent.stop(original);
            } catch (_) { }
        }

        selectVertex(vertexIndex, options = {}) {
            const nextIndex = Number.isInteger(vertexIndex) ? vertexIndex : null;
            const alreadyShowingHere = nextIndex === this.selectedVertexIndex && !!this.deleteMarker;
            this.selectedVertexIndex = nextIndex;
            this.refreshVertexSelectionStyles();
            if (options.showDeleteAction === false || this.selectedVertexIndex === null) {
                this.hideDeleteAction();
            } else if (alreadyShowingHere) {
                this.deleteActionVisible = true;
            } else {
                this.showDeleteAction();
            }
        }

        drawLiveOutline() {
            if (this.liveLayer && this.map) {
                try { this.map.removeLayer(this.liveLayer); } catch (_) { }
            }
            this.liveLayer = null;
            if (this.ring.length < 3) return;
            const style = Object.assign({
                color: '#fb8c00',
                weight: 2,
                dashArray: '5,5',
                fill: false,
                interactive: false
            }, this.options.liveStyle || {});
            this.liveLayer = this.L.polygon(this.ring.map(([lng, lat]) => [lat, lng]), style).addTo(this.map);
        }

        handleVertexDragStart(vertexIndex, event) {
            this.stopLeafletEvent(event);
            this.hideDeleteAction({ clearSelection: true });
            this.emit('onDragStart', 'move', vertexIndex);
        }

        handleVertexDrag(vertexIndex, event) {
            if (this.destroyed || !event || !event.target || typeof event.target.getLatLng !== 'function') return;
            const latLng = event.target.getLatLng();
            if (!latLng || !Number.isFinite(latLng.lng) || !Number.isFinite(latLng.lat)) return;
            this.ring[vertexIndex] = [latLng.lng, latLng.lat];
            this.drawLiveOutline();
            this.emit('onLiveChange', 'move', vertexIndex);
        }

        handleVertexDragEnd(vertexIndex, event) {
            if (this.destroyed) return;
            const latLng = event && event.target && typeof event.target.getLatLng === 'function'
                ? event.target.getLatLng()
                : null;
            const rawCoordinate = latLng
                ? [latLng.lng, latLng.lat]
                : this.ring[vertexIndex];
            const coordinate = snapCoordinateToBoundary(rawCoordinate, this.options.boundary, this.turf);
            if (coordinate) this.ring[vertexIndex] = coordinate;
            const constrainedRing = constrainRingToBoundary(this.ring, this.options.boundary, this.turf);
            if (constrainedRing) this.ring = constrainedRing;
            if (coordinate && event && event.target && typeof event.target.setLatLng === 'function') {
                event.target.setLatLng([coordinate[1], coordinate[0]]);
            }
            if (this.liveLayer && this.map) {
                try { this.map.removeLayer(this.liveLayer); } catch (_) { }
            }
            this.liveLayer = null;
            const releasedVertexIndex = nearestVertexIndex(this.ring, coordinate) ?? vertexIndex;
            this.emit('onCommit', 'move', releasedVertexIndex);
            if (!this.destroyed) {
                this.selectedVertexIndex = Number.isInteger(releasedVertexIndex)
                    && releasedVertexIndex >= 0
                    && releasedVertexIndex < this.ring.length
                    ? releasedVertexIndex
                    : null;
                this.deleteActionVisible = this.selectedVertexIndex !== null;
                this.render({ refreshRing: false });
            }
        }

        handleEdgeClick(edgeIndex, event) {
            this.stopLeafletEvent(event);
            const latLng = event && event.latlng;
            if (!latLng || !Number.isFinite(latLng.lng) || !Number.isFinite(latLng.lat)) return;
            const coordinate = coordinateOnEdge(this.ring, edgeIndex, [latLng.lng, latLng.lat], this.turf);
            const inserted = insertVertexAfterEdge(this.ring, edgeIndex, coordinate);
            if (!inserted) return;
            const insertedIndex = edgeIndex + 1;
            this.ring = inserted;
            this.hideDeleteAction({ clearSelection: true });
            this.emit('onCommit', 'insert', insertedIndex);
            if (!this.destroyed) this.render({ refreshRing: false });
        }

        removeSelectedVertex() {
            const removed = removeVertexAt(this.ring, this.selectedVertexIndex);
            if (!removed) return false;
            const removedIndex = this.selectedVertexIndex;
            this.ring = removed;
            const constrainedRing = constrainRingToBoundary(this.ring, this.options.boundary, this.turf);
            if (constrainedRing) this.ring = constrainedRing;
            this.hideDeleteAction({ clearSelection: true });
            this.emit('onCommit', 'remove', removedIndex);
            if (!this.destroyed) this.render({ refreshRing: false });
            return true;
        }

        handleKeydown(event) {
            if (this.destroyed || !event || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
            if (isTextEditingTarget(event.target) || !Number.isInteger(this.selectedVertexIndex)) return;
            if (this.ring.length <= 3) return;
            event.preventDefault();
            this.removeSelectedVertex();
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.clearLayers();
            if (this.document) this.document.removeEventListener('keydown', this.boundKeydown);
            if (typeof this.map.off === 'function') this.map.off('click', this.boundMapClick);
            this.deleteMarker = null;
            this.deleteActionVisible = false;
            this.selectedVertexIndex = null;
        }
    }

    function create(options) {
        const editor = new SharedPolygonEditor(options);
        return editor.render();
    }

    return {
        create,
        openRing,
        coordinateOnEdge,
        constrainRingToBoundary,
        extractOuterRingFromGeoJSON,
        insertVertexAfterEdge,
        removeVertexAt,
        snapCoordinateToBoundary
    };
});
