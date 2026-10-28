// Moving between cities (projections.md §10 M8): a switch goes to an address in the next city and
// leaves the page being left in history; a switch that clears the route clears every route the boot
// acts on; a proposal link naming a city the app does not configure opens here instead of asking about
// a place that cannot open; staying keeps the stayed-in city in the address. Real city-config.js and
// city-switch-prompt.js, with a fake location and history.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityConfigText = cityConfigSource();
const promptSource = read('../../frontend/js/city-switch-prompt.js');
const Cid = createRequire(import.meta.url)('../../frontend/js/cid.js');
// Design and agreement links name published objects by CID (plan-design-agreement.md, M2).
const DESIGN = Cid.cidOf(new TextEncoder().encode('design-a'));
const AGREEMENT = Cid.cidOf(new TextEncoder().encode('agreement-a'));
const PLAN = Cid.cidOf(new TextEncoder().encode('plan-a'));

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
    vm.runInContext(cityConfigText, context, { filename: 'city-config.js' });
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

    it.each([`/designs/${DESIGN}`, `/agreements/${AGREEMENT}`, `/plans/${PLAN}`])('clears the record link %s too, so it does not reopen in the next city', async pathname => {
        const { manager, visits } = boot(`http://localhost:8080${pathname}?city=zagreb&lang=hr`);
        await expect(manager.switchCity('split', { clearRoute: true })).resolves.toBe(true);
        const next = new URL(visits.at(-1));
        expect(next.pathname).toBe('/');
        expect(next.searchParams.get('city')).toBe('split');
        expect(next.searchParams.get('lang')).toBe('hr');
    });

    it('drops the old plan camera and selection while retaining the destination place and display preferences', async () => {
        const { context, manager, visits } = boot(`http://localhost:8080/plans/${PLAN}?city=birmingham&at=52.48,-1.88,18&camera=52.48,-1.88,1,0,500&rotate=1&planningSelection=proposed:old&3d=&existing=ghost&backend=https%3A%2F%2Fapi.example.test&lang=en`);
        context.WorldEntryModel = { formatAt: at => `${at.lat},${at.lon},${at.zoom}` };
        await manager.switchCity('split', { clearRoute: true, at: { lat: 43.5, lon: 16.44, zoom: 17 } });
        const next = new URL(visits.at(-1));
        expect(next.pathname).toBe('/');
        expect(next.searchParams.get('at')).toBe('43.5,16.44,17');
        expect(next.searchParams.get('city')).toBe('split');
        for (const param of ['camera', 'rotate', 'planningSelection']) expect(next.searchParams.has(param), param).toBe(false);
        expect(next.searchParams.has('3d')).toBe(true);
        expect(next.searchParams.get('existing')).toBe('ghost');
        expect(next.searchParams.get('backend')).toBe('https://api.example.test');
    });

    it('drops a private draft route when exploring another city', async () => {
        const { manager, visits } = boot('http://localhost:8080/designs?city=birmingham&draft=private-draft&planningSelection=proposed:old');
        await manager.switchCity('split', { clearRoute: true });
        const next = new URL(visits.at(-1));
        expect(next.pathname).toBe('/');
        expect(next.searchParams.has('draft')).toBe(false);
        expect(next.searchParams.has('planningSelection')).toBe(false);
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
        const { context, visits } = boot(`http://localhost:8080/designs/${DESIGN}?city=zagreb`);
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
        const { context, visits, history } = boot(`http://localhost:8080/agreements/${AGREEMENT}?city=explore&focusProposal=5`);
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
        vm.runInContext(cityConfigText, context, { filename: 'city-config.js' });
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
