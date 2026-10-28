// Real placement controller behavior without a browser: pointer navigation, taps and ownership.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Placement = require('../../frontend/js/freeform-placement.js');
const THREE = require('three');

function harness(model = false) {
    const handlers = new Map(), hit = {};
    const container = { style: { cursor: 'grab' }, contains: target => target === hit };
    const outline = { addTo() { return this; }, clearLayers: vi.fn(), addData: vi.fn(), remove: vi.fn() };
    const env = { document: {
        addEventListener: (name, fn) => handlers.set(name, fn),
        removeEventListener: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name); }
    }, L: { geoJSON: () => outline }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const scene = new THREE.Scene();
    const pick = vi.fn(() => ({ lat: 30, lng: 20 }));
    if (model) Object.assign(env, { THREE, isThreeModeActive: () => true, getThreeModeInternals: () => ({
        scene, renderer: { domElement: hit }, pickGroundLatLng: pick, latLngToXY: (lat, lng) => [lng, lat]
    }) });
    const map = { getContainer: () => container, getCenter: () => ({ lat: 1, lng: 2 }),
        mouseEventToLatLng: event => ({ lat: event.clientY, lng: event.clientX }) };
    const onPlace = vi.fn();
    const runtime = Placement.start({ map, pane: 'edit', buildFootprint: center => ({ geometry: {
        type: 'Polygon', coordinates: [[[center.lng, center.lat], [center.lng + 1, center.lat],
            [center.lng + 1, center.lat + 1], [center.lng, center.lat]]] }
    }), onPlace }, env);
    const fire = (name, extra = {}) => handlers.get(name)?.({ target: hit, clientX: 20, clientY: 30,
        button: 0, pointerId: 1, pointerType: 'mouse', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });
    return { fire, runtime, handlers, outline, onPlace, container, scene, pick };
}

describe('new Freeform placement', () => {
    it('carries an outline, then consumes one click and cleans up ownership', () => {
        const h = harness();
        h.fire('pointermove');
        expect(h.outline.addData).toHaveBeenLastCalledWith(expect.objectContaining({ geometry: expect.objectContaining({
            coordinates: [[[20, 30], [21, 30], [21, 31], [20, 30]]]
        }) }));
        expect(h.onPlace).not.toHaveBeenCalled();
        h.fire('pointerdown'); h.fire('pointerup'); h.fire('click');
        expect(h.onPlace).toHaveBeenCalledOnce();
        expect(h.handlers.size).toBe(0);
        expect(h.outline.remove).toHaveBeenCalledOnce();
        expect(h.container.style.cursor).toBe('grab');
        h.fire('click');
        expect(h.onPlace).toHaveBeenCalledOnce();
    });
    it('lets a pan finish without placing, then accepts a fresh tap', () => {
        const h = harness();
        h.fire('pointerdown'); h.fire('pointermove', { clientX: 40 }); h.fire('pointerup'); h.fire('click');
        expect(h.onPlace).not.toHaveBeenCalled();
        h.fire('pointerdown', { pointerType: 'touch' }); h.fire('pointerup'); h.fire('click');
        expect(h.onPlace).toHaveBeenCalledOnce();
    });
    it('never turns a pinch or cancelled touch into placement and cancels cleanly', () => {
        const h = harness();
        h.fire('pointerdown'); h.fire('pointerdown', { pointerId: 2 });
        h.fire('pointerup'); h.fire('pointerup', { pointerId: 2 }); h.fire('click');
        expect(h.onPlace).not.toHaveBeenCalled();
        h.fire('pointerdown'); h.fire('pointercancel'); h.fire('click');
        expect(h.onPlace).not.toHaveBeenCalled();
        h.runtime.destroy();
        expect(h.handlers.size).toBe(0);
        expect(h.container.style.cursor).toBe('grab');
    });
    it('uses the model ground pick and reuses one outline until placement', () => {
        const h = harness(true);
        const line = h.scene.children[0];
        h.fire('pointermove'); h.fire('pointermove');
        expect(h.scene.children).toEqual([line]);
        expect(h.pick).toHaveBeenCalledTimes(2);
        expect([...line.geometry.attributes.position.array].slice(0, 2)).toEqual([20, 30]);
        h.fire('pointerdown'); h.fire('pointerup'); h.fire('click');
        expect(h.onPlace).toHaveBeenCalledWith(expect.objectContaining({ geometry: expect.objectContaining({
            coordinates: [[[20, 30], [21, 30], [21, 31], [20, 30]]]
        }) }));
        expect(h.scene.children).toHaveLength(0);
    });
    it('places the carried outline with Enter while leaving control keys alone', () => {
        const h = harness();
        h.fire('keydown', { key: 'Enter', target: { closest: () => true } });
        expect(h.onPlace).not.toHaveBeenCalled();
        h.fire('keydown', { key: 'Enter' });
        expect(h.onPlace).toHaveBeenCalledOnce();
        expect(h.handlers.size).toBe(0);
    });
});
