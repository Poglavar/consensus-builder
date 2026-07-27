// Unit coverage for the shared Leaflet polygon editor used by block manual mode, freeform
// buildings, and row houses, including import, release-time snapping, and safe vertex deletion.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const {
    coordinateOnEdge,
    constrainRingToBoundary,
    create,
    extractOuterRingFromGeoJSON,
    insertVertexAfterEdge,
    openRing,
    removeVertexAt,
    snapCoordinateToBoundary
} = require('../../frontend/js/polygon-geometry-editor.js');

const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
const squareFeature = turf.polygon([square]);

function fakeLeaflet() {
    const makeLayer = (kind, latLng = null) => ({
        kind,
        latLng,
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
        polyline() {
            return makeLayer('edge');
        },
        polygon() {
            return makeLayer('live');
        },
        marker(latLng) {
            return makeLayer('marker', { lat: latLng[0], lng: latLng[1] });
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

    it('extracts the largest polygon ring from common GeoJSON wrappers', () => {
        const imported = extractOuterRingFromGeoJSON({
            type: 'FeatureCollection',
            features: [
                turf.polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]),
                turf.multiPolygon([[[[10, 10], [13, 10], [13, 13], [10, 10]]]])
            ]
        }, turf);

        expect(imported).toEqual([[10, 10], [13, 10], [13, 13]]);
        expect(extractOuterRingFromGeoJSON({ type: 'Point', coordinates: [0, 0] }, turf)).toBeNull();
    });
});

describe('shared Leaflet interaction model', () => {
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
