// Phone dock regression coverage: tall-sheet geometry plus handles that must survive both a
// renderer replacing panel children and Explore creating the proposal panel after initial boot.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { limits, sheetHeight, draggedHeight, restingHeight, occupiedBottom, reportOccupancy, wirePanel, install } = require('../../frontend/js/mobile-dock-sheet.js');
const sheetSource = readFileSync(fileURLToPath(new URL('../../frontend/js/mobile-dock-sheet.js', import.meta.url)), 'utf8');
const panelsCss = readFileSync(fileURLToPath(new URL('../../frontend/css/panels.css', import.meta.url)), 'utf8');

// Evaluates the dock's compound selector (classes plus :not(#id) / :not(.class)) against a fake
// element's id and classes, so the test follows the real selector instead of comparing its text.
function matchesCompound(el, selector) {
    if (selector.includes(',')) return selector.split(',').some(part => matchesCompound(el, part.trim()));
    const negations = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(m => m[1]);
    const positive = selector.replace(/:not\([^)]+\)/g, '');
    const one = part => (part.startsWith('#') ? el.id === part.slice(1) : el.classes.includes(part.slice(1)));
    const required = positive.match(/[.#][\w-]+/g) || [];
    return required.every(one) && !negations.some(one);
}

function dockPanel({ id = 'parcel-info-panel', classes = ['info-panel', 'right-dock-panel'] } = {}) {
    const classSet = new Set(classes);
    return {
        nodeType: 1,
        id,
        classes,
        classList: {
            add(name) { classSet.add(name); },
            remove(name) { classSet.delete(name); },
            contains(name) { return classSet.has(name); }
        },
        handle: null,
        matches(selector) { return matchesCompound({ ...this, classes: [...classSet] }, selector); },
        querySelector(selector = '') {
            if (selector.includes('mobile-dock-sheet-handle')) return this.handle;
            if (selector.includes('form')) return null;
            if (selector.includes('close') || selector.includes('agreement-action')) return this.closeButton || null;
            return this.handle;
        },
        querySelectorAll() { return []; },
        insertBefore(handle) { this.handle = handle; }
    };
}

function controllerFixture({ height = 350, close = () => {} } = {}) {
    const panel = dockPanel();
    const styleValues = new Map();
    panel.style = {
        setProperty(name, value) { styleValues.set(name, value); },
        getPropertyValue(name) { return styleValues.get(name) || ''; }
    };
    panel.getBoundingClientRect = () => ({ height: Number.parseFloat(styleValues.get('--mobile-sheet-height')) || height, top: 0 });
    let closeCount = 0;
    panel.closeButton = { click() { closeCount += 1; close(); } };
    const listeners = new Map();
    const handle = {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        addEventListener(type, fn) { listeners.set(type, fn); },
        setPointerCapture() {},
        releasePointerCapture() {}
    };
    const win = {
        innerHeight: 800,
        document: { createElement() { return handle; }, getElementById() { return null; } },
        matchMedia() { return { matches: true }; },
        getComputedStyle() { return { getPropertyValue() { return '0px'; } }; }
    };
    wirePanel(win, panel, { close: () => { closeCount += 1; close(); } });
    return {
        panel, handle, listeners,
        closeCount: () => closeCount,
        fire(type, event = {}) {
            let prevented = false;
            listeners.get(type)?.({ pointerId: 1, clientY: 0, preventDefault() { prevented = true; }, ...event, get defaultPrevented() { return prevented; } });
        }
    };
}

function installWithObserver() {
    const mutationCallbacks = [];
    const mutationObservers = [];
    const win = {
        document: {
            readyState: 'complete',
            body: {},
            getElementById(id) { return id === 'map-container' ? {} : null; },
            querySelectorAll() { return []; },
            createElement() {
                return { className: '', classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} };
            }
        },
        MutationObserver: class {
            constructor(callback) {
                mutationCallbacks.push(callback);
                this.disconnected = false;
                this.disconnect = () => { this.disconnected = true; };
                mutationObservers.push(this);
            }
            observe() {}
        },
        addEventListener() {}
    };
    install(win);
    return {
        added: nodes => mutationCallbacks[0]([{ addedNodes: nodes }]),
        removed: nodes => mutationCallbacks[0]([{ addedNodes: [], removedNodes: nodes }]),
        mutationObservers
    };
}

describe('mobile dock sheet geometry', () => {
    it('makes map tools tall sheets with visible, touch-safe drag handles', () => {
        expect(sheetSource).toMatch(/DEFAULT_RATIO = 0\.5/);
        expect(sheetSource).toMatch(/MIN_RATIO = 0\.25/);
        expect(sheetSource).toMatch(/MIN_PIXELS = 200/);
        expect(sheetSource).toMatch(/SURFACE_SELECTOR = PANEL_SELECTOR \+ ', \.map-sheet, \.cb-dialog/);
        expect(panelsCss).toMatch(/\.mobile-dock-sheet-handle\s*\{[\s\S]*?touch-action:\s*none/);
    });

    it('defaults to half-height while leaving room for map chrome', () => {
        const height = sheetHeight({ viewportHeight: 568, topClearance: 62, bottomClearance: 62 });
        expect(height).toBe(568 * 0.5);
        expect(height).toBeLessThanOrEqual(568 - 62 - 62 - 8);
    });

    it('keeps a usable minimum height on a 320px-wide phone and caps a drag before the top chrome', () => {
        const range = limits(568, 62, 62);
        expect(range.min).toBe(200);
        expect(draggedHeight({ startHeight: 300, deltaY: -600, viewportHeight: 568, topClearance: 62, bottomClearance: 62 })).toBe(range.max);
        expect(draggedHeight({ startHeight: 300, deltaY: 600, viewportHeight: 568, topClearance: 62, bottomClearance: 62 })).toBe(range.min);
    });

    it('uses the available height when a short viewport cannot satisfy the normal minimum', () => {
        const range = limits(300, 90, 90);
        expect(range.min).toBe(range.max);
        expect(sheetHeight({ viewportHeight: 300, topClearance: 90, bottomClearance: 90 })).toBe(range.max);
    });

    it('treats missing dimensions as missing instead of coercing null to a zero-height sheet', () => {
        expect(sheetHeight({ viewportHeight: 568, topClearance: null, bottomClearance: null })).toBeGreaterThan(0);
        expect(sheetHeight({ viewportHeight: 568, desiredHeight: null })).toBe(568 * 0.5);
    });

    it('does not wire a hosted proposal details panel with its own nested handle', () => {
        const { added } = installWithObserver();
        const hosted = dockPanel({ id: 'proposal-details-panel', classes: ['info-panel', 'right-dock-panel', 'is-hosted'] });
        added([hosted]);
        expect(hosted.handle).toBeNull();
    });

    it('preserves an open sheet when pointer interaction is cancelled', () => {
        const fixture = controllerFixture({ height: 350 });
        fixture.fire('pointerdown', { clientY: 200 });
        fixture.fire('pointermove', { clientY: 260 });
        fixture.fire('pointercancel', { clientY: 260, type: 'pointercancel' });
        expect(fixture.closeCount()).toBe(0);
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('290px');
    });

    it('follows the finger while dragged, then rests at the nearer of half and full height', () => {
        const fixture = controllerFixture({ height: 350 });
        fixture.fire('pointerdown', { clientY: 200, timeStamp: 0 });
        fixture.fire('pointermove', { clientY: 100, timeStamp: 400 });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('450px');
        fixture.fire('pointerup', { clientY: 100, type: 'pointerup', timeStamp: 800 });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('400px');
        expect(fixture.panel.style.getPropertyValue('--mobile-dock-sheet-height')).toBe('400px');
        // Slowly up past the middle: full height.
        fixture.fire('pointerdown', { clientY: 400, timeStamp: 1000 });
        fixture.fire('pointermove', { clientY: 150, timeStamp: 2000 });
        fixture.fire('pointerup', { clientY: 150, type: 'pointerup', timeStamp: 2400 });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('792px');
        expect(fixture.closeCount()).toBe(0);
    });

    it('a flick picks the next resting height in its direction, and a flick down from half closes', () => {
        const fixture = controllerFixture({ height: 400 });
        // 30 px up in 20 ms: barely moved, but a flick, so full height.
        fixture.fire('pointerdown', { clientY: 400, timeStamp: 0 });
        fixture.fire('pointermove', { clientY: 370, timeStamp: 20 });
        fixture.fire('pointerup', { clientY: 370, type: 'pointerup', timeStamp: 30 });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('792px');
        fixture.fire('pointerdown', { clientY: 100, timeStamp: 100 });
        fixture.fire('pointermove', { clientY: 140, timeStamp: 120 });
        fixture.fire('pointerup', { clientY: 140, type: 'pointerup', timeStamp: 130 });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('400px');
        expect(fixture.closeCount()).toBe(0);
        fixture.fire('pointerdown', { clientY: 400, timeStamp: 200 });
        fixture.fire('pointermove', { clientY: 440, timeStamp: 220 });
        fixture.fire('pointerup', { clientY: 440, type: 'pointerup', timeStamp: 230 });
        expect(fixture.closeCount()).toBe(1);
    });

    it('rests a released height at half, full or closed', () => {
        const stops = { half: 400, full: 792, min: 200 };
        expect(restingHeight({ height: 500, ...stops })).toBe(400);
        expect(restingHeight({ height: 650, ...stops })).toBe(792);
        expect(restingHeight({ height: 250, ...stops })).toBe(400);
        expect(restingHeight({ height: 140, ...stops })).toBe(null);
        expect(restingHeight({ height: 500, velocity: -0.8, ...stops })).toBe(792);
        expect(restingHeight({ height: 700, velocity: 0.8, ...stops })).toBe(400);
        expect(restingHeight({ height: 380, velocity: 0.8, ...stops })).toBe(null);
        expect(restingHeight({ height: 300, velocity: -0.8, ...stops })).toBe(400);
        // A short screen whose half and full coincide has one resting height.
        expect(restingHeight({ height: 300, velocity: -0.8, half: 320, full: 320, min: 200 })).toBe(320);
    });

    it('dismisses below the minimum drag threshold through the close callback once', () => {
        const fixture = controllerFixture({ height: 350 });
        fixture.fire('pointerdown', { clientY: 100 });
        fixture.fire('pointermove', { clientY: 400 });
        fixture.fire('pointerup', { clientY: 400, type: 'pointerup' });
        expect(fixture.closeCount()).toBe(1);
    });

    it('suppresses the synthetic tap after a drag, then tap toggles between half and full height', () => {
        const fixture = controllerFixture({ height: 350 });
        fixture.fire('pointerdown', { clientY: 100, timeStamp: 0 });
        fixture.fire('pointermove', { clientY: 120, timeStamp: 500 });
        fixture.fire('pointerup', { clientY: 120, type: 'pointerup', timeStamp: 900 });
        fixture.fire('click');
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('400px');
        fixture.fire('click');
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('792px');
        fixture.fire('click');
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('400px');
    });

    it('supports keyboard expansion, collapse, and Escape dismissal', () => {
        const fixture = controllerFixture({ height: 350 });
        fixture.fire('keydown', { key: 'ArrowUp' });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('414px');
        fixture.fire('keydown', { key: 'ArrowDown' });
        expect(fixture.panel.style.getPropertyValue('--mobile-sheet-height')).toBe('350px');
        fixture.fire('keydown', { key: 'Escape' });
        expect(fixture.closeCount()).toBe(1);
    });

    it('restores the handle when a panel renderer replaces its children', () => {
        const callbacks = [];
        const panel = {
            classes: [],
            classList: { add() {}, remove() {}, contains() { return false; } },
            handle: null,
            matches(selector) { return matchesCompound(this, selector); },
            querySelector(selector = '') { return selector.includes('mobile-dock-sheet-handle') ? this.handle : null; },
            insertBefore(handle) { this.handle = handle; },
            style: { getPropertyValue() { return ''; } }
        };
        const doc = {
            createElement() {
                return {
                    className: '',
                    classList: { add() {}, remove() {} },
                    setAttribute() {},
                    addEventListener() {}
                };
            }
        };
        const win = {
            document: doc,
            MutationObserver: class {
                constructor(callback) { callbacks.push(callback); }
                observe() {}
            }
        };
        wirePanel(win, panel);
        const first = panel.handle;
        panel.handle = null;
        callbacks[0]();
        expect(panel.handle).toBeTruthy();
        expect(panel.handle).not.toBe(first);
        expect(callbacks).toHaveLength(1);
    });

    it('wires a map tool sheet added after the initial page scan', () => {
        const { added } = installWithObserver();
        const panel = dockPanel();
        added([panel]);
        expect(panel.handle).toBeTruthy();
        // A mutation from inserting the handle is harmless: it is not a dock panel itself.
        added([{ nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } }]);
        expect(panel.handle).toBeTruthy();
    });

    it('makes the click stack and unhosted proposal reader sheets, but not a hosted panel', () => {
        const { added } = installWithObserver();
        const stack = dockPanel({ id: 'click-stack', classes: ['click-stack', 'info-panel', 'right-dock-panel'] });
        const hosted = dockPanel({ classes: ['info-panel', 'right-dock-panel', 'is-hosted'] });
        const reader = dockPanel({ id: 'proposal-details-panel' });
        added([stack, hosted, reader]);
        expect(stack.handle).toBeTruthy();
        expect(hosted.handle).toBeNull();
        expect(reader.handle).toBeTruthy();
    });

    it('reports what the open sheet occupies so the credits stay in the map', () => {
        expect(occupiedBottom({ viewportHeight: 844, top: 500 })).toBe(344);
        expect(occupiedBottom({ viewportHeight: 844, top: null })).toBe(0);
        const vars = new Map();
        const panel = { box: { top: 500, height: 344 }, getBoundingClientRect() { return this.box; } };
        const asked = [];
        const container = { style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) },
            querySelectorAll(selector) { asked.push(selector); return [panel]; } };
        const bodyClasses = new Set();
        let phone = true;
        const win = {
            innerHeight: 844,
            matchMedia: () => ({ matches: phone }),
            document: {
                body: { classList: { toggle: (name, on) => (on ? bodyClasses.add(name) : bodyClasses.delete(name)) } },
                getElementById(id) { return id === 'map-container' ? container : null; },
                querySelectorAll() { return [panel]; }
            }
        };
        reportOccupancy(win);
        expect(vars.get('--map-sheet-occupied')).toBe('344px');
        // An open sheet about the map covers the bottom bar; the bar's own sheets are not counted.
        expect(bodyClasses.has('mobile-context-sheet-open')).toBe(true);
        expect(asked.at(-1)).toContain(':not(.map-sheet--dock)');
        panel.box = { top: 437, height: 407 };
        reportOccupancy(win);
        expect(vars.get('--map-sheet-occupied')).toBe('407px');
        panel.box = { top: 0, height: 0 }; // closed
        reportOccupancy(win);
        expect(vars.has('--map-sheet-occupied')).toBe(false);
        expect(bodyClasses.has('mobile-context-sheet-open')).toBe(false);
        phone = false;
        panel.box = { top: 500, height: 344 };
        reportOccupancy(win);
        expect(vars.has('--map-sheet-occupied')).toBe(false);
    });

    it('boots as a classic browser script and translates an initial panel handle', () => {
        const panel = {
            nodeType: 1,
            handle: null,
            classList: { add() {}, remove() {}, contains() { return false; } },
            matches() { return true; },
            querySelector(selector = '') { return selector.includes('mobile-dock-sheet-handle') ? this.handle : null; },
            querySelectorAll() { return []; },
            style: { getPropertyValue() { return ''; }, setProperty() {} },
            insertBefore(handle) { this.handle = handle; }
        };
        const mapContainer = {};
        const visualHeight = new Map();
        const win = {
            innerHeight: 640,
            document: {
                readyState: 'complete',
                documentElement: { style: { setProperty(name, value) { visualHeight.set(name, value); } } },
                getElementById(id) { return id === 'map-container' ? mapContainer : null; },
                querySelectorAll() { return [panel]; },
                createElement() {
                    return {
                        className: '',
                        classList: { add() {}, remove() {} },
                        setAttribute() {},
                        addEventListener() {}
                    };
                }
            },
            MutationObserver: class { constructor() {} observe() {} },
            i18n: { applyTranslations(handle) { handle.translated = true; } },
            addEventListener() {}
        };
        vm.runInNewContext(sheetSource, { window: win, globalThis: win });
        expect(panel.handle).toBeTruthy();
        expect(panel.handle.translated).toBe(true);
        expect(visualHeight.get('--mobile-visual-height')).toBe('640px');
    });

    it('disconnects a removed surface’s child observer', () => {
        const { added, removed } = installWithObserver();
        const panel = dockPanel();
        added([panel]);
        const observer = panel.__mobileDockSheetObserver;
        expect(observer).toBeTruthy();
        panel.isConnected = false;
        removed([panel]);
        expect(observer.disconnected).toBe(true);
    });
});
