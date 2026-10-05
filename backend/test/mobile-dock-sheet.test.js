// Phone dock regression coverage: tall-sheet geometry plus handles that must survive both a
// renderer replacing panel children and Explore creating the proposal panel after initial boot.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { limits, sheetHeight, draggedHeight, wirePanel, install } = require('../../frontend/js/mobile-dock-sheet.js');
const sheetSource = readFileSync(fileURLToPath(new URL('../../frontend/js/mobile-dock-sheet.js', import.meta.url)), 'utf8');
const panelsCss = readFileSync(fileURLToPath(new URL('../../frontend/css/panels.css', import.meta.url)), 'utf8');

describe('mobile dock sheet geometry', () => {
    it('makes every right dock a tall sheet with a visible, touch-safe drag handle', () => {
        expect(panelsCss).toMatch(/\.info-panel\.right-dock-panel\s*\{[\s\S]*?--mobile-dock-sheet-height:\s*66dvh/);
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

    it('wires a proposal sheet added after the initial page scan', () => {
        const mutationCallbacks = [];
        const panel = {
            nodeType: 1,
            handle: null,
            matches(selector) { return selector === '.info-panel.right-dock-panel'; },
            querySelector() { return this.handle; },
            querySelectorAll() { return []; },
            insertBefore(handle) { this.handle = handle; }
        };
        const mapContainer = {};
        const win = {
            document: {
                readyState: 'complete',
                getElementById(id) { return id === 'map-container' ? mapContainer : null; },
                querySelectorAll() { return []; },
                createElement() {
                    return {
                        classList: { add() {}, remove() {} },
                        setAttribute() {},
                        addEventListener() {}
                    };
                }
            },
            MutationObserver: class {
                constructor(callback) { mutationCallbacks.push(callback); }
                observe(target, options) { this.target = target; this.options = options; }
            },
            addEventListener() {}
        };
        install(win);
        mutationCallbacks[0]([{ addedNodes: [panel] }]);
        expect(panel.handle).toBeTruthy();
        // A mutation from inserting the handle is harmless: it is not a dock panel itself.
        mutationCallbacks[0]([{ addedNodes: [{ nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } }] }]);
        expect(panel.handle).toBeTruthy();
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
