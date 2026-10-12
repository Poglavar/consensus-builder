// The theme switch (frontend/js/ui/theme.js): the stored choice, "system" following the OS, and the
// data-theme attribute the tokens key on. Runs against a small stand-in document.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fakeRoot({ stored = null, dark = false } = {}) {
    const attrs = {};
    const buttons = ['system', 'light', 'dark'].map(choice => {
        const a = { 'data-theme-choice': choice, 'aria-pressed': 'false' };
        return { getAttribute: k => a[k], setAttribute: (k, v) => { a[k] = v; }, attrs: a };
    });
    const store = { 'cb.theme': stored };
    const listeners = {};
    const root = {
        localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
        matchMedia: () => ({ matches: dark, addEventListener: () => {} }),
        document: {
            readyState: 'complete',
            documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } },
            querySelectorAll: () => buttons,
            addEventListener: (name, fn) => { listeners[name] = fn; },
            dispatchEvent: () => true
        },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    };
    return { root, attrs, buttons, store };
}

function load(root) {
    // The module attaches to `window` when present; give it ours.
    const previous = globalThis.window;
    globalThis.window = root;
    delete require.cache[require.resolve('../../frontend/js/ui/theme.js')];
    const api = require('../../frontend/js/ui/theme.js');
    globalThis.window = previous;
    return api;
}

describe('theme switch', () => {
    let previousWindow;
    beforeEach(() => { previousWindow = globalThis.window; });
    afterEach(() => { globalThis.window = previousWindow; });

    it('starts on "system" and follows a dark OS by setting data-theme', () => {
        const f = fakeRoot({ dark: true });
        const api = load(f.root);
        expect(api.get()).toBe('system');
        expect(f.attrs['data-theme']).toBe('dark');
        expect(f.buttons.map(b => b.attrs['aria-pressed'])).toEqual(['true', 'false', 'false']);
    });

    it('restores a stored choice and marks its button', () => {
        const f = fakeRoot({ stored: 'dark', dark: false });
        const api = load(f.root);
        expect(api.get()).toBe('dark');
        expect(f.attrs['data-theme']).toBe('dark');
        expect(f.buttons[2].attrs['aria-pressed']).toBe('true');
    });

    it('set("light") removes the attribute even on a dark OS and stores the choice', () => {
        const f = fakeRoot({ dark: true });
        const api = load(f.root);
        expect(api.set('light')).toBe('light');
        expect(f.attrs['data-theme']).toBeUndefined();
        expect(f.store['cb.theme']).toBe('light');
        expect(api.resolve('system')).toBe('dark');
        expect(api.resolve('light')).toBe('light');
    });

    it('treats an unknown stored value as "system"', () => {
        const f = fakeRoot({ stored: 'sepia' });
        expect(load(f.root).get()).toBe('system');
    });
});
