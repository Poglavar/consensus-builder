// Headless checks for two frontend audit fixes: an explicit ?lang= survives the profile modal, and
// the phone proposal list folds its filters (and never autofocuses search on touch). The third, a
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
    const { countActiveProposalListFilters, shouldAutofocusProposalListSearch } = require('../../frontend/js/proposals/dialog-share.js');

    it('counts only filters that narrow the list (not sort)', () => {
        const base = { filterType: 'all', publicationFilter: 'all', appliedFilter: 'all', authorFilter: '', searchText: '', sortKey: 'title-asc' };
        expect(countActiveProposalListFilters(base)).toBe(0);
        expect(countActiveProposalListFilters({ ...base, filterType: 'road', appliedFilter: 'applied', searchText: ' park ' })).toBe(3);
        expect(countActiveProposalListFilters({ ...base, authorFilter: '   ' })).toBe(0);
    });

    it('autofocuses search only on wide, non-touch screens', () => {
        const withMedia = (matches) => ({ matchMedia: vi.fn(() => ({ matches })) });
        expect(shouldAutofocusProposalListSearch(withMedia(false))).toBe(true);
        expect(shouldAutofocusProposalListSearch(withMedia(true))).toBe(false);
        expect(shouldAutofocusProposalListSearch({})).toBe(false);
    });

    it('the list collapses filters by default and wires the helpers', () => {
        const src = read('../../frontend/js/proposals/dialog-share.js');
        expect(src).toContain("proposal-list-controls${filtersOpen ? '' : ' is-collapsed'}");
        // the list is opened from list-ui.js since the Proposals sheet mounts it itself
        expect(read('../../frontend/js/proposals/list-ui.js')).toContain('proposalListState.autofocusSearch = shouldAutofocusProposalListSearch(window)');
        const css = read('../../frontend/css/proposals.css');
        expect(css).toMatch(/@media \(max-width: 767\.98px\)\s*{\s*\.proposal-filters-toggle-row\s*{\s*display: flex/);
        expect(css).toMatch(/\.proposal-list-controls\.is-collapsed\s*{\s*display: none;/);
    });

    it('short desktop windows fold the filters too, so the capped sheet keeps room for the list', () => {
        const css = read('../../frontend/css/proposals.css');
        const block = css.match(/@media \(min-width: 768px\) and \(max-height: 900px\)\s*{([\s\S]*?)\n}/);
        expect(block).not.toBeNull();
        expect(block[1]).toMatch(/\.proposal-filters-toggle-row\s*{\s*display: flex/);
        expect(block[1]).toMatch(/\.proposal-list-controls\.is-collapsed\s*{\s*display: none;/);
    });
});
