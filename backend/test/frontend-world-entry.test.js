// Entering the app through the world view: the pure decisions (frontend/js/world/world-entry-model.js),
// the explore city in the REAL city-config.js, the parcel fetch guard for a city without cadastre,
// and the site intro waiting for a first-visit globe.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');
const Model = require(path.join(REPO, 'frontend/js/world/world-entry-model.js'));
const WorldCoverage = require(path.join(REPO, 'frontend/js/world/world-coverage.js'));
const coverage = WorldCoverage.create(JSON.parse(read('frontend/data/world-coverage.json')));

describe('?at= parsing', () => {
    it('reads lat,lon,zoom and lat,lon', () => {
        expect(Model.parseAt('45.80450,15.97879,17')).toEqual({ lat: 45.8045, lon: 15.97879, zoom: 17 });
        expect(Model.parseAt(' 35.68 , 139.76 ')).toEqual({ lat: 35.68, lon: 139.76, zoom: null });
        expect(Model.parseAt('-34.6,-58.4,12.6')).toEqual({ lat: -34.6, lon: -58.4, zoom: 13 });
    });

    it('clamps the zoom into the usable range', () => {
        expect(Model.parseAt('45,15,25').zoom).toBe(Model.MAX_ZOOM);
        expect(Model.parseAt('45,15,0').zoom).toBe(Model.MIN_ZOOM);
        expect(Model.parseAt('45,15,-4').zoom).toBe(Model.MIN_ZOOM);
    });

    it('ignores anything unparseable or off the map', () => {
        for (const bad of [null, undefined, 42, '', '45', '45,', ',15', 'a,b,c', '45,15,x', '45,15,17,3', '91,15,10', '86,15,10', '45,181,10', 'NaN,1,1', 'Infinity,1,1']) {
            expect(Model.parseAt(bad), String(bad)).toBeNull();
        }
    });

    it('formats what it parses', () => {
        const at = Model.formatAt({ lat: 45.8045031, lon: 15.978786, zoom: 17 });
        expect(at).toBe('45.80450,15.97879,17');
        expect(Model.parseAt(at)).toEqual({ lat: 45.8045, lon: 15.97879, zoom: 17 });
        expect(Model.formatAt({ lat: 1, lon: 2 })).toBe('1.00000,2.00000');
        expect(() => Model.formatAt({ lat: null, lon: 2 })).toThrow();
    });
});

describe('shared routes and first visit', () => {
    const shared = [
        { pathname: '/proposals/12' }, { pathname: '/proposals/1,2,3' }, { pathname: '/proposals/my-plan' },
        { pathname: '/plans/my-plan/score' }, { pathname: '/parcel/HR-335240-1323/2' }, { pathname: '/monitors/4' },
        { pathname: '/', search: '?parcel=HR-1' }, { pathname: '/', search: '?proposalShare=abc' },
        { pathname: '/', search: '?shared=abc' }, { pathname: '/', search: '?activity=agent:7' },
        { pathname: '/', search: '?scene=slug' }, { pathname: '/', search: '?photo' }, { pathname: '/', search: '?model=1' }
    ];
    const plain = [
        { pathname: '/', search: '' }, { pathname: '/', search: '?city=zg' }, { pathname: '/', search: '?lang=hr&reduceMotion=1' },
        { pathname: '/', search: '?world=1' }, { pathname: '/', search: '?at=45,15,12' }, { pathname: '/index.html' }
    ];

    it('recognises every link form that names what to show', () => {
        for (const loc of shared) expect(Model.isSharedRoute(loc), JSON.stringify(loc)).toBe(true);
        for (const loc of plain) expect(Model.isSharedRoute(loc), JSON.stringify(loc)).toBe(false);
    });

    it('covers every path the app itself treats as a proposal deep link', () => {
        // isProposalDeepLinkPath (js/user-management.js), lifted out of the classic script.
        const src = read('frontend/js/user-management.js');
        const start = src.indexOf('function isProposalDeepLinkPath()');
        const end = src.indexOf('\n}\n', start);
        expect(start).toBeGreaterThan(-1);
        const appCheck = pathname => new Function('window', `${src.slice(start, end + 2)}; return isProposalDeepLinkPath();`)({ location: { pathname } });
        for (const pathname of ['/proposals/12', '/proposals/1,2', '/proposals/zagreb-plan', '/plans/zagreb-plan/score', '/', '/about']) {
            if (appCheck(pathname)) expect(Model.isSharedRoute({ pathname }), pathname).toBe(true);
        }
    });

    it('opens the globe on a first visit only, or when ?world=1 forces it', () => {
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: false, search: '' }))
            .toEqual({ open: true, closable: false, firstVisit: true, forced: false });
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '' }).open).toBe(false);
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: true, search: '' }).open).toBe(false);
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '?world=1' }))
            .toEqual({ open: true, closable: true, firstVisit: false, forced: true });
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: false, search: '?world=1' }).closable).toBe(false);
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '?world=0' }).open).toBe(false);
    });
});

describe('where a globe pick lands', () => {
    const zagrebView = { center: [45.804503, 15.978786], zoom: 19 };

    it('a click on the city already loaded moves the map in place, to the city view', () => {
        const point = { lat: 45.83, lon: 16.05, place: coverage.tierAt(45.83, 16.05) };
        expect(point.place.kind).toBe('live-city');
        expect(Model.resolveLanding({ cityId: 'zagreb', point, currentCityId: 'zagreb', cityView: zagrebView }))
            .toEqual({ cityId: 'zagreb', inPlace: true, view: { lat: 45.804503, lon: 15.978786, zoom: 19 }, carryAt: false });
    });

    it('another city reloads into it at its own default view', () => {
        const point = { lat: 43.51, lon: 16.44, place: coverage.tierAt(43.51, 16.44) };
        const landing = Model.resolveLanding({ cityId: point.place.cityId, point, currentCityId: 'zagreb', cityView: { center: [43.5081, 16.4402], zoom: 19 } });
        expect(landing).toMatchObject({ cityId: 'split', inPlace: false, carryAt: false, view: { lat: 43.5081, lon: 16.4402, zoom: 19 } });
    });

    it('inland Croatia opens the nearest Croatian city AT the clicked point, at parcel zoom', () => {
        const osijek = { lat: 45.55, lon: 18.69, place: coverage.tierAt(45.55, 18.69) };
        expect(osijek.place).toMatchObject({ kind: 'country', tier: 'live', cc: 'HR' });
        const landing = Model.resolveLanding({ cityId: osijek.place.cityId, point: osijek, currentCityId: 'new_york', cityView: zagrebView });
        expect(landing).toEqual({ cityId: osijek.place.cityId, inPlace: false, view: { lat: 45.55, lon: 18.69, zoom: Model.PARCEL_ZOOM }, carryAt: true });
    });

    it('a Croatian spot opens in the loaded Croatian city (one countrywide cadastre), a city click switches', () => {
        const osijek = coverage.tierAt(45.55, 18.69);
        expect(Model.liveCityFor({ place: osijek, currentCityId: 'split', sameCadastre: true })).toBe('split');
        expect(Model.liveCityFor({ place: osijek, currentCityId: 'new_york', sameCadastre: false })).toBe(osijek.cityId);
        expect(Model.liveCityFor({ place: coverage.tierAt(45.83, 16.05), currentCityId: 'split', sameCadastre: true })).toBe('zagreb');
        expect(Model.liveCityFor({ place: coverage.tierAt(35.69, 139.69), currentCityId: 'split', sameCadastre: false })).toBeNull();
        // ... and then lands in place, at the spot.
        const point = { lat: 45.55, lon: 18.69, place: osijek };
        expect(Model.resolveLanding({ cityId: 'split', point, currentCityId: 'split', cityView: zagrebView }))
            .toEqual({ cityId: 'split', inPlace: true, view: { lat: 45.55, lon: 18.69, zoom: Model.PARCEL_ZOOM }, carryAt: true });
    });

    it('a precise search result opens exactly there, never below parcel zoom', () => {
        const point = { lat: 45.81, lon: 15.97, place: coverage.tierAt(45.81, 15.97) };
        const landing = Model.resolveLanding({ cityId: 'zagreb', point, currentCityId: 'split', cityView: zagrebView, focus: { lat: 45.81, lon: 15.97, zoom: 18 } });
        expect(landing).toMatchObject({ carryAt: true, view: { lat: 45.81, lon: 15.97, zoom: 18 } });
        const coarse = Model.resolveLanding({ cityId: 'zagreb', point, currentCityId: 'split', cityView: zagrebView, focus: { lat: 45.81, lon: 15.97, zoom: 13 } });
        expect(coarse.view.zoom).toBe(Model.PARCEL_ZOOM);
        // A focus somewhere else does not make a different click precise.
        const other = Model.resolveLanding({ cityId: 'zagreb', point, currentCityId: 'split', cityView: zagrebView, focus: { lat: 1, lon: 1, zoom: 18 } });
        expect(other.carryAt).toBe(false);
    });

    it('explore goes to the explore city at the point, zoom by what was picked', () => {
        const tokyo = { lat: 35.69, lon: 139.69, place: coverage.tierAt(35.69, 139.69) };
        expect(Model.resolveLanding({ point: tokyo, currentCityId: 'zagreb', explore: true }))
            .toEqual({ cityId: 'explore', inPlace: false, view: { lat: 35.69, lon: 139.69, zoom: Model.EXPLORE_ZOOM.city }, carryAt: true });
        const sea = { lat: 30, lon: -40, place: coverage.tierAt(30, -40) };
        expect(Model.resolveLanding({ point: sea, currentCityId: 'explore', explore: true }))
            .toMatchObject({ cityId: 'explore', inPlace: true, view: { zoom: Model.EXPLORE_ZOOM.area } });
        const precise = Model.resolveLanding({ point: tokyo, currentCityId: 'zagreb', explore: true, focus: { lat: 35.69, lon: 139.69, zoom: 18 } });
        expect(precise.view.zoom).toBe(18);
    });

    it('refuses a pick without a usable point or city', () => {
        expect(() => Model.resolveLanding({ cityId: 'zagreb', point: { lat: null, lon: 1 } })).toThrow();
        expect(() => Model.resolveLanding({ point: { lat: 1, lon: 1, place: {} }, currentCityId: 'zagreb' })).toThrow();
    });

    it('gives a metric UTM projection anywhere', () => {
        expect(Model.utmProjectionFor(35.68, 139.76).crs).toBe('EPSG:32654');
        expect(Model.utmProjectionFor(-34.6, -58.4)).toEqual({
            crs: 'EPSG:32721', definition: '+proj=utm +zone=21 +south +datum=WGS84 +units=m +no_defs +type=crs'
        });
        expect(Model.utmProjectionFor(10, 180).crs).toBe('EPSG:32660');
    });
});

// city-config.js is a classic script; evaluate it in THIS realm behind window/location/storage stubs.
function loadCityConfig(search, stored = {}) {
    const writes = [];
    const scopes = [];
    const store = { ...stored };
    const win = {
        location: { search, href: `http://localhost:5811/${search}`, pathname: '/' },
        WorldEntryModel: Model,
        localStorage: {
            getItem: key => (key in store ? store[key] : null),
            setItem: (key, value) => { writes.push([key, value]); store[key] = String(value); }
        },
        PersistentStorage: {
            setScope: (scope, options) => { scopes.push([scope, options]); },
            getItem: () => null,
            setItem: () => {}
        },
        dispatchEvent: () => true
    };
    const fn = new Function('window', 'localStorage', 'PersistentStorage', 'URL', 'URLSearchParams', read('frontend/js/city-config.js'));
    fn(win, win.localStorage, win.PersistentStorage, URL, URLSearchParams);
    return { manager: win.CityConfigManager, win, writes, scopes, store };
}

// Key paths ('map.defaultZoom', 'parcels.source', …) of a config, down to non-object values.
function keyPaths(node, prefix = '', out = new Set()) {
    for (const [key, value] of Object.entries(node)) {
        const pathKey = prefix ? `${prefix}.${key}` : key;
        out.add(pathKey);
        if (value && typeof value === 'object' && !Array.isArray(value)) keyPaths(value, pathKey, out);
    }
    return out;
}

describe('the explore city (city-config.js)', () => {
    let tokyo;
    beforeAll(() => { tokyo = loadCityConfig('?city=explore&at=35.68,139.76,12'); });

    it('boots at the ?at= point with a metric projection for it', () => {
        const { manager } = tokyo;
        expect(manager.getCurrentCityId()).toBe('explore');
        expect(manager.isExplore()).toBe(true);
        const config = manager.getCurrentCityConfig();
        expect(config.map.defaultCenter).toEqual([35.68, 139.76]);
        expect(config.map.defaultZoom).toBe(12);
        expect(config.projection.metricCrs).toBe('EPSG:32654');
        expect(manager.hasParcelData()).toBe(false);
    });

    it('has every config key that all real cities have (derived from them, not listed here)', () => {
        const { manager } = tokyo;
        const cities = manager.getAvailableCities();
        expect(cities.length).toBeGreaterThanOrEqual(8);
        const sets = cities.map(config => keyPaths(config));
        const required = [...sets[0]].filter(key => sets.every(set => set.has(key)));
        expect(required).toEqual(expect.arrayContaining(['map.defaultCenter', 'projection.datasetCrs', 'parcels.source', 'sidebar.disabledSections', 'currency.code']));
        const explore = keyPaths(manager.getCityConfig('explore'));
        expect(required.filter(key => !explore.has(key))).toEqual([]);
    });

    it('disables every parcel-dependent section', () => {
        const disabled = tokyo.manager.getCityConfig('explore').sidebar.disabledSections;
        for (const section of ['parcels', 'parcelBlocks', 'buildings', 'roads', 'areaMonitor', 'stations', 'proposals']) {
            expect(disabled).toContain(section);
        }
        expect(tokyo.manager.isFeatureEnabled('roadTools')).toBe(false);
    });

    it('is not a city: not listed, not nearest, not stored, its own storage scope', () => {
        const { manager, writes, scopes, store } = tokyo;
        expect(manager.getAvailableCities().map(c => c.id)).not.toContain('explore');
        expect(manager.findNearestCity(35.68, 139.76).id).not.toBe('explore');
        expect(writes.filter(([key]) => key === 'cb_current_city')).toEqual([]);
        expect(scopes).toEqual([['explore', { explicit: true }]]);
        expect(store.cb_explore_at).toBe('35.68000,139.76000,12');
        expect(manager.getCityLabel('explore')).toBe('Explore');
    });

    it('reopens the last explored point when ?at= is gone, and a world overview without one', () => {
        const reload = loadCityConfig('?city=explore', { cb_explore_at: '35.68000,139.76000,14' });
        expect(reload.manager.getCurrentCityConfig().map.defaultCenter).toEqual([35.68, 139.76]);
        expect(reload.manager.getCurrentCityConfig().map.defaultZoom).toBe(14);
        const fresh = loadCityConfig('?city=explore&at=999,1,1');
        expect(fresh.manager.getCurrentCityConfig().map.defaultZoom).toBe(3);
    });

    it('a stored explore pointer never becomes the current city', () => {
        const { manager, scopes } = loadCityConfig('', { cb_current_city: 'explore' });
        expect(manager.getCurrentCityId()).toBe('new_york');
        expect(manager.wasCityChosenAtBoot()).toBe(false);
        expect(scopes[0][0]).toBe('new_york');
    });

    it('a chosen city counts as chosen; the default does not', () => {
        expect(loadCityConfig('?city=zg').manager.wasCityChosenAtBoot()).toBe(true);
        expect(loadCityConfig('', { cb_current_city: 'split' }).manager.wasCityChosenAtBoot()).toBe(true);
        expect(loadCityConfig('').manager.wasCityChosenAtBoot()).toBe(false);
    });

    it('navigateToCity carries ?at= and drops ?world= and the old ?at=', () => {
        const { manager, win } = loadCityConfig('?city=zg&world=1&at=1,1,5&lang=hr');
        manager.navigateToCity('split', { clearRoute: true, at: { lat: 43.5, lon: 16.44, zoom: 17 } });
        const url = new URL(win.location.href);
        expect(url.searchParams.get('city')).toBe('split');
        expect(url.searchParams.get('at')).toBe('43.50000,16.44000,17');
        expect(url.searchParams.has('world')).toBe(false);
        expect(url.searchParams.get('lang')).toBe('hr');
        manager.navigateToCity('zagreb', {});
        expect(new URL(win.location.href).searchParams.has('at')).toBe(false);
    });
});

describe('parcel fetching in a city without cadastre', () => {
    const saved = {};
    afterEach(() => {
        for (const key of ['CityConfigManager', 'CadastralParcelRepository', 'map']) {
            if (key in saved) globalThis[key] = saved[key]; else delete globalThis[key];
        }
    });

    it('fetches nothing for the explore city and still fetches for a real one', async () => {
        for (const key of ['CityConfigManager', 'CadastralParcelRepository', 'map']) if (key in globalThis) saved[key] = globalThis[key];
        require(path.join(REPO, 'frontend/js/parcels/fetch.js'));
        const ensureBounds = vi.fn(async () => ({ cached: true, features: [] }));
        globalThis.CadastralParcelRepository = { ensureBounds };
        const bounds = { pad: () => bounds };
        globalThis.map = { getBounds: () => bounds };

        globalThis.CityConfigManager = { hasParcelData: () => false, getCurrentCityId: () => 'explore' };
        expect(await globalThis.fetchParcelData()).toBeNull();
        expect(await globalThis.__cadastralGroundTransport.fetchBounds(null, { keys: ['1,1'] })).toMatchObject({ features: [] });
        expect(await globalThis.__cadastralGroundTransport.fetchByIds(['HR-1'])).toMatchObject({ features: [], absentIds: ['HR-1'] });
        expect(ensureBounds).not.toHaveBeenCalled();

        globalThis.CityConfigManager = { hasParcelData: () => true, getCurrentCityId: () => 'zagreb' };
        await globalThis.fetchParcelData();
        expect(ensureBounds).toHaveBeenCalledTimes(1);
    });
});

describe('the site intro and a first-visit globe', () => {
    const keys = ['document', 'WorldEntry', 'localStorage', 'addEventListener', 'dispatchEvent', 'location', 'i18n', '__siteIntroInitialized', 'openSiteIntro', 'closeSiteIntro'];
    const saved = {};
    afterEach(() => {
        for (const key of keys) {
            if (key in saved) globalThis[key] = saved[key]; else delete globalThis[key];
        }
    });

    function fakePage(ownsBoot) {
        for (const key of keys) if (key in globalThis) saved[key] = globalThis[key];
        const events = new EventTarget();
        const modal = {
            hidden: true,
            classList: { add() {}, remove() {} },
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        };
        globalThis.document = {
            getElementById: id => (id === 'site-intro-modal' ? modal : null),
            querySelectorAll: () => [],
            addEventListener() {},
            body: { classList: { add() {}, remove() {} } },
            activeElement: null
        };
        globalThis.WorldEntry = { ownsBoot: () => ownsBoot };
        globalThis.localStorage = { getItem: () => null, setItem() {} };
        globalThis.addEventListener = events.addEventListener.bind(events);
        globalThis.dispatchEvent = events.dispatchEvent.bind(events);
        globalThis.location = { search: '' };
        delete globalThis.__siteIntroInitialized;
        return modal;
    }

    it('waits for the visitor to land before showing', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(true);
        initSiteIntro();
        expect(modal.hidden).toBe(true);
        globalThis.dispatchEvent(new Event('worldview:landed'));
        expect(modal.hidden).toBe(false);
    });

    it('shows at once when no globe owns the boot', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(false);
        initSiteIntro();
        expect(modal.hidden).toBe(false);
    });
});

describe('wiring', () => {
    const html = read('frontend/index.html');

    it('loads the model before city-config, the entry after it, handoff first in <body>, globe after coverage', () => {
        const order = name => html.indexOf(`'${name}`);
        expect(order('js/world/world-entry-model.js')).toBeGreaterThan(-1);
        expect(order('js/world/world-entry-model.js')).toBeLessThan(order('js/city-config.js'));
        expect(order('js/ui/world-entry.js')).toBeGreaterThan(order('js/city-config.js'));
        expect(order('js/world/globe.js')).toBeGreaterThan(order('js/world/globe-math.js'));
        expect(order('js/world/globe-math.js')).toBeGreaterThan(order('js/world/world-coverage.js'));
        expect(html).toMatch(/<body[^>]*>\s*<!--[\s\S]*?-->\s*<script>\s*window\.writeVersionedLocalScripts\(\['js\/world\/handoff\.js'\]\)/);
        expect(html).toContain("'css/world.css'");
        expect(html).toContain('id="world-view-button"');
    });

    it('drops the commands of a section the city config hid, with the reason', () => {
        const UiCommands = require(path.join(REPO, 'frontend/js/ui/commands.js'));
        const ctx = hidden => ({ global: {}, isControlAvailable: () => true, isSectionHidden: section => hidden.includes(section) });
        const ids = hidden => UiCommands.commandsFor('palette', ctx(hidden)).map(c => c.id);
        expect(ids([])).toEqual(expect.arrayContaining(['blocks.reform', 'stations.bus', 'proposals.list', 'game.new']));
        const explore = ids(['parcels', 'blocks', 'stations', 'roads', 'proposals', 'game', 'areaMonitor']);
        for (const id of ['blocks.reform', 'stations.bus', 'roads.drawOsm', 'proposals.list', 'game.new', 'parcels.clearLocal']) expect(explore).not.toContain(id);
        expect(explore).toEqual(expect.arrayContaining(['tools.measure', 'world.open', 'settings.baseMap', 'activity.explorer']));
        const ranked = UiCommands.rankCommands('reform', ctx(['blocks']), null).find(item => item.entry.id === 'blocks.reform');
        expect(ranked).toMatchObject({ available: false, reason: 'hiddenForCity' });
    });

    it('registers the world view command on the settings surface and the palette', () => {
        const UiCommands = require(path.join(REPO, 'frontend/js/ui/commands.js'));
        const entry = UiCommands.findCommand('world.open');
        expect(entry).toBeTruthy();
        expect(entry.surfaces).toEqual(expect.arrayContaining(['settings', 'palette']));
        expect(entry.control).toBe('world-view-button');
    });
});
