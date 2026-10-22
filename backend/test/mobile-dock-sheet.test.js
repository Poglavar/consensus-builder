// Phone dock regression coverage: tall-sheet geometry plus handles that must survive both a
// renderer replacing panel children and Explore creating the proposal panel after initial boot.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { limits, sheetHeight, draggedHeight, occupiedBottom, reportOccupancy, wirePanel, install } = require('../../frontend/js/mobile-dock-sheet.js');
const sheetSource = readFileSync(fileURLToPath(new URL('../../frontend/js/mobile-dock-sheet.js', import.meta.url)), 'utf8');
const panelsCss = readFileSync(fileURLToPath(new URL('../../frontend/css/panels.css', import.meta.url)), 'utf8');

// Evaluates the dock's compound selector (classes plus :not(#id) / :not(.class)) against a fake
// element's id and classes, so the test follows the real selector instead of comparing its text.
function matchesCompound(el, selector) {
    const negations = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(m => m[1]);
    const positive = selector.replace(/:not\([^)]+\)/g, '');
    const one = part => (part.startsWith('#') ? el.id === part.slice(1) : el.classes.includes(part.slice(1)));
    const required = positive.match(/[.#][\w-]+/g) || [];
    return required.every(one) && !negations.some(one);
}

function dockPanel({ id = 'parcel-info-panel', classes = ['info-panel', 'right-dock-panel'] } = {}) {
    return {
        nodeType: 1,
        id,
        classes,
        handle: null,
        matches(selector) { return matchesCompound(this, selector); },
        querySelector() { return this.handle; },
        querySelectorAll() { return []; },
        insertBefore(handle) { this.handle = handle; }
    };
}

function installWithObserver() {
    const mutationCallbacks = [];
    const win = {
        document: {
            readyState: 'complete',
            getElementById(id) { return id === 'map-container' ? {} : null; },
            querySelectorAll() { return []; },
            createElement() {
                return { classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} };
            }
        },
        MutationObserver: class {
            constructor(callback) { mutationCallbacks.push(callback); }
            observe() {}
        },
        addEventListener() {}
    };
    install(win);
    return nodes => mutationCallbacks[0]([{ addedNodes: nodes }]);
}

describe('mobile dock sheet geometry', () => {
    it('makes map tools tall sheets with visible, touch-safe drag handles', () => {
        expect(panelsCss).toMatch(/\.info-panel\.right-dock-panel:not\(#proposal-details-panel\):not\(\.is-minimized\)\s*\{[\s\S]*?--mobile-dock-sheet-height:\s*66dvh/);
        expect(panelsCss).toMatch(/\.mobile-dock-sheet-handle\s*\{[\s\S]*?touch-action:\s*none/);
        expect(panelsCss).not.toMatch(/#parcel-info-panel\s*\{[\s\S]*?height:\s*33vh/);
    });

    it('opens taller than the retired 33vh panel while leaving room for map chrome', () => {
        const height = sheetHeight({ viewportHeight: 568, topClearance: 62, bottomClearance: 62 });
        expect(height).toBeGreaterThan(568 * 0.33);
        expect(height).toBeLessThanOrEqual(568 - 62 - 62 - 8);
    });

    it('keeps a usable minimum height on a 320px-wide phone and caps a drag before the top chrome', () => {
        const range = limits(568, 62, 62);
        expect(range.min).toBeGreaterThanOrEqual(240);
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
        expect(sheetHeight({ viewportHeight: 568, desiredHeight: null })).toBeGreaterThan(568 * 0.33);
    });

    it('keeps the full-screen proposal reader out of draggable sheet wiring', () => {
        let mutated = false;
        const panel = { id: 'proposal-details-panel', querySelector() { return null; }, insertBefore() { mutated = true; } };
        wirePanel({ document: { createElement() { throw new Error('No handle should be created'); } } }, panel);
        expect(mutated).toBe(false);
    });

    it('restores the handle when a panel renderer replaces its children', () => {
        const callbacks = [];
        const panel = {
            handle: null,
            querySelector() { return this.handle; },
            insertBefore(handle) { this.handle = handle; },
            style: { getPropertyValue() { return ''; } }
        };
        const doc = {
            createElement() {
                return {
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
        const added = installWithObserver();
        const panel = dockPanel();
        added([panel]);
        expect(panel.handle).toBeTruthy();
        // A mutation from inserting the handle is harmless: it is not a dock panel itself.
        added([{ nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } }]);
        expect(panel.handle).toBeTruthy();
    });

    it('makes the click stack a sheet but not a panel hosted inside it, nor the proposal reader', () => {
        const added = installWithObserver();
        const stack = dockPanel({ id: 'click-stack', classes: ['click-stack', 'info-panel', 'right-dock-panel'] });
        const hosted = dockPanel({ classes: ['info-panel', 'right-dock-panel', 'is-hosted'] });
        const reader = dockPanel({ id: 'proposal-details-panel' });
        added([stack, hosted, reader]);
        expect(stack.handle).toBeTruthy();
        expect(hosted.handle).toBeNull();
        expect(reader.handle).toBeNull();
    });

    it('reports what the open sheet occupies so the credits stay in the map', () => {
        expect(occupiedBottom({ viewportHeight: 844, top: 500 })).toBe(344);
        expect(occupiedBottom({ viewportHeight: 844, top: null })).toBe(0);
        const vars = new Map();
        const container = { style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) } };
        const panel = { box: { top: 500, height: 344 }, getBoundingClientRect() { return this.box; } };
        let phone = true;
        const win = {
            innerHeight: 844,
            matchMedia: () => ({ matches: phone }),
            document: {
                getElementById(id) { return id === 'map-container' ? container : null; },
                querySelectorAll() { return [panel]; }
            }
        };
        reportOccupancy(win);
        expect(vars.get('--map-sheet-occupied')).toBe('344px');
        panel.box = { top: 437, height: 407 };
        reportOccupancy(win);
        expect(vars.get('--map-sheet-occupied')).toBe('407px');
        panel.box = { top: 0, height: 0 }; // closed
        reportOccupancy(win);
        expect(vars.has('--map-sheet-occupied')).toBe(false);
        phone = false;
        panel.box = { top: 500, height: 344 };
        reportOccupancy(win);
        expect(vars.has('--map-sheet-occupied')).toBe(false);
    });

    it('boots as a classic browser script and translates an initial panel handle', () => {
        const panel = {
            nodeType: 1,
            handle: null,
            matches() { return true; },
            querySelector() { return this.handle; },
            querySelectorAll() { return []; },
            insertBefore(handle) { this.handle = handle; }
        };
        const mapContainer = {};
        const win = {
            document: {
                readyState: 'complete',
                getElementById(id) { return id === 'map-container' ? mapContainer : null; },
                querySelectorAll() { return [panel]; },
                createElement() {
                    return {
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
    });
});
