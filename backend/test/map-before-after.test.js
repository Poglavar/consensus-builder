// The shared before/after session (ui/map-before-after.js) without a browser: the clip maths, the
// tile cloning, the gesture freeze and the teardown, over a fake Leaflet and a fake document.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MapBeforeAfter = require('../../frontend/js/ui/map-before-after.js');
const control = require('../../frontend/js/ui/map-compare-control.js');

class FakeElement {
    constructor(doc, tag) {
        this.ownerDocument = doc; this.tagName = tag; this.children = []; this.parent = null;
        this.className = ''; this.textContent = ''; this.style = {}; this.attributes = new Map();
        this.listeners = new Map(); this.clientWidth = 600;
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, new Set()).get(type)).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    getBoundingClientRect() { return { left: 0, width: this.clientWidth }; }
    focus() {}
    find(className) {
        return this.children.find(child => child.className.split(' ').includes(className));
    }
}

function fakeDocument() {
    const doc = {
        listeners: new Map(),
        createElement(tag) { return new FakeElement(doc, tag); },
        addEventListener(type, fn) { (doc.listeners.get(type) || doc.listeners.set(type, new Set()).get(type)).add(fn); },
        removeEventListener(type, fn) { doc.listeners.get(type)?.delete(fn); },
        defaultView: { addEventListener() {}, removeEventListener() {} }
    };
    return doc;
}

class FakeHandler {
    constructor(on) { this.on = on; this.calls = []; }
    enabled() { return this.on; }
    enable() { this.on = true; this.calls.push('enable'); }
    disable() { this.on = false; this.calls.push('disable'); }
}

class FakeTileLayer {
    constructor(url, options) { this._url = url; this.options = options; }
    addTo(map) { map.layers.push(this); return this; }
}

class FakeMap {
    constructor(el, options = {}) {
        this.el = el; this.options = options; this.layers = []; this.events = new Map();
        this.view = null; this.invalidated = 0; this.removed = false;
        for (const name of MapBeforeAfter.FROZEN_HANDLERS) this[name] = new FakeHandler(name !== 'keyboard');
    }
    getContainer() { return this.el; }
    eachLayer(fn) { this.layers.forEach(fn); }
    getCenter() { return { lat: 45.8, lng: 16 }; }
    getZoom() { return 17; }
    getMaxZoom() { return 23; }
    getMinZoom() { return 3; }
    setView(center, zoom) { this.view = { center, zoom }; return this; }
    invalidateSize() { this.invalidated += 1; }
    remove() { this.removed = true; }
    on(types, fn) { types.split(' ').forEach(type => (this.events.get(type) || this.events.set(type, new Set()).get(type)).add(fn)); }
    off(types, fn) { types.split(' ').forEach(type => this.events.get(type)?.delete(fn)); }
    fire(type) { [...(this.events.get(type) || [])].forEach(fn => fn()); }
}

const L = { map: (el, options) => new FakeMap(el, options), tileLayer: (url, options) => new FakeTileLayer(url, options), TileLayer: FakeTileLayer };

function hostMap() {
    const doc = fakeDocument();
    const container = doc.createElement('div');
    const map = new FakeMap(container, { zoomSnap: 0.5 });
    map.layers.push(new FakeTileLayer('https://tiles.example/{z}/{x}/{y}.png', { maxZoom: 23, maxNativeZoom: 19 }));
    map.layers.push({ geojson: true });
    map.layers.push(new FakeTileLayer('', {}));
    return { doc, container, map };
}

describe('MapBeforeAfter.clipInset', () => {
    it('keeps the phone grip between the editor toolbar and bottom sheet as they resize', () => {
        const top = MapBeforeAfter.exposedGripTop(844, 211, [[10, 50], [68, 313], [363, 784]]);
        expect(top - 22).toBeGreaterThan(313);
        expect(top + 22).toBeLessThan(363);
        expect(MapBeforeAfter.exposedGripTop(844, 211, [[10, 50], [68, 260], [363, 784]]))
            .toBeLessThan(top);
        expect(MapBeforeAfter.exposedGripTop(844, 211, [[10, 50], [406, 784]])).toBe(211);
        expect(MapBeforeAfter.exposedGripTop(844, 211, [[0, 844]])).toBeNull();
    });

    it('clips the before map away from the right edge and clamps the percentage', () => {
        expect(MapBeforeAfter.clipInset(800, 25)).toEqual({ x: 200, clipPath: 'inset(0 600px 0 0)' });
        expect(MapBeforeAfter.clipInset(800, 150)).toEqual({ x: 800, clipPath: 'inset(0 0px 0 0)' });
        expect(MapBeforeAfter.clipInset(800, -5)).toEqual({ x: 0, clipPath: 'inset(0 800px 0 0)' });
        expect(MapBeforeAfter.clipInset(NaN, 50)).toEqual({ x: 0, clipPath: 'inset(0 0px 0 0)' });
    });
});

describe('MapBeforeAfter.tileLayerSpecs', () => {
    it('lists the host map\'s raster tile sources with copied options and skips everything else', () => {
        const { map } = hostMap();
        const specs = MapBeforeAfter.tileLayerSpecs(map, L);
        expect(specs).toEqual([{ url: 'https://tiles.example/{z}/{x}/{y}.png', options: { maxZoom: 23, maxNativeZoom: 19 } }]);
        expect(specs[0].options).not.toBe(map.layers[0].options);
        expect(MapBeforeAfter.tileLayerSpecs(null, L)).toEqual([]);
        expect(MapBeforeAfter.tileLayerSpecs(map, {})).toEqual([]);
    });
});

describe('MapBeforeAfter.attach', () => {
    it('repositions the image divider when the picture loads and disconnects on close', () => {
        let onResize;
        const observe = vi.fn(), disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback) { onResize = callback; }
            observe = observe;
            disconnect = disconnect;
        });
        try {
            const doc = fakeDocument();
            const container = doc.createElement('div');
            const before = doc.createElement('img');
            container.clientWidth = 0;
            const divider = MapBeforeAfter.attachDivider(container, before, { control, percent: 25 });
            expect(observe).toHaveBeenCalledWith(container);
            container.clientWidth = 160;
            onResize();
            expect(divider.handleEl.style.left).toBe('40px');
            expect(before.style.clipPath).toBe('inset(0 120px 0 0)');
            divider.dispose();
            expect(disconnect).toHaveBeenCalledOnce();
            container.clientWidth = 400;
            onResize();
            expect(divider.handleEl.style.left).toBe('40px');
        } finally { vi.unstubAllGlobals(); }
    });

    it('builds the before map on the host\'s tiles and view, freezes only the gestures that were on, and clips at the divider', () => {
        const { container, map } = hostMap();
        const drawBefore = vi.fn();
        const session = MapBeforeAfter.attach(map, {
            L, control, drawBefore, labels: { before: 'Prije', after: 'Poslije' }, sliderLabel: 'Usporedba'
        });

        const beforeEl = container.find('map-compare__before');
        const handleEl = container.find('map-compare__handle');
        expect(beforeEl).toBeDefined();
        expect(session.beforeEl).toBe(beforeEl);
        expect(session.beforeMap.el).toBe(beforeEl);
        expect(session.beforeMap.layers.map(layer => layer._url)).toEqual(['https://tiles.example/{z}/{x}/{y}.png']);
        expect(session.beforeMap.layers[0].options).toEqual({ maxZoom: 23, maxNativeZoom: 19 });
        expect(session.beforeMap.options).toMatchObject({ zoomControl: false, dragging: false, maxZoom: 23, minZoom: 3, zoomSnap: 0.5 });
        expect(session.beforeMap.view).toEqual({ center: { lat: 45.8, lng: 16 }, zoom: 17 });
        expect(drawBefore).toHaveBeenCalledWith(session.beforeMap);
        expect(container.find('map-compare__label--before').textContent).toBe('Prije');
        expect(container.find('map-compare__label--after').textContent).toBe('Poslije');
        expect(handleEl.getAttribute('role')).toBe('slider');
        expect(handleEl.getAttribute('aria-label')).toBe('Usporedba');
        expect(handleEl.children[0].className).toBe('map-compare__grip');

        // 600 px wide, divider at 50 %: the before map keeps its left half.
        expect(beforeEl.style.clipPath).toBe('inset(0 300px 0 0)');
        expect(handleEl.style.left).toBe('300px');
        expect(session.getPercent()).toBe(50);

        // The keyboard handler was already off on the host, so it is left alone.
        for (const name of ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom']) {
            expect(map[name].calls).toEqual(['disable']);
        }
        expect(map.keyboard.calls).toEqual([]);
    });

    it('follows the divider, follows programmatic host moves, and leaves nothing behind on dispose', () => {
        const { container, map } = hostMap();
        const session = MapBeforeAfter.attach(map, { L, control, percent: 20 });
        const beforeEl = session.beforeEl;
        const handleEl = session.handleEl;
        expect(beforeEl.style.clipPath).toBe('inset(0 480px 0 0)');

        expect(session.setPercent(75)).toBe(75);
        expect(beforeEl.style.clipPath).toBe('inset(0 150px 0 0)');
        expect(handleEl.style.left).toBe('450px');
        expect(handleEl.getAttribute('aria-valuenow')).toBe('75');

        // Keyboard on the handle goes through the shared control.
        const keydown = [...handleEl.listeners.get('keydown')][0];
        keydown({ key: 'End', cancelable: true, preventDefault() {} });
        expect(session.getPercent()).toBe(100);
        expect(beforeEl.style.clipPath).toBe('inset(0 0px 0 0)');

        // A resize or a fly-to on the host re-measures and re-centres the before map.
        const before = session.beforeMap;
        const invalidated = before.invalidated;
        container.clientWidth = 1000;
        map.fire('resize');
        expect(before.invalidated).toBe(invalidated + 1);
        expect(before.view).toEqual({ center: { lat: 45.8, lng: 16 }, zoom: 17 });
        expect(handleEl.style.left).toBe('1000px');

        session.dispose();
        expect(before.removed).toBe(true);
        expect(container.children).toEqual([]);
        for (const name of ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom']) {
            expect(map[name].calls).toEqual(['disable', 'enable']);
            expect(map[name].enabled()).toBe(true);
        }
        expect(map.keyboard.calls).toEqual([]);
        expect(map.events.get('resize').size).toBe(0);
        map.fire('resize');
        expect(before.invalidated).toBe(invalidated + 1);
        session.dispose(); // idempotent
        expect(map.dragging.calls).toEqual(['disable', 'enable']);
    });

    it('can seat the labels beside the grip for maps whose corners are covered', () => {
        const { container, map } = hostMap();
        const session = MapBeforeAfter.attach(map, { L, control, labels: { before: 'B', after: 'A' }, labelPlacement: 'divider' });
        expect(container.find('map-compare__label--before')).toBeUndefined();
        const onHandle = session.handleEl.children.filter(child => child.className.includes('map-compare__label'));
        expect(onHandle.map(el => el.className)).toEqual([
            'map-compare__label map-compare__label--before map-compare__label--divider',
            'map-compare__label map-compare__label--after map-compare__label--divider'
        ]);
        expect(onHandle.map(el => el.textContent)).toEqual(['B', 'A']);
        session.dispose();
        expect(container.children).toEqual([]);
    });

    it('runs the divider alone over two stacked elements, for the bet dialog\'s two pictures', () => {
        const doc = fakeDocument();
        const container = doc.createElement('div');
        const after = doc.createElement('img');
        const before = doc.createElement('img');
        container.appendChild(after);
        container.appendChild(before);
        container.clientWidth = 400;
        const divider = MapBeforeAfter.attachDivider(container, before, { control, labels: { before: 'B', after: 'A' }, percent: 25 });
        expect(before.style.clipPath).toBe('inset(0 300px 0 0)');
        expect(divider.handleEl.style.left).toBe('100px');
        expect(divider.handleEl.getAttribute('role')).toBe('slider');
        expect(container.find('map-compare__label--before').textContent).toBe('B');
        expect(divider.setPercent(50)).toBe(50);
        expect(before.style.clipPath).toBe('inset(0 200px 0 0)');
        divider.dispose();
        expect(container.children).toEqual([after, before]);
        expect(() => MapBeforeAfter.attachDivider(container, null, { control })).toThrow(/before element/);
    });

    it('can leave the host live when asked, and refuses to run without Leaflet or the control', () => {
        const { map } = hostMap();
        const session = MapBeforeAfter.attach(map, { L, control, freeze: false });
        expect(map.dragging.calls).toEqual([]);
        session.dispose();
        expect(map.dragging.calls).toEqual([]);
        expect(() => MapBeforeAfter.attach(map, { control })).toThrow(/Leaflet/);
        expect(() => MapBeforeAfter.attach(map, { L, control: { mount: null } })).toThrow(/MapCompareControl/);
    });
});
