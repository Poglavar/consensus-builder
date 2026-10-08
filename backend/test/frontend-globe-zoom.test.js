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
    ...['onWheel', 'onPointerDown', 'onCanvasKey', 'fly', 'frame'].map(name => extractFunction(name)),
    extractFunction('zoomTo', { optional: true })
].join('\n');

function extractWheelRegistration() {
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression') {
            const call = node.expression;
            const object = call.callee?.object?.name;
            const property = call.callee?.property?.name;
            if ((object === 'root' || object === 'canvas') && property === 'addEventListener'
                && call.arguments[0]?.value === 'wheel' && call.arguments[1]?.name === 'onWheel') {
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
    if (matches.length !== 1) throw new Error(`Expected one wheel listener registration, found ${matches.length}`);
    return source.slice(matches[0].start, matches[0].end);
}

const wheelRegistration = extractWheelRegistration();

function harness({ reduceMotion = false, altitudeKm = 10000 } = {}) {
    const context = {
        GlobeMath,
        reduceMotion,
        altitudeKm,
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
        function rememberListener(registry, type, listener, options) {
            const entries = registry.get(type) || [];
            entries.push({ listener, options });
            registry.set(type, entries);
        }
        const canvas = {
            addEventListener(type, listener, options) { rememberListener(canvasListeners, type, listener, options); },
            setPointerCapture() {}
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
        function pickAt() {}
        ${globeFunctions}
        ${wheelRegistration}
        this.api = { onWheel, zoomTo: typeof zoomTo === 'function' ? zoomTo : null, onPointerDown, onCanvasKey, fly, frame };
        this.listeners = { root: rootListeners, canvas: canvasListeners };
        this.fireRootWheel = event => {
            const registration = rootListeners.get('wheel')?.[0];
            if (!registration) return false;
            registration.listener(event);
            return true;
        };
        this.state = () => ({ altitudeKm: cam.altitudeKm, zoomTarget, flight, dirty, touches, schedules, renders });
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

    it.each(['world-search', 'world-activity', 'world-popup', 'world-view__close'])(
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
        h.api.onPointerDown({ pointerId: 1, clientX: 20, clientY: 30 });
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
