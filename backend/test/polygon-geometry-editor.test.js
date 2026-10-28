// Unit coverage for the shared Leaflet polygon editor used by block manual mode, freeform
// buildings, and row houses, including import, release-time snapping, and safe vertex deletion.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const History = require('../../frontend/js/geometry-edit/history.js');
const {
    coordinateOnEdge,
    constrainRingToBoundary,
    create,
    polygonFeaturesFromGeoJSON,
    insertVertexAfterEdge,
    openRing,
    removeVertexAt,
    snapCoordinateToBoundary
} = require('../../frontend/js/polygon-geometry-editor.js');

const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
const squareFeature = turf.polygon([square]);

function fakeLeaflet() {
    const makeLayer = (kind, latLng = null, options = {}) => ({
        kind,
        latLng,
        options,
        handlers: {},
        addTo(target) {
            if (!Array.isArray(target.layers)) target.layers = [];
            target.layers.push(this);
            return this;
        },
        on(name, handler) {
            this.handlers[name] = handler;
            return this;
        },
        getLatLng() {
            return this.latLng;
        },
        setLatLng(next) {
            this.latLng = Array.isArray(next) ? { lat: next[0], lng: next[1] } : next;
            return this;
        },
        getElement() {
            return null;
        }
    });

    return {
        layerGroup() {
            const group = makeLayer('group');
            group.layers = [];
            group.bringToFront = () => group;
            group.removeLayer = layer => {
                group.layers = group.layers.filter(item => item !== layer);
                return group;
            };
            return group;
        },
        polyline(_latLngs, options) {
            return makeLayer('edge', null, options);
        },
        polygon(_latLngs, options) {
            return makeLayer('live', null, options);
        },
        marker(latLng, options) {
            return makeLayer('marker', { lat: latLng[0], lng: latLng[1] }, options);
        },
        divIcon(options) {
            return options;
        },
        DomEvent: {
            stop() {},
            stopPropagation() {},
            disableClickPropagation() {},
            disableScrollPropagation() {}
        }
    };
}

function fakeMap() {
    return {
        layers: [],
        handlers: {},
        on(name, handler) {
            this.handlers[name] = handler;
        },
        off(name, handler) {
            if (this.handlers[name] === handler) delete this.handlers[name];
        },
        removeLayer(layer) {
            this.layers = this.layers.filter(item => item !== layer);
        },
        getContainer() {
            return null;
        }
    };
}

function fakeDocument() {
    const listeners = new Map();
    return {
        addEventListener(name, handler) {
            const handlers = listeners.get(name) || [];
            handlers.push(handler);
            listeners.set(name, handlers);
        },
        removeEventListener(name, handler) {
            listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler));
        },
        fire(name, event) { (listeners.get(name) || []).forEach(handler => handler(event)); }
    };
}

describe('shared polygon ring operations', () => {
    it('inserts a vertex exactly where an edge is clicked without mutating the source', () => {
        const source = structuredClone(square);
        const click = coordinateOnEdge(square, 0, [0.35, 0.08], turf);
        const inserted = insertVertexAfterEdge(square, 0, click);

        expect(square).toEqual(source);
        expect(inserted).toHaveLength(5);
        expect(inserted[1][0]).toBeCloseTo(0.35, 3);
        expect(inserted[1][1]).toBeCloseTo(0, 10);
    });

    it('removes a selected vertex but never reduces a polygon below three vertices', () => {
        const fiveSided = insertVertexAfterEdge(square, 0, [0.5, 0]);
        const fourSided = removeVertexAt(fiveSided, 1);
        const triangle = removeVertexAt(fourSided, 0);

        expect(fourSided).toHaveLength(4);
        expect(triangle).toHaveLength(3);
        expect(removeVertexAt(triangle, 0)).toBeNull();
    });

    it('snaps an outside release point to the nearest polygon boundary', () => {
        const snapped = snapCoordinateToBoundary([2, 0.4], squareFeature, turf);
        expect(snapped[0]).toBeCloseTo(1, 10);
        expect(snapped[1]).toBeCloseTo(0.4, 3);
        expect(snapCoordinateToBoundary([0.4, 0.4], squareFeature, turf)).toEqual([0.4, 0.4]);
    });

    it('clips edges across a concave boundary instead of rejecting the release', () => {
        const boundary = turf.polygon([[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]]);
        const ring = [[0.2, 0.2], [1.8, 0.8], [0.8, 1.8]];
        const constrained = constrainRingToBoundary(ring, boundary, turf);
        const closed = constrained.concat([[constrained[0][0], constrained[0][1]]]);

        expect(constrained.length).toBeGreaterThan(3);
        expect(turf.booleanWithin(turf.polygon([closed]), boundary)).toBe(true);
    });

    it('imports every footprint and hole with source properties from GeoJSON wrappers', () => {
        const hole = [[0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.4, 0.2], [0.2, 0.2]];
        const courtyard = turf.polygon([square, hole], { name: 'Courtyard', height: 18 });
        const smaller = turf.multiPolygon([[[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10]]],
            [[[11, 11], [11.1, 11], [11.1, 11.1], [11, 11]]]], { name: 'Wings', floors: 2 });
        const input = turf.featureCollection([courtyard, smaller]);
        const before = structuredClone(input);
        const imported = polygonFeaturesFromGeoJSON(input);
        expect(imported).toHaveLength(3);
        expect(imported[0]).toEqual(courtyard);
        expect(imported[1].geometry.coordinates).toEqual(smaller.geometry.coordinates[0]);
        expect(imported[2].geometry.coordinates).toEqual(smaller.geometry.coordinates[1]);
        expect(imported[2].properties).toEqual(smaller.properties);
        imported[0].geometry.coordinates[1][0][0] = 0.3;
        expect(input).toEqual(before);
        expect(polygonFeaturesFromGeoJSON({ type: 'GeometryCollection', geometries: [courtyard.geometry] })[0].geometry).toEqual(courtyard.geometry);
    });

    it('rejects a partially invalid or mixed-geometry file instead of importing only usable parts', () => {
        expect(() => polygonFeaturesFromGeoJSON(turf.featureCollection([squareFeature, turf.point([0, 0])]))).toThrow(/only Polygon/);
        expect(() => polygonFeaturesFromGeoJSON({ type: 'Polygon', coordinates: [square, [[0, 0], [null, 1], [1, 1]]] })).toThrow(/invalid/);
        expect(() => polygonFeaturesFromGeoJSON({ type: 'FeatureCollection', features: [] })).toThrow(/No polygon/);
        expect(() => polygonFeaturesFromGeoJSON({ type: 'MultiPolygon', coordinates: [] })).toThrow();
    });

});

describe('shared Leaflet interaction model', () => {
    it('propagates a custom pane to vertex handles, edge hit targets, delete action, and live outline', () => {
        const pane = 'single-building-handles';
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            pane,
            initialSelectedVertexIndex: 1,
            showInitialDeleteAction: true
        });

        expect(editor.vertexMarkers.every(marker => marker.options.pane === pane)).toBe(true);
        expect(editor.layerGroup.layers.filter(layer => layer.kind === 'edge').every(edge => edge.options.pane === pane)).toBe(true);
        expect(editor.deleteMarker.options.pane).toBe(pane);

        const marker = editor.vertexMarkers[1];
        marker.handlers.dragstart({ target: marker });
        marker.setLatLng({ lng: 1.1, lat: 0.5 });
        marker.handlers.drag({ target: marker });
        expect(editor.liveLayer.options.pane).toBe(pane);
        editor.destroy();
    });

    it('keeps the normal Leaflet pane defaults when no pane is supplied', () => {
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            showDeleteAction: false
        });

        expect(editor.vertexMarkers[0].options.pane).toBe('markerPane');
        expect(editor.layerGroup.layers.find(layer => layer.kind === 'edge').options.pane).toBe('overlayPane');
        const marker = editor.vertexMarkers[0];
        marker.handlers.dragstart({ target: marker });
        marker.setLatLng({ lng: -0.1, lat: 0.5 });
        marker.handlers.drag({ target: marker });
        expect(editor.liveLayer.options.pane).toBe('overlayPane');
        editor.destroy();
    });

    it('renders only real vertex markers and inserts through an edge click', () => {
        const commits = [];
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            showDeleteAction: false,
            onCommit: payload => commits.push(payload)
        });

        const initialLayers = editor.layerGroup.layers;
        expect(initialLayers.filter(layer => layer.kind === 'marker')).toHaveLength(4);
        expect(initialLayers.filter(layer => layer.kind === 'edge')).toHaveLength(4);

        initialLayers.find(layer => layer.kind === 'edge').handlers.click({
            latlng: { lng: 0.25, lat: 0.08 }
        });

        expect(commits).toHaveLength(1);
        expect(commits[0].reason).toBe('insert');
        expect(commits[0].ring).toHaveLength(5);
        expect(commits[0].ring[1][0]).toBeCloseTo(0.25, 3);
        expect(commits[0].ring[1][1]).toBeCloseTo(0, 10);
        editor.destroy();
    });

    it('previews the insertion point on the edge without editing, and clears it on leave and teardown', () => {
        const map = fakeMap();
        const commits = [];
        const editor = create({ map, leaflet: fakeLeaflet(), turf, ring: square,
            onCommit: payload => commits.push(payload) });
        const edge = editor.layerGroup.layers.find(layer => layer.kind === 'edge');
        edge.handlers.mouseover({ latlng: { lng: 0.3, lat: 0.08 } });
        const preview = editor.insertionMarker;
        expect(preview.latLng.lng).toBeCloseTo(0.3, 3);
        expect(preview.latLng.lat).toBeCloseTo(0, 10);
        expect(preview.options.interactive).toBe(false);
        expect(editor.ring).toHaveLength(4);
        expect(commits).toEqual([]);
        edge.handlers.mousemove({ latlng: { lng: 0.6, lat: 0.08 } });
        expect(editor.insertionMarker).toBe(preview);
        expect(preview.latLng.lng).toBeCloseTo(0.6, 3);
        edge.handlers.mouseout();
        expect(editor.insertionMarker).toBeNull();
        expect(map.layers).not.toContain(preview);
        edge.handlers.mouseover({ latlng: { lng: 0.5, lat: 0 } });
        map.handlers.movestart();
        expect(editor.insertionMarker).toBeNull();
        edge.handlers.mouseover({ latlng: { lng: 0.5, lat: 0 } });
        const next = editor.insertionMarker;
        editor.destroy();
        expect(map.layers).not.toContain(next);
    });

    it('lets a vertex follow the pointer freely and snaps only on drag end', () => {
        const liveChanges = [];
        const commits = [];
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            boundary: squareFeature,
            showDeleteAction: false,
            onLiveChange: payload => liveChanges.push(payload),
            onCommit: payload => commits.push(payload)
        });
        const marker = editor.vertexMarkers[1];
        marker.handlers.dragstart({ target: marker });
        marker.latLng = { lng: 2, lat: 0.4 };

        marker.handlers.drag({ target: marker });
        expect(liveChanges).toHaveLength(1);
        expect(liveChanges[0].ring[1]).toEqual([2, 0.4]);
        expect(commits).toHaveLength(0);

        marker.handlers.dragend({ target: marker });
        expect(commits).toHaveLength(1);
        expect(commits[0].reason).toBe('move');
        expect(commits[0].ring[1][0]).toBeCloseTo(1, 10);
        expect(commits[0].ring[1][1]).toBeCloseTo(0.4, 3);
        expect(openRing(editor.ring)).toHaveLength(4);
        editor.destroy();
    });

    it('undoes the complete vertex drag and does not create an undo step for a no-op drag', () => {
        const document = fakeDocument();
        const commits = [];
        const editor = create({
            map: fakeMap(), leaflet: fakeLeaflet(), turf, ring: square,
            history: History, document, showUndoButton: false,
            onCommit: payload => commits.push(payload)
        });
        const original = openRing(square);
        const marker = editor.vertexMarkers[1];

        marker.handlers.dragstart({ target: marker });
        marker.setLatLng({ lng: 1.2, lat: 0.3 });
        marker.handlers.drag({ target: marker });
        marker.handlers.dragend({ target: marker });
        expect(editor.ring[1]).toEqual([1.2, 0.3]);
        expect(editor.history.canUndo()).toBe(true);

        const undoEvent = { key: 'z', ctrlKey: true, target: {}, preventDefault() {} };
        document.fire('keydown', undoEvent);
        expect(openRing(editor.ring)).toEqual(original);
        expect(commits.map(commit => commit.reason)).toEqual(['move', 'undo']);
        expect(editor.history.canUndo()).toBe(false);

        const unchanged = editor.vertexMarkers[0];
        unchanged.handlers.dragstart({ target: unchanged });
        unchanged.handlers.dragend({ target: unchanged });
        expect(editor.history.canUndo()).toBe(false);
        editor.destroy();
    });

    it('keeps edge insert and vertex delete undo snapshots before their changes', () => {
        const document = fakeDocument();
        const editor = create({
            map: fakeMap(), leaflet: fakeLeaflet(), turf, ring: square,
            history: History, document, showUndoButton: false
        });

        editor.layerGroup.layers.find(layer => layer.kind === 'edge').handlers.click({
            latlng: { lng: 0.25, lat: 0 }
        });
        expect(editor.ring).toHaveLength(5);
        document.fire('keydown', { key: 'z', ctrlKey: true, target: {}, preventDefault() {} });
        expect(openRing(editor.ring)).toEqual(openRing(square));

        editor.vertexMarkers[1].handlers.click({});
        editor.deleteMarker.handlers.click({});
        expect(editor.ring).toHaveLength(3);
        document.fire('keydown', { key: 'z', ctrlKey: true, target: {}, preventDefault() {} });
        expect(editor.ring).toHaveLength(4);
        expect(openRing(editor.ring)).toEqual(openRing(square));
        editor.destroy();
    });

    it('removes only a selected vertex and keeps the three-vertex floor', () => {
        const commits = [];
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            onCommit: payload => commits.push(payload)
        });

        expect(editor.removeSelectedVertex()).toBe(false);
        editor.vertexMarkers[1].handlers.click({});
        expect(editor.deleteMarker).not.toBeNull();
        editor.deleteMarker.handlers.click({});
        expect(commits[0].reason).toBe('remove');
        expect(commits[0].ring).toHaveLength(3);
        expect(editor.deleteMarker).toBeNull();

        editor.selectVertex(0);
        expect(editor.removeSelectedVertex()).toBe(false);
        editor.destroy();
    });

    it('shows the contextual basket for every vertex and clears it on drag or insertion', () => {
        const commits = [];
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            onCommit: payload => commits.push(payload)
        });

        editor.vertexMarkers.forEach((marker, vertexIndex) => {
            expect(marker.handlers.mousedown).toBeUndefined();
            marker.handlers.click({});
            expect(editor.selectedVertexIndex).toBe(vertexIndex);
            expect(editor.deleteMarker).not.toBeNull();
            expect(editor.deleteMarker.getLatLng()).toEqual(marker.getLatLng());
        });
        expect(commits).toHaveLength(0);

        const draggedMarker = editor.vertexMarkers[2];
        draggedMarker.handlers.dragstart({ target: draggedMarker });
        expect(editor.deleteMarker).toBeNull();
        expect(editor.selectedVertexIndex).toBeNull();
        draggedMarker.handlers.drag({ target: draggedMarker });
        expect(editor.deleteMarker).toBeNull();
        draggedMarker.handlers.dragend({ target: draggedMarker });
        expect(editor.selectedVertexIndex).toBe(2);
        expect(editor.deleteMarker).not.toBeNull();

        editor.vertexMarkers[0].handlers.click({});
        expect(editor.deleteMarker).not.toBeNull();
        editor.layerGroup.layers.find(layer => layer.kind === 'edge').handlers.click({
            latlng: { lng: 0.25, lat: 0 }
        });
        expect(editor.deleteMarker).toBeNull();
        expect(editor.selectedVertexIndex).toBeNull();
        editor.destroy();
    });

    it('can restore the released vertex action after a host redraw', () => {
        const editor = create({
            map: fakeMap(),
            leaflet: fakeLeaflet(),
            turf,
            ring: square,
            initialSelectedVertexIndex: 3,
            showInitialDeleteAction: true
        });

        expect(editor.selectedVertexIndex).toBe(3);
        expect(editor.deleteMarker).not.toBeNull();
        expect(editor.deleteMarker.getLatLng()).toEqual(editor.vertexMarkers[3].getLatLng());
        editor.destroy();
    });
});


describe('coordinate controls share the polygon commit and undo path', () => {
    it('moves a vertex without a pointer gesture and undoes the exact previous ring', () => {
        const commits = [];
        const editor = create({ map: fakeMap(), leaflet: fakeLeaflet(), document: fakeDocument(), turf,
            ring: square, history: History, showUndoButton: false, onCommit: event => commits.push(event) });
        expect(editor.moveVertex(1, [.8, .1])).toBe(true);
        expect(editor.ring[1]).toEqual([.8, .1]);
        expect(commits.at(-1)).toMatchObject({ reason: 'move', vertexIndex: 1 });
        expect(editor.history.undo()).toBe(true);
        expect(editor.ring).toEqual(openRing(square));
        expect(editor.moveVertex(1, [])).toBe(false);
        expect(editor.moveVertex(1, [181, 0])).toBe(false);
        editor.destroy();
    });
    it('uses exact entered coordinates even when pointer snapping is enabled', () => {
        const editor = create({ map: fakeMap(), leaflet: fakeLeaflet(), document: fakeDocument(), turf,
            ring: square, snapCoordinate: () => [.9, .1], onCommit: () => true });
        expect(editor.moveVertex(1, [.8, .2])).toBe(true);
        expect(editor.ring[1]).toEqual([.8, .2]);
        editor.destroy();
    });
    it('keeps geometry and undo unchanged when the host refuses a move, insertion or deletion', () => {
        const editor = create({ map: fakeMap(), leaflet: fakeLeaflet(), document: fakeDocument(), turf,
            ring: square, history: History, showUndoButton: false, onCommit: () => false });
        expect(editor.moveVertex(1, [.8, .1])).toBe(false);
        expect(editor.insertVertex(0, [.5, 0])).toBe(false);
        editor.selectVertex(1);
        expect(editor.removeSelectedVertex()).toBe(false);
        expect(editor.ring).toEqual(openRing(square));
        expect(editor.history.undo()).toBe(false);
        editor.destroy();
    });
});
