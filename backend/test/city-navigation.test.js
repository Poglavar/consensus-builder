// Moving between cities (projections.md §10 M8): a switch goes to an address in the next city and
// leaves the page being left in history; a switch that clears the route clears every route the boot
// acts on; a proposal link naming a city the app does not configure opens here instead of asking about
// a place that cannot open; staying keeps the stayed-in city in the address. Real city-config.js and
// city-switch-prompt.js, with a fake location and history.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityConfigSource = read('../../frontend/js/city-config.js');
const promptSource = read('../../frontend/js/city-switch-prompt.js');

// A window whose address assignments are recorded instead of followed.
function fakeWindow(href) {
    const visits = [];
    let current = new URL(href);
    const location = {
        get href() { return current.href; },
        set href(value) { visits.push(String(value)); },
        get search() { return current.search; },
        get pathname() { return current.pathname; },
        get origin() { return current.origin; },
        assign(value) { visits.push(String(value)); },
        reload: vi.fn()
    };
    const history = {
        state: null,
        replaceState: vi.fn((state, title, url) => { current = new URL(url, current); }),
        pushState: vi.fn((state, title, url) => { current = new URL(url, current); })
    };
    const storage = new Map();
    const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    return { visits, location, history, localStorage };
}

function boot(href) {
    const fake = fakeWindow(href);
    const context = { URL, URLSearchParams, console, setTimeout, clearTimeout, location: fake.location, history: fake.history, localStorage: fake.localStorage, navigator: {} };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(cityConfigSource, context, { filename: 'city-config.js' });
    vm.runInContext(promptSource, context, { filename: 'city-switch-prompt.js' });
    return { context, manager: context.CityConfigManager, visits: fake.visits, history: fake.history };
}

describe('a city switch', () => {
    it('clears every route the boot acts on, keeping the rest of the address', async () => {
        const { manager, visits } = boot('http://localhost:8080/monitors/12?city=zagreb&focusProposal=7&arrive=pick&activity=run-1&scene=s&bets=1&lang=hr');
        expect(manager.getCurrentCityId()).toBe('zagreb');
        await expect(manager.switchCity('split', { clearRoute: true })).resolves.toBe(true);
        const next = new URL(visits.at(-1));
        expect(next.pathname).toBe('/');
        expect(next.searchParams.get('city')).toBe('split');
        expect(next.searchParams.get('lang')).toBe('hr');
        for (const param of ['focusProposal', 'arrive', 'activity', 'scene', 'bets']) expect(next.searchParams.has(param), param).toBe(false);
    });

    it('goes to the address it is given, leaving the current entry for Back', async () => {
        const { manager, visits, history } = boot('http://localhost:8080/?city=zagreb&lang=hr');
        await manager.switchCity('new_york', { url: 'http://localhost:8080/?focusProposal=9&city=zagreb&lang=hr' });
        const next = new URL(visits.at(-1));
        expect(next.searchParams.get('focusProposal')).toBe('9');
        expect(next.searchParams.get('city')).toBe('new_york');
        expect(history.replaceState).not.toHaveBeenCalled();
        expect(history.pushState).not.toHaveBeenCalled();
    });
});

describe('unfinished work on a switch', () => {
    it('keeps a road being drawn as a draft of the city it was drawn in, before leaving', async () => {
        const { context, manager, visits } = boot('http://localhost:8080/?city=zagreb');
        const order = [];
        context.roadDrawingMode = true;
        context.saveCurrentCorridorDrawingDraft = vi.fn(() => { order.push('kept'); return { draftId: 'd1' }; });
        context.proposalDraftStore = { flush: () => order.push('flushed') };
        await manager.switchCity('split', { clearRoute: true });
        expect(context.saveCurrentCorridorDrawingDraft).toHaveBeenCalledOnce();
        expect(order).toEqual(['kept', 'flushed']);
        expect(visits).toHaveLength(1);
    });
});

describe('a proposal of another city', () => {
    it('asks about no city the app does not configure, and stays', async () => {
        const { context, visits } = boot('http://localhost:8080/proposals/5?city=zagreb');
        await expect(context.promptCityMismatchForProposal('city')).resolves.toBe(false);
        await expect(context.promptCityMismatchForProposal('ZG')).resolves.toBe(false); // Zagreb's own code
        expect(visits).toEqual([]);
    });

    it('opens in its city at its own address, without rewriting this page\'s entry', async () => {
        const { context, visits, history } = boot('http://localhost:8080/?city=zagreb&lang=hr');
        await expect(context.openProposalInItsCity('41', 'new_york')).resolves.toBe(true);
        const next = new URL(visits.at(-1));
        expect(next.pathname).toBe('/');
        expect(next.searchParams.get('focusProposal')).toBe('41');
        expect(next.searchParams.get('city')).toBe('new_york');
        expect(history.replaceState).not.toHaveBeenCalled();
    });

    it('when it cannot open there, drops the route and keeps the city stayed in — explore too', async () => {
        const { context, visits, history } = boot('http://localhost:8080/proposals/5?city=explore&focusProposal=5');
        expect(context.CityConfigManager.getCurrentCityId()).toBe('explore');
        // a city the switch refuses (the current one): nothing to open there
        await expect(context.openProposalInItsCity('5', 'explore')).resolves.toBe(true);
        expect(visits).toEqual([]);
        const stayed = new URL(history.replaceState.mock.calls.at(-1)[2], 'http://localhost:8080');
        expect(stayed.pathname).toBe('/');
        expect(stayed.searchParams.get('city')).toBe('explore');
        expect(stayed.searchParams.has('focusProposal')).toBe(false);
    });
});

describe('the city\'s default language', () => {
    // Belgrade defaults to Serbian. Applied before the city's stored values were read, a language the
    // visitor chose read as unset and was replaced by the default on every boot.
    function bootWithLanguage(stored) {
        let loaded = false;
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        const setLanguage = vi.fn();
        const fake = fakeWindow('http://localhost:8080/?city=belgrade');
        const context = {
            URL, URLSearchParams, console, setTimeout, clearTimeout, location: fake.location, history: fake.history, localStorage: fake.localStorage, navigator: {},
            PersistentStorage: { ready, setScope() {}, setItem() {}, getItem: key => (key === 'cb_language' && loaded ? stored : null) },
            i18n: { setLanguage, getLanguage: () => 'en', getUrlLanguage: () => null }
        };
        context.window = context;
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(cityConfigSource, context, { filename: 'city-config.js' });
        return { setLanguage, load: async () => { loaded = true; release(); await ready; await Promise.resolve(); } };
    }

    it('waits for the stored values, and keeps a language the visitor chose', async () => {
        const boot = bootWithLanguage('en');
        expect(boot.setLanguage).not.toHaveBeenCalled();
        await boot.load();
        expect(boot.setLanguage).not.toHaveBeenCalled();
    });

    it('applies the default when none was chosen', async () => {
        const boot = bootWithLanguage(null);
        await boot.load();
        expect(boot.setLanguage).toHaveBeenCalledWith('sr');
    });
});
