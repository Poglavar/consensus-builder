// Exercise the real globe wheel/pointer/flight/frame functions without constructing WebGL or a DOM.
// AST extraction keeps the harness bound to the declarations that the browser actually runs.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const GlobeMath = require('../../frontend/js/world/globe-math.js');
const source = readFileSync(process.env.GLOBE_ZOOM_TEST_SOURCE || new URL('../../frontend/js/world/globe.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script' });

function extractFunction(name, { optional = false } = {}) {
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    if (!matches.length && optional) return '';
    if (matches.length !== 1) throw new Error(`Expected one ${name} declaration, found ${matches.length}`);
    return source.slice(matches[0].start, matches[0].end);
}

const globeFunctions = [
    ...['onWheel', 'onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onCanvasKey', 'fly', 'frame'].map(name => extractFunction(name)),
    extractFunction('zoomTo', { optional: true })
].join('\n');

function extractRegistration(type, handler) {
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression') {
            const call = node.expression;
            const object = call.callee?.object?.name;
            const property = call.callee?.property?.name;
            if ((object === 'root' || object === 'canvas') && property === 'addEventListener'
                && call.arguments[0]?.value === type && call.arguments[1]?.name === handler) {
                matches.push(node);
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    if (matches.length !== 1) throw new Error(`Expected one ${type} listener registration, found ${matches.length}`);
    return source.slice(matches[0].start, matches[0].end);
}

const registrations = [
    ['wheel', 'onWheel'], ['pointerdown', 'onPointerDown'], ['pointermove', 'onPointerMove'],
    ['pointerup', 'onPointerUp'], ['pointercancel', 'onPointerCancel'], ['lostpointercapture', 'onPointerCancel']
].map(([type, handler]) => extractRegistration(type, handler)).join('\n');

function harness({ reduceMotion = false, altitudeKm = 10000 } = {}) {
    const context = {
        GlobeMath,
        reduceMotion,
        altitudeKm,
        labelNode: targetFor('world-city-label'),
        performance: { now: () => 1000 }
    };
    vm.createContext(context);
    vm.runInContext(`
        const GM = GlobeMath;
        const MIN_USER_ALT_KM = 1500;
        const MAX_ALT_KM = 42000;
        const IDLE_DELAY_MS = 3500;
        const IDLE_SPIN_DEG_PER_S = 4;
        const TAP_MAX_PX = 8;
        const TAP_MAX_MS = 300;
        const reduce = reduceMotion;
        const cam = { lat: 0, lon: 0, altitudeKm };
        const vel = { lat: 0, lon: 0 };
        const viewport = { w: 1000, h: 800 };
        const rootListeners = new Map();
        const canvasListeners = new Map();
        const captures = [];
        const selections = [];
        const picks = [];
        const liveLabels = [{ node: labelNode, city: { lat: 41, lon: 29 } }];
        const coverage = { tierAt: (lat, lon) => ({ lat, lon, kind: 'live-city' }) };
        function rememberListener(registry, type, listener, options) {
            const entries = registry.get(type) || [];
            entries.push({ listener, options });
            registry.set(type, entries);
        }
        const canvas = {
            addEventListener(type, listener, options) { rememberListener(canvasListeners, type, listener, options); },
            setPointerCapture(pointerId) { captures.push(pointerId); }
        };
        const renderer = { domElement: canvas };
        const root = {
            classList: { contains: () => false },
            addEventListener(type, listener, options) { rememberListener(rootListeners, type, listener, options); }
        };
        const pointers = new Map();
        const document = { hidden: false };
        let lastInteraction = 0;
        let flight = null;
        let zoomTarget = null;
        let selected = null;
        let dirty = true;
        let raf = 0;
        let lastFrame = 1000;
        let closed = false;
        let drag = null;
        let pinch = null;
        let touches = 0;
        let schedules = 0;
        const renders = [];
        function touch() { lastInteraction = performance.now(); dirty = true; touches += 1; }
        function render(now) { renders.push({ now, altitudeKm: cam.altitudeKm }); dirty = false; }
        function schedule() { schedules += 1; }
        function stepFlight() {}
        function degPerPx() { return 0.1; }
        function pickAt(x, y) { picks.push({ x, y }); }
        function select(place) { selections.push(place); }
        ${globeFunctions}
        ${registrations}
        this.api = { onWheel, zoomTo: typeof zoomTo === 'function' ? zoomTo : null, onPointerDown, onCanvasKey, fly, frame };
        this.listeners = { root: rootListeners, canvas: canvasListeners };
        this.fireRootWheel = event => {
            const registration = rootListeners.get('wheel')?.[0];
            if (!registration) return false;
            registration.listener(event);
            return true;
        };
        this.firePointer = (type, event) => {
            const registration = rootListeners.get(type)?.[0];
            if (!registration) return false;
            registration.listener(event);
            return true;
        };
        this.state = () => ({ ...cam, zoomTarget, flight, dirty, touches, schedules, renders,
            captures, selections, picks, activePointers: pointers.size });
    `, context);
    return context;
}

const targetFor = className => ({
    className,
    closest(selectors) {
        return selectors.split(',').some(selector => selector.trim() === `.${className}`) ? this : null;
    }
});

const wheel = (deltaY, deltaMode = 0, target = targetFor('world-view__canvas')) => ({
    deltaY, deltaMode, target, prevented: false,
    preventDefault() { this.prevented = true; }
});

describe('globe zoom lifecycle', () => {
    it('accumulates rapid wheel events against the target without jumping the camera', () => {
        const h = harness();
        const first = wheel(-120);
        h.api.onWheel(first);
        const firstTarget = 10000 * Math.exp(-120 * 0.0014);
        expect(first.prevented).toBe(true);
        expect(h.state().altitudeKm).toBe(10000);
        expect(h.state().zoomTarget).toBeCloseTo(firstTarget, 9);

        h.api.onWheel(wheel(-120));
        expect(h.state().zoomTarget).toBeCloseTo(firstTarget * Math.exp(-120 * 0.0014), 9);
    });

    it('registers the non-passive wheel handler on the root so a bubbling city-label wheel zooms', () => {
        const h = harness();
        const rootRegistration = h.listeners.root.get('wheel')?.[0];
        expect(rootRegistration).toBeDefined();
        expect(rootRegistration.options).toEqual({ passive: false });
        expect(h.listeners.canvas.has('wheel')).toBe(false);

        const event = wheel(-120, 0, targetFor('world-city-label'));
        expect(h.fireRootWheel(event)).toBe(true);
        expect(event.prevented).toBe(true);
        expect(h.state().altitudeKm).toBe(10000);
        expect(h.state().zoomTarget).toBeCloseTo(10000 * Math.exp(-120 * 0.0014), 9);
    });

    it.each(['world-search', 'world-activity', 'world-popup', 'world-view__close', 'world-legend'])(
        'leaves native scrolling alone over .%s', className => {
            const h = harness();
            const event = wheel(-120, 0, targetFor(className));
            h.api.onWheel(event);
            expect(event.prevented).toBe(false);
            expect(h.state().altitudeKm).toBe(10000);
            expect(h.state().zoomTarget).toBeNull();
        }
    );

    it('prevents native wheel scrolling but does not change camera during a flight', () => {
        const h = harness();
        h.api.fly({ lat: 10, lon: 20, altitudeKm: 2500 });
        const event = wheel(-120, 0, targetFor('world-city-label'));
        expect(h.fireRootWheel(event)).toBe(true);
        expect(event.prevented).toBe(true);
        expect(h.state().altitudeKm).toBe(10000);
        expect(h.state().zoomTarget).toBeNull();
    });

    it('clamps wheel targets at both user zoom limits', () => {
        const h = harness();
        h.api.onWheel(wheel(-10000));
        expect(h.state().zoomTarget).toBe(1500);
        h.api.onWheel(wheel(10000));
        expect(h.state().zoomTarget).toBe(42000);
    });

    it('advances the actual frame camera smoothly and clears the target when settled', () => {
        const h = harness();
        h.api.onWheel(wheel(-120));
        const target = h.state().zoomTarget;
        h.api.frame(1016);
        const firstFrameAltitude = h.state().altitudeKm;
        expect(firstFrameAltitude).toBeLessThan(10000);
        expect(firstFrameAltitude).toBeGreaterThan(target);
        expect(h.state().zoomTarget).toBe(target);
        expect(h.state().renders).toHaveLength(1);

        for (let now = 1032; h.state().zoomTarget !== null && now < 10000; now += 16) h.api.frame(now);
        expect(h.state().altitudeKm).toBe(target);
        expect(h.state().zoomTarget).toBeNull();
    });

    it('applies reduced-motion wheel zoom immediately and leaves no pending target', () => {
        const h = harness({ reduceMotion: true });
        h.api.onWheel(wheel(-120));
        expect(h.state().altitudeKm).toBeCloseTo(10000 * Math.exp(-120 * 0.0014), 9);
        expect(h.state().zoomTarget).toBeNull();
    });

    it('cancels the pending zoom when pointer interaction starts', () => {
        const h = harness();
        h.api.onWheel(wheel(-120));
        expect(h.state().zoomTarget).not.toBeNull();
        h.api.onPointerDown({ pointerId: 1, button: 0, clientX: 20, clientY: 30, target: targetFor('world-view__canvas') });
        expect(h.state().zoomTarget).toBeNull();
    });

    it('cancels the pending zoom when a flight takes over', () => {
        const h = harness();
        h.api.onWheel(wheel(-120));
        expect(h.state().zoomTarget).not.toBeNull();
        h.api.fly({ lat: 10, lon: 20, altitudeKm: 2500 });
        expect(h.state().zoomTarget).toBeNull();
        expect(h.state().flight).toMatchObject({ to: { lat: 10, lon: 20, altitudeKm: 2500 } });
    });

    it.each([['+', 10000 / 1.3], ['-', 10000 * 1.3]])('routes %s keyboard zoom through the same target-based path', (key, target) => {
        const h = harness();
        h.api.onCanvasKey({ key, preventDefault() {} });
        expect(h.state().altitudeKm).toBe(10000);
        expect(h.state().zoomTarget).toBeCloseTo(target, 9);
    });
});

describe('globe gestures starting on city labels', () => {
    const pointer = (h, x = 20, y = 30, pointerId = 1, target = h.labelNode) => ({
        pointerId, target, button: 0, clientX: x, clientY: y
    });

    it('captures a label drag on the canvas and rotates without selecting the city', () => {
        const h = harness({ reduceMotion: true });
        expect(h.firePointer('pointerdown', pointer(h))).toBe(true);
        expect(h.state().captures).toEqual([1]);
        expect(h.listeners.canvas.has('pointerdown')).toBe(false);
        h.firePointer('pointermove', pointer(h, 90, 50, 1, targetFor('world-view__canvas')));
        h.firePointer('pointerup', pointer(h, 90, 50, 1, targetFor('world-view__canvas')));
        expect(h.state()).toMatchObject({ lon: -7, lat: 2, activePointers: 0, selections: [], picks: [] });
    });

    it('selects the label city on a tap even though pointerup lands on the captured canvas', () => {
        const h = harness();
        h.firePointer('pointerdown', pointer(h));
        h.firePointer('pointerup', pointer(h, 20, 30, 1, targetFor('world-view__canvas')));
        expect(h.state().selections).toEqual([{ lat: 41, lon: 29, kind: 'live-city' }]);
        expect(h.state().picks).toEqual([]);
    });

    it('still picks a coordinate for an ordinary canvas tap', () => {
        const h = harness();
        const event = pointer(h, 40, 50, 1, targetFor('world-view__canvas'));
        h.firePointer('pointerdown', event);
        h.firePointer('pointerup', event);
        expect(h.state().picks).toEqual([{ x: 40, y: 50 }]);
        expect(h.state().selections).toEqual([]);
    });

    it('pinches from a label and canvas without treating either finger release as a tap', () => {
        const h = harness();
        h.firePointer('pointerdown', pointer(h, 20, 30));
        h.firePointer('pointerdown', pointer(h, 120, 30, 2, targetFor('world-view__canvas')));
        h.firePointer('pointermove', pointer(h, 220, 30, 2));
        expect(h.state().altitudeKm).toBe(5000);
        h.firePointer('pointerup', pointer(h, 220, 30, 2));
        h.firePointer('pointerup', pointer(h, 20, 30));
        expect(h.state()).toMatchObject({ activePointers: 0, selections: [], picks: [] });
    });

    it.each(['pointercancel', 'lostpointercapture'])('does not select after %s', type => {
        const h = harness();
        h.firePointer('pointerdown', pointer(h));
        h.firePointer(type, pointer(h));
        h.firePointer('pointerup', pointer(h));
        expect(h.state()).toMatchObject({ activePointers: 0, selections: [], picks: [] });
    });

    it.each(['world-search', 'world-activity', 'world-popup', 'world-view__close', 'world-legend__toggle'])(
        'leaves .%s pointer interactions to the control', className => {
            const h = harness();
            const event = pointer(h, 20, 30, 1, targetFor(className));
            h.firePointer('pointerdown', event);
            h.firePointer('pointermove', { ...event, clientX: 100 });
            h.firePointer('pointerup', event);
            expect(h.state()).toMatchObject({ lon: 0, lat: 0, captures: [], selections: [], picks: [] });
        }
    );
});
