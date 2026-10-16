// geometry-edit/handles.js — the shared handle layer. Covers the opt-in gestures a land-readjustment
// layout uses: pulling a midpoint inserts a node where it is dropped, grabbing a segment moves both
// of its ends (each still obeying its own node policy), and a click on a segment reaches the host.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Handles;
let topo;

beforeAll(() => {
    topo = require('../../frontend/js/proposals/plot-topology.js');
    Handles = require('../../frontend/js/geometry-edit/handles.js');
});

// A minimal DOM element: enough for pointer listeners, classes and pointer capture.
function fakeElement() {
    const listeners = {};
    const classes = new Set();
    return {
        listeners,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
        setPointerCapture: () => { },
        fire(type, event) { (listeners[type] || []).slice().forEach(fn => fn(event)); }
    };
}

// Leaflet, reduced to what the handle layer touches. Screen pixels are lng/lat × 100.
function fakeLeaflet() {
    const made = { markers: [], lines: [] };
    function evented(target) {
        const on = {};
        target.on = (type, fn) => { (on[type] = on[type] || []).push(fn); return target; };
        target.fire = (type, event) => (on[type] || []).forEach(fn => fn(event));
        target.addTo = () => target;
        return target;
    }
    const L = {
        layerGroup: () => ({ addTo() { return this; }, remove() { } }),
        divIcon: o => o,
        svg: () => ({}),
        marker: (latlng, options) => {
            const m = evented({ options, latlng: { lat: latlng[0], lng: latlng[1] }, el: fakeElement() });
            m.getLatLng = () => m.latlng;
            m.setLatLng = ll => { m.latlng = Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll; };
            m.getElement = () => m.el;
            made.markers.push(m);
            return m;
        },
        polyline: (latlngs, options) => {
            const line = evented({ options, latlngs, el: fakeElement() });
            line.getElement = () => line.el;
            line.setLatLngs = ll => { line.latlngs = ll; };
            made.lines.push(line);
            return line;
        },
        DomEvent: { stop: () => { }, on: () => { }, stopPropagation: () => { } }
    };
    const map = {
        getPane: () => ({ style: { zIndex: '675' } }),
        createPane: () => ({ style: {} }),
        mouseEventToLatLng: e => ({ lng: e.clientX / 100, lat: e.clientY / 100 })
    };
    return { L, map, made };
}

// Two plots sharing the boundary x = 10.
const square = (x0, x1) => ({ geometry: { type: 'Polygon', coordinates: [[[x0, 0], [x1, 0], [x1, 10], [x0, 10], [x0, 0]]] } });
const PLOTS = [square(0, 10), square(10, 20)];
const sharedEdge = t => {
    const byId = new Map(t.nodes.map(n => [n.id, n]));
    return t.edges.find(e => e.plots.length === 2 && byId.get(e.a).coord[0] === 10 && byId.get(e.b).coord[0] === 10);
};

function layer(extra) {
    const { L, map, made } = fakeLeaflet();
    const layerApi = Handles.create({ map, leaflet: L, topology: topo, pane: 'handles', getShapes: () => PLOTS, ...extra });
    const topology = layerApi.render();
    return { made, topology };
}

describe('segment drag (dragEdges)', () => {
    it('moves both ends of the grabbed segment by the pointer offset', () => {
        const onMoveMany = vi.fn();
        const onPreviewMany = vi.fn();
        const { made, topology } = layer({ dragEdges: true, onMoveMany, onPreviewMany });
        const edge = sharedEdge(topology);
        const ends = [edge.a, edge.b].map(id => topology.nodes.find(n => n.id === id));
        const line = made.lines.find(l => l.latlngs.every(([, lng]) => lng === 10));
        expect(line).toBeTruthy();
        line.el.fire('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1000, clientY: 500, stopPropagation() { } });
        line.el.fire('pointermove', { clientX: 1300, clientY: 500 });
        line.el.fire('pointerup', {});
        expect(onPreviewMany).toHaveBeenCalled();
        expect(onMoveMany).toHaveBeenCalledTimes(1);
        const moves = onMoveMany.mock.calls[0][0];
        expect(moves.map(m => m.nodeId).sort()).toEqual(ends.map(n => n.id).sort());
        moves.forEach(m => {
            const node = ends.find(n => n.id === m.nodeId);
            expect(m.coord[0]).toBeCloseTo(13, 9);
            expect(m.coord[1]).toBeCloseTo(node.coord[1], 9);
        });
    });

    it('keeps each end on its own policy: a sliding end is constrained', () => {
        const onMoveMany = vi.fn();
        const { made, topology } = layer({
            dragEdges: true,
            onMoveMany,
            nodePolicy: node => (node.coord[1] === 0 ? { constrain: c => [c[0], 0] } : {})
        });
        const line = made.lines.find(l => l.latlngs.every(([, lng]) => lng === 10));
        line.el.fire('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1000, clientY: 500, stopPropagation() { } });
        line.el.fire('pointermove', { clientX: 1200, clientY: 700 });
        line.el.fire('pointerup', {});
        const moves = onMoveMany.mock.calls[0][0];
        const bottom = moves.find(m => topology.nodes.find(n => n.id === m.nodeId).coord[1] === 0);
        const top = moves.find(m => topology.nodes.find(n => n.id === m.nodeId).coord[1] === 10);
        expect(bottom.coord).toEqual([12, 0]);
        expect(top.coord[1]).toBeCloseTo(12, 9);
    });

    it('ignores a press that never moves, and hands a click to the host instead', () => {
        const onMoveMany = vi.fn();
        const onEdgeClick = vi.fn();
        const { made } = layer({ dragEdges: true, onMoveMany, onEdgeClick });
        const line = made.lines.find(l => l.latlngs.every(([, lng]) => lng === 10));
        line.el.fire('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1000, clientY: 500, stopPropagation() { } });
        line.el.fire('pointermove', { clientX: 1001, clientY: 501 });   // under the 4 px threshold
        line.el.fire('pointerup', {});
        line.fire('click', { latlng: { lat: 5, lng: 10 } });
        expect(onMoveMany).not.toHaveBeenCalled();
        expect(onEdgeClick).toHaveBeenCalledTimes(1);
        expect(onEdgeClick.mock.calls[0][0].plots).toHaveLength(2);
    });

    it('swallows the click that ends a drag', () => {
        const onEdgeClick = vi.fn();
        const { made } = layer({ dragEdges: true, onMoveMany: () => { }, onEdgeClick });
        const line = made.lines.find(l => l.latlngs.every(([, lng]) => lng === 10));
        line.el.fire('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1000, clientY: 500, stopPropagation() { } });
        line.el.fire('pointermove', { clientX: 1100, clientY: 500 });
        line.el.fire('pointerup', {});
        line.fire('click', { latlng: { lat: 5, lng: 11 } });
        expect(onEdgeClick).not.toHaveBeenCalled();
    });

    it('offers no segment whose end the host has pinned, and none the edge policy refuses', () => {
        const pinned = layer({ dragEdges: true, nodePolicy: node => (node.coord[0] === 10 && node.coord[1] === 0 ? { draggable: false } : {}) });
        expect(pinned.made.lines.some(l => l.latlngs.every(([, lng]) => lng === 10))).toBe(false);
        const refused = layer({ dragEdges: true, edgePolicy: edge => ({ draggable: edge.plots.length === 2 }) });
        expect(refused.made.lines).toHaveLength(1);
    });

    it('draws nothing extra unless asked for', () => {
        expect(layer({}).made.lines).toHaveLength(0);
    });
});

describe('midpoint drag (dragMidpoints)', () => {
    it('inserts the node where the midpoint is dropped, not at the midpoint', () => {
        const onInsert = vi.fn();
        const onPreviewInsert = vi.fn();
        const { made, topology } = layer({ dragMidpoints: true, onInsert, onPreviewInsert });
        const edge = sharedEdge(topology);
        const mid = made.markers.find(m => m.options.icon.className.includes('geom-handle--mid')
            && m.latlng.lng === 10 && m.latlng.lat === 5);
        expect(mid.options.draggable).toBe(true);
        mid.setLatLng([5, 12]);
        mid.fire('drag', { target: mid });
        mid.fire('dragend', { target: mid });
        expect(onPreviewInsert).toHaveBeenCalledWith(edge.id, [12, 5], topology);
        expect(onInsert).toHaveBeenCalledWith(edge.id, [12, 5], topology);
    });

    it('keeps midpoints click-only by default', () => {
        const { made } = layer({});
        const mid = made.markers.find(m => m.options.icon.className.includes('geom-handle--mid'));
        expect(mid.options.draggable).toBe(false);
    });
});
