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

    function ringsEqual(a, b) {
        const left = openRing(a);
        const right = openRing(b);
        return left.length === right.length && left.every((point, index) => coordinatesEqual(point, right[index]));
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

    // Accept the usual GeoJSON wrappers without selecting a preferred footprint. Each disconnected
    // Polygon becomes a building; every interior ring and source property stays with its exterior.
    // Reject the whole file on malformed or non-polygon content instead of silently losing it.
    function polygonFeaturesFromGeoJSON(input) {
        const features = [];
        const clone = value => JSON.parse(JSON.stringify(value));
        const polygon = (coordinates, source) => {
            if (!Array.isArray(coordinates) || !coordinates.length) throw new Error('A footprint needs an exterior ring.');
            const rings = coordinates.map(ring => {
                if (!Array.isArray(ring) || ring.length < 3 || ring.some(position => !Array.isArray(position)
                    || position.length < 2 || position.some(value => !Number.isFinite(value))
                    || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90)) {
                    throw new Error('A footprint contains invalid longitude/latitude coordinates.');
                }
                const result = clone(ring);
                if (!coordinatesEqual(result[0], result[result.length - 1])) result.push(clone(result[0]));
                if (result.length < 4) throw new Error('A footprint ring needs three vertices.');
                return result;
            });
            features.push({ ...clone(source), type: 'Feature', properties: clone(source.properties || {}),
                geometry: { type: 'Polygon', coordinates: rings } });
        };
        const collect = (value, source = { properties: {} }) => {
            if (!value || typeof value !== 'object') throw new Error('Missing GeoJSON geometry.');
            if (value.type === 'FeatureCollection' && Array.isArray(value.features)) value.features.forEach(feature => collect(feature));
            else if (value.type === 'Feature') collect(value.geometry, value);
            else if (value.type === 'GeometryCollection' && Array.isArray(value.geometries)) value.geometries.forEach(geometry => collect(geometry, source));
            else if (value.type === 'Polygon') polygon(value.coordinates, source);
            else if (value.type === 'MultiPolygon' && Array.isArray(value.coordinates) && value.coordinates.length) {
                value.coordinates.forEach(coordinates => polygon(coordinates, source));
            } else throw new Error('GeoJSON must contain only Polygon or MultiPolygon footprints.');
        };
        collect(input);
        if (!features.length) throw new Error('No polygon footprints found.');
        return features;
    }

    // One connected area from a GeoJSON file (WGS84 longitude/latitude), for tools whose shape is a
    // single area (a site, a park/square/lake boundary). Every polygon is unioned and holes are kept;
    // separate areas are refused with error.code 'disconnected', anything else as polygonFeaturesFromGeoJSON.
    function areaGeometryFromGeoJSON(input, turfApi) {
        const features = polygonFeaturesFromGeoJSON(input);
        let merged = features[0];
        for (let index = 1; index < features.length; index++) {
            const next = turfApi.union(merged, features[index]);
            if (!next || !next.geometry) throw new Error('The polygons could not be joined.');
            merged = next;
        }
        let geometry = merged.geometry;
        if (geometry.type === 'MultiPolygon') {
            if (geometry.coordinates.length !== 1) {
                throw Object.assign(new Error('The polygons form separate areas.'), { code: 'disconnected' });
            }
            geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
        }
        return { type: 'Polygon', coordinates: JSON.parse(JSON.stringify(geometry.coordinates)) };
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
            if (global.SingleBuildingGeometry?.footprintWithinBoundary?.(
                footprint,
                polygonBoundary,
                turfApi
            )) return points;
            let hit = null;
            try { hit = turfApi.intersect(footprint, polygonBoundary); } catch (error) {
                // The ring cannot be constrained, so the gesture is refused (null) — and reported.
                const api = (typeof window !== 'undefined' ? window : globalThis).__parcelArrangement
                    || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
                if (api) api.reportClipFailure('intersect', error, { site: 'polygon-geometry-editor.constrainRingToBoundary' }, [footprint, polygonBoundary]);
                else console.error(`[${new Date().toISOString()}] [clip] intersect failed at polygon-geometry-editor.constrainRingToBoundary`, error);
                return null;
            }
            const clipped = largestPolygon(hit, turfApi);
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
            this.insertionMarker = null;
            this.deleteActionVisible = this.selectedVertexIndex !== null && options.showInitialDeleteAction === true;
            this.destroyed = false;
            this.dragStartRing = null;
            this.dragHistoryRecorded = false;
            this.boundKeydown = event => this.handleKeydown(event);
            this.boundMapClick = () => this.hideDeleteAction({ clearSelection: true });
            this.boundMapMove = () => this.hideInsertionPreview();

            // Undo, shared with the plot and road editors. The ring is the whole state, so a
            // snapshot is just a copy of it — taken before a move/insert/remove commits.
            const historyFactory = options.history
                || (typeof window !== 'undefined' ? window.GeometryEditHistory : null);
            this.history = (historyFactory && options.undo !== false)
                ? historyFactory.create({
                    capture: () => openRing(this.ring),
                    restore: ring => {
                        this.ring = openRing(ring);
                        this.hideDeleteAction({ clearSelection: true });
                        this.emit('onCommit', 'undo', null);
                        if (!this.destroyed) this.render({ refreshRing: false });
                    },
                    onChange: typeof options.onUndoAvailability === 'function'
                        ? options.onUndoAvailability
                        : undefined
                })
                : null;
            if (this.history && options.bindUndoKeyboard !== false && this.document) {
                this.history.bindKeyboard(this.document, {
                    enabled: () => !this.destroyed
                });
            }
            if (this.history && options.undoButton) this.history.bindButton(options.undoButton);
            // No host-supplied button? Provide one. Undo that only exists as a shortcut is undo
            // most people never find, and every host of this editor would otherwise have to build
            // the same control.
            if (this.history && !options.undoButton && options.showUndoButton !== false) {
                this.ownUndoButton = this.createFloatingUndoButton();
                if (this.ownUndoButton) this.history.bindButton(this.ownUndoButton);
            }

            const controls = typeof window !== 'undefined' ? window.PolygonVertexControls : null;
            this.accessibleControls = options.showCoordinateControls === false ? null : controls?.create(this);
            if (this.document) this.document.addEventListener('keydown', this.boundKeydown);
            if (typeof this.map.on === 'function') this.map.on('click', this.boundMapClick);
            if (typeof this.map.on === 'function') this.map.on('movestart', this.boundMapMove);
        }

        // A small control in the map corner: map chrome (.map-shell-button), placed by
        // .geom-undo-button (modals.css).
        createFloatingUndoButton() {
            if (!this.document || !this.map || typeof this.map.getContainer !== 'function') return null;
            try {
                const container = this.map.getContainer();
                if (!container) return null;
                const button = this.document.createElement('button');
                button.type = 'button';
                button.className = 'map-shell-button geom-undo-button';
                button.title = this.options.undoTitle || 'Undo (Cmd/Ctrl+Z)';
                button.setAttribute('aria-label', button.title);
                const icon = this.document.createElement('i');
                icon.className = 'fa-solid fa-rotate-left';
                icon.setAttribute('aria-hidden', 'true');
                button.appendChild(icon);
                button.disabled = true;
                // Keep map drag/zoom from eating the click.
                if (this.L && this.L.DomEvent) {
                    this.L.DomEvent.disableClickPropagation(button);
                    this.L.DomEvent.disableScrollPropagation(button);
                }
                container.appendChild(button);
                return button;
            } catch (_) { return null; }
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
                element?.setAttribute('aria-pressed', String(index === this.selectedVertexIndex));
            });
        }

        hideDeleteAction(options = {}) {
            this.deleteActionVisible = false;
            this.removeDeleteMarker();
            if (options.clearSelection) {
                this.selectedVertexIndex = null;
                this.refreshVertexSelectionStyles();
                this.accessibleControls?.update();
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
                pane: this.options.pane || 'markerPane',
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
            this.hideInsertionPreview();
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
                    pane: this.options.pane || 'overlayPane',
                    className: 'polygon-geometry-editor__edge',
                    color: '#000000',
                    opacity: 0,
                    weight: Number(this.options.edgeHitWidth) || 18,
                    interactive: true,
                    bubblingMouseEvents: false
                }).addTo(this.layerGroup);
                edge.on('click', event => this.handleEdgeClick(edgeIndex, event));
                edge.on('mouseover', event => this.showInsertionPreview(edgeIndex, event));
                edge.on('mousemove', event => this.showInsertionPreview(edgeIndex, event));
                edge.on('mouseout', () => this.hideInsertionPreview());
            });

            this.ring.forEach(([lng, lat], vertexIndex) => {
                const marker = this.L.marker([lat, lng], {
                    pane: this.options.pane || 'markerPane',
                    draggable: true,
                    keyboard: true,
                    title: this.vertexLabel(vertexIndex),
                    alt: this.vertexLabel(vertexIndex),
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
                const element = typeof marker.getElement === 'function' ? marker.getElement() : marker._icon;
                if (element) {
                    element.setAttribute('role', 'button');
                    element.setAttribute('aria-label', this.vertexLabel(vertexIndex));
                    element.setAttribute('aria-pressed', String(vertexIndex === this.selectedVertexIndex));
                    element.addEventListener('keydown', event => {
                        if (event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        this.selectVertex(vertexIndex);
                    });
                }
                this.vertexMarkers.push(marker);
            });

            if (this.deleteActionVisible) this.showDeleteAction();
            try { this.layerGroup.bringToFront(); } catch (_) { }
            this.accessibleControls?.update();
            return this;
        }

        vertexLabel(index) {
            const ui = typeof window !== 'undefined' ? window.GeometryCoordinateControls : null;
            const label = ui?.text('vertexNumber', 'Vertex {{number}}', { number: index + 1 }) || `Vertex ${index + 1}`;
            return this.options.controlsLabel ? `${this.options.controlsLabel}: ${label}` : label;
        }

        stopLeafletEvent(event) {
            try {
                const original = event && event.originalEvent;
                if (original && this.L.DomEvent) this.L.DomEvent.stop(original);
            } catch (_) { }
        }

        hideInsertionPreview() {
            if (this.insertionMarker) this.map.removeLayer(this.insertionMarker);
            this.insertionMarker = null;
        }

        showInsertionPreview(edgeIndex, event) {
            if (this.destroyed || this.dragStartRing || !event?.latlng) return;
            const coordinate = coordinateOnEdge(this.ring, edgeIndex,
                [event.latlng.lng, event.latlng.lat], this.turf);
            if (!coordinate) return;
            const latLng = [coordinate[1], coordinate[0]];
            if (this.insertionMarker) {
                this.insertionMarker.setLatLng(latLng);
                return;
            }
            this.insertionMarker = this.L.marker(latLng, {
                pane: this.options.pane || 'markerPane',
                interactive: false,
                keyboard: false,
                icon: this.L.divIcon({
                    className: `${this.options.markerClassName || 'blockify-handle blockify-handle--vertex'} polygon-geometry-editor__insertion`,
                    html: this.options.markerHtml || '<span></span>',
                    iconSize: this.options.iconSize || [24, 24],
                    iconAnchor: this.options.iconAnchor || [12, 12]
                })
            }).addTo(this.map);
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
            this.accessibleControls?.update();
        }

        drawLiveOutline() {
            if (this.liveLayer && this.map) {
                try { this.map.removeLayer(this.liveLayer); } catch (_) { }
            }
            this.liveLayer = null;
            if (this.ring.length < 3) return;
            const style = Object.assign({
                pane: this.options.pane || 'overlayPane',
                color: '#fb8c00',
                weight: 2,
                dashArray: '5,5',
                fill: false,
                interactive: false
            }, this.options.liveStyle || {});
            this.liveLayer = this.L.polygon(this.ring.map(([lng, lat]) => [lat, lng]), style).addTo(this.map);
        }

        handleVertexDragStart(vertexIndex, event) {
            this.hideInsertionPreview();
            this.stopLeafletEvent(event);
            this.hideDeleteAction({ clearSelection: true });
            // Leaflet mutates this.ring during each drag event. Capture before that first mutation
            // so Ctrl/Cmd+Z restores the actual pre-drag shape rather than the dragged endpoint.
            this.dragStartRing = openRing(this.ring);
            this.dragHistoryRecorded = this.history ? this.history.record() : false;
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
            return this.completeVertexMove(vertexIndex, rawCoordinate, event);
        }

        moveVertex(vertexIndex, coordinate) {
            if (this.destroyed || !Number.isInteger(vertexIndex) || !this.ring[vertexIndex]
                || !Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)
                || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) return false;
            if (coordinatesEqual(this.ring[vertexIndex], coordinate)) return true;
            this.handleVertexDragStart(vertexIndex);
            this.ring[vertexIndex] = coordinate.slice(0, 2);
            return this.completeVertexMove(vertexIndex, coordinate, null, { snap: false });
        }

        completeVertexMove(vertexIndex, rawCoordinate, event, { snap = true } = {}) {
            // A caller-supplied snap (the site tool snaps to parcel edges) replaces the boundary one.
            const coordinate = !snap ? rawCoordinate : typeof this.options.snapCoordinate === 'function'
                ? (this.options.snapCoordinate(rawCoordinate, event) || rawCoordinate)
                : snapCoordinateToBoundary(rawCoordinate, this.options.boundary, this.turf);
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
            const dragChanged = this.dragStartRing && !ringsEqual(this.dragStartRing, this.ring);
            if (!dragChanged && this.dragHistoryRecorded) this.history?.discardLast?.();
            const before = this.dragStartRing;
            const recorded = this.dragHistoryRecorded;
            this.dragStartRing = null;
            this.dragHistoryRecorded = false;
            const releasedVertexIndex = nearestVertexIndex(this.ring, coordinate) ?? vertexIndex;
            const accepted = this.emit('onCommit', 'move', releasedVertexIndex) !== false;
            if (!accepted) {
                if (before) this.ring = before;
                if (recorded && dragChanged) this.history?.discardLast?.();
            }
            if (!this.destroyed) {
                this.selectedVertexIndex = Number.isInteger(releasedVertexIndex)
                    && releasedVertexIndex >= 0
                    && releasedVertexIndex < this.ring.length
                    ? releasedVertexIndex
                    : null;
                this.deleteActionVisible = this.selectedVertexIndex !== null;
                this.render({ refreshRing: !accepted });
            }
            return accepted;
        }

        handleEdgeClick(edgeIndex, event) {
            this.stopLeafletEvent(event);
            const latLng = event && event.latlng;
            if (!latLng || !Number.isFinite(latLng.lng) || !Number.isFinite(latLng.lat)) return;
            const coordinate = coordinateOnEdge(this.ring, edgeIndex, [latLng.lng, latLng.lat], this.turf);
            return this.insertVertex(edgeIndex, coordinate);
        }

        insertVertex(edgeIndex, coordinate) {
            const inserted = insertVertexAfterEdge(this.ring, edgeIndex, coordinate);
            if (!inserted) return false;   // nothing changed, so no undo step is taken below
            const before = openRing(this.ring);
            const recorded = this.history?.record();
            const insertedIndex = edgeIndex + 1;
            this.ring = inserted;
            this.hideDeleteAction({ clearSelection: true });
            const accepted = this.emit('onCommit', 'insert', insertedIndex) !== false;
            if (!accepted) { this.ring = before; if (recorded) this.history?.discardLast?.(); }
            if (!this.destroyed) this.render({ refreshRing: !accepted });
            return accepted;
        }

        removeSelectedVertex() {
            const removed = removeVertexAt(this.ring, this.selectedVertexIndex);
            if (!removed) return false;
            const before = openRing(this.ring);
            const recorded = this.history?.record();
            const removedIndex = this.selectedVertexIndex;
            this.ring = removed;
            const constrainedRing = constrainRingToBoundary(this.ring, this.options.boundary, this.turf);
            if (constrainedRing) this.ring = constrainedRing;
            this.hideDeleteAction({ clearSelection: true });
            const accepted = this.emit('onCommit', 'remove', removedIndex) !== false;
            if (!accepted) { this.ring = before; if (recorded) this.history?.discardLast?.(); }
            if (!this.destroyed) this.render({ refreshRing: !accepted });
            return accepted;
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
            this.dragStartRing = null;
            this.dragHistoryRecorded = false;
            this.clearLayers();
            this.accessibleControls?.destroy();
            this.accessibleControls = null;
            // Release the undo binding with the editor, or its shortcut outlives the tool.
            if (this.history) { this.history.destroy(); this.history = null; }
            if (this.ownUndoButton) {
                try { this.ownUndoButton.remove(); } catch (_) { }
                this.ownUndoButton = null;
            }
            if (this.document) this.document.removeEventListener('keydown', this.boundKeydown);
            if (typeof this.map.off === 'function') this.map.off('click', this.boundMapClick);
            if (typeof this.map.off === 'function') this.map.off('movestart', this.boundMapMove);
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
        polygonFeaturesFromGeoJSON,
        areaGeometryFromGeoJSON,
        insertVertexAfterEdge,
        removeVertexAt,
        snapCoordinateToBoundary
    };
});
