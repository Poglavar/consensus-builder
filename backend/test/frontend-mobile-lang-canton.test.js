// Headless checks for two frontend audit fixes: an explicit ?lang= survives the profile modal, and
// the lists panel folds its filters and never autofocuses search. The third, a
// disabled Canton making no requests, went with the Canton mode itself (plan-design-agreement.md, M3).
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Run a classic browser script against a fake `window` (the script's own `window`/`self` lookups
// resolve to it). Returns the fake window.
function runClassicScript(rel, win) {
    const src = read(rel);
    // eslint-disable-next-line no-new-func
    new Function('window', 'self', 'globalThis', 'document', src)(win, win, win, win.document);
    return win;
}

function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
        ready: Promise.resolve(),
        getItem: (k) => (k in data ? data[k] : null),
        setItem: vi.fn((k, v) => { data[k] = v; }),
        data
    };
}

async function loadI18n({ search = '', stored = {} } = {}) {
    const win = {
        location: { search },
        navigator: { languages: ['en-US'], language: 'en-US' },
        PersistentStorage: fakeStorage(stored)
    };
    runClassicScript('../../frontend/js/i18n.js', win);
    await win.i18n.ready;
    return win;
}

describe('?lang= wins for the session', () => {
    it('a saved preference does not undo an explicit ?lang=', async () => {
        const win = await loadI18n({ search: '?lang=hr', stored: { cb_language: 'en' } });
        expect(win.i18n.getLanguage()).toBe('hr');
    });

    it('profile-modal resolution keeps ?lang= over saved and city default (NYC → en)', async () => {
        const win = await loadI18n({ search: '?lang=hr', stored: { cb_language: 'en' } });
        expect(win.i18n.resolveSessionLanguage('en')).toBe('hr');
    });

    it('a user pick then wins over ?lang=', async () => {
        const win = await loadI18n({ search: '?lang=hr' });
        win.i18n.setLanguage('es', { userChoice: true });
        expect(win.i18n.resolveSessionLanguage('en')).toBe('es');
    });

    it('without ?lang=: saved preference, then city default', async () => {
        expect((await loadI18n({ stored: { cb_language: 'sr' } })).i18n.resolveSessionLanguage('en')).toBe('sr');
        expect((await loadI18n()).i18n.resolveSessionLanguage('hr')).toBe('hr');
    });

    it('the profile modal routes through resolveSessionLanguage and marks picks as user choices', () => {
        const um = read('../../frontend/js/user-management.js');
        const picker = um.slice(um.indexOf('function setupWelcomeModalLanguagePicker'), um.indexOf('function setupWelcomeModalEventListeners'));
        expect(picker).toContain('i18nApi.resolveSessionLanguage(cityDefault)');
        expect(picker).toContain("setLanguage(selectedLang, { userChoice: true })");
        const cityConfig = read('../../frontend/js/city-config.js');
        expect(cityConfig).toMatch(/getUrlLanguage\(\)\)\s*{\s*return;/);
    });
});

describe('phone proposal list', () => {
    // The lists panel (js/lists-panel.js) replaced the proposal list's own filter row on 2026-10-27.
    it('opens the lists panel with its filters folded and without focusing search', () => {
        const src = read('../../frontend/js/lists-panel.js');
        expect(src).toMatch(/filtersOpen: false/);
        expect(src).toContain("filters.hidden = !state.filtersOpen;");
        expect(src).not.toMatch(/search\.focus\(/);
    });
});
