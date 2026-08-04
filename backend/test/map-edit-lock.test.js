// map-edit-lock.js — an editing mode claims the map so nothing else answers clicks. The park
// editor's placement clicks were being eaten by the polygon underneath; this is the guard that
// every map-surface handler now consults.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let lock;
let originalWindow;

beforeEach(() => {
    originalWindow = globalThis.window;
    // A minimal window with a body, so the body-class side effect is exercised too.
    const classes = new Set();
    globalThis.window = {
        document: {
            body: {
                classList: {
                    toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
                    contains: name => classes.has(name)
                }
            }
        }
    };
    delete require.cache[require.resolve('../../frontend/js/map-edit-lock.js')];
    lock = require('../../frontend/js/map-edit-lock.js');
});

afterEach(() => {
    globalThis.window = originalWindow;
});

describe('claiming the map', () => {
    it('is not held until someone claims it', () => {
        expect(lock.isHeld()).toBe(false);
        expect(lock.blocksSelection()).toBe(false);
    });

    it('reports the holder and blocks selection while held', () => {
        expect(lock.claim('park-editor', 'Park editor')).toBe(true);
        expect(lock.isHeld()).toBe(true);
        expect(lock.heldBy()).toBe('park-editor');
        expect(lock.label()).toBe('Park editor');
        expect(lock.blocksSelection()).toBe(true);
    });

    it('marks the body so panels can stand down', () => {
        lock.claim('park-editor');
        expect(globalThis.window.document.body.classList.contains('map-edit-locked')).toBe(true);
        lock.release('park-editor');
        expect(globalThis.window.document.body.classList.contains('map-edit-locked')).toBe(false);
    });

    it('lets the same owner re-claim without complaint', () => {
        lock.claim('park-editor');
        expect(lock.claim('park-editor')).toBe(true);
        expect(lock.heldBy()).toBe('park-editor');
    });

    it('refuses a second owner rather than silently taking over', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        lock.claim('park-editor');
        expect(lock.claim('road-editor')).toBe(false);
        expect(lock.heldBy()).toBe('park-editor');
        warn.mockRestore();
    });

    it('ignores an empty owner', () => {
        expect(lock.claim('')).toBe(false);
        expect(lock.isHeld()).toBe(false);
    });
});

describe('releasing the map', () => {
    it('only the holder may release it', () => {
        lock.claim('park-editor');
        expect(lock.release('someone-else')).toBe(false);
        expect(lock.isHeld()).toBe(true);
        expect(lock.release('park-editor')).toBe(true);
        expect(lock.isHeld()).toBe(false);
    });

    it('releasing an unheld map is a no-op, not an error', () => {
        expect(lock.release('park-editor')).toBe(false);
    });
});

describe('blocksSelection folds in the other exclusive modes', () => {
    it.each([
        ['measureMode', true],
        ['roadDrawingMode', true],
        ['cadastreViewActive', true],
        ['proposalListBrowseMode', true]
    ])('blocks while %s is on', (flag, value) => {
        expect(lock.blocksSelection()).toBe(false);
        globalThis.window[flag] = value;
        expect(lock.blocksSelection()).toBe(true);
        delete globalThis.window[flag];
        expect(lock.blocksSelection()).toBe(false);
    });

    it('blocks while a drawing or paint tool reports itself active', () => {
        globalThis.window.isParcelDrawingModeActive = () => true;
        expect(lock.blocksSelection()).toBe(true);
        globalThis.window.isParcelDrawingModeActive = () => false;
        expect(lock.blocksSelection()).toBe(false);

        globalThis.window.AreaMonitorPaint = { isActive: () => true };
        expect(lock.blocksSelection()).toBe(true);
        globalThis.window.AreaMonitorPaint = { isActive: () => false };
        expect(lock.blocksSelection()).toBe(false);
    });

    it('survives a mode getter that throws', () => {
        globalThis.window.isParcelDrawingModeActive = () => { throw new Error('boom'); };
        expect(() => lock.blocksSelection()).not.toThrow();
        expect(lock.blocksSelection()).toBe(false);
    });
});
