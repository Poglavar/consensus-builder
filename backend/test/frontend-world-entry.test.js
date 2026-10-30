// Entering the app through the world view: the pure decisions (frontend/js/world/world-entry-model.js),
// the explore city in the REAL data/city-configs.js, the parcel fetch guard for a city without cadastre,
// and the optional site intro waiting for a first-visit globe only when requested.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');
const Model = require(path.join(REPO, 'frontend/js/world/world-entry-model.js'));
const Cid = require(path.join(REPO, 'frontend/js/cid.js'));
// Design and agreement links name published objects by CID (plan-design-agreement.md, M2).
const cidOf = text => Cid.cidOf(new TextEncoder().encode(text));
const DESIGN_A = cidOf('design-a');
const DESIGN_B = cidOf('design-b');
const AGREEMENT = cidOf('agreement-a');
const WorldCoverage = require(path.join(REPO, 'frontend/js/world/world-coverage.js'));
const coverage = WorldCoverage.create(JSON.parse(read('frontend/data/world-coverage.json')));

describe('?at= parsing', () => {
    it('reads lat,lon,zoom and lat,lon', () => {
        expect(Model.parseAt('45.80450,15.97879,17')).toEqual({ lat: 45.8045, lon: 15.97879, zoom: 17 });
        expect(Model.parseAt(' 35.68 , 139.76 ')).toEqual({ lat: 35.68, lon: 139.76, zoom: null });
        // The map zooms in tenths of a level, so the address keeps one decimal.
        expect(Model.parseAt('-34.6,-58.4,12.63')).toEqual({ lat: -34.6, lon: -58.4, zoom: 12.6 });
    });

    it('clamps the zoom into the usable range', () => {
        expect(Model.parseAt('45,15,25').zoom).toBe(Model.MAX_ZOOM);
        expect(Model.parseAt('45,15,23').zoom).toBe(23);
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
        { pathname: '/proposals' }, { pathname: '/proposals/' }, { pathname: '/proposals/solana/devnet/abc/7' },
        { pathname: `/designs/${DESIGN_A}` }, { pathname: `/designs/${DESIGN_A},${DESIGN_B}` }, { pathname: `/agreements/${AGREEMENT}` },
        { pathname: `/plans/${DESIGN_A}` },
        { pathname: '/parcel/HR-335240-1323/2' }, { pathname: '/monitors/4' },
        { pathname: '/', search: '?parcel=HR-1' }, { pathname: '/', search: `?design=${DESIGN_A}` }, { pathname: '/', search: '?activity=agent:7' },
        { pathname: '/', search: '?scene=slug' }, { pathname: '/', search: '?photo' }, { pathname: '/', search: '?model=1' },
        { pathname: '/', search: '?at=-1.264,36.840,17' }, { pathname: '/', search: '?at=51.5,-0.1' },
        { pathname: '/bets/Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR', search: '?city=zg' },
        { pathname: '/', search: '?city=zg&bets=Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR' }
    ];
    const plain = [
        { pathname: '/', search: '' }, { pathname: '/', search: '?city=zg' }, { pathname: '/', search: '?lang=hr&reduceMotion=1' },
        { pathname: '/', search: '?world=1' }, { pathname: '/', search: '?at=bad' }, { pathname: '/', search: '?at=91,15,12' }, { pathname: '/index.html' },
        // The id, comma-list, named-plan and payload (?shared=, ?proposalShare=) links went with M2:
        // they name nothing to show any more.
        { pathname: '/proposals/12' }, { pathname: '/proposals/1,2,3' }, { pathname: '/plans/my-plan/score' }, { pathname: '/designs' },
        { pathname: '/', search: '?shared=encoded' }, { pathname: '/', search: '?proposalShare=abc' }
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
        // The app's own check recognises design, agreement and named-plan links, and nothing else here.
        expect(appCheck(`/designs/${DESIGN_A},${DESIGN_B}`)).toBe(true);
        expect(appCheck(`/agreements/${AGREEMENT}`)).toBe(true);
        expect(appCheck(`/plans/${DESIGN_A}`)).toBe(true);
        expect(appCheck('/proposals/12')).toBe(false);
        for (const pathname of [`/designs/${DESIGN_A}`, `/designs/${DESIGN_A},${DESIGN_B}/`, `/agreements/${AGREEMENT}`, '/proposals/12', '/', '/about']) {
            if (appCheck(pathname)) expect(Model.isSharedRoute({ pathname }), pathname).toBe(true);
        }
    });

    it('opens the globe on a first visit only, or when ?world=1 forces it', () => {
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: false, search: '' }))
            .toEqual({ open: true, closable: false, firstVisit: true, forced: false });
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '' }).open).toBe(false);
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: true, search: '' }).open).toBe(false);
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '?world=1' }))
            .toEqual({ open: true, closable: false, firstVisit: false, forced: true });
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: false, search: '?world=1' }).closable).toBe(false);
        expect(Model.bootDecision({ cityChosen: true, sharedRoute: false, search: '?world=0' }).open).toBe(false);
    });

    it('opens a shared map position directly without needing a remembered city', () => {
        const location = { pathname: '/', search: '?at=-1.264,36.840,17' };
        expect(Model.bootDecision({ cityChosen: false, sharedRoute: Model.isSharedRoute(location), search: location.search }).open).toBe(false);
    });
});

describe('globe boot uses the arrival URL', () => {
    function boot(search = '', pathname = '/') {
        const callbacks = [];
        const classes = new Set();
        const window = {
            location: new URL(`${pathname}${search}`, 'http://localhost:8107'),
            document: {
                readyState: 'loading', getElementById: () => null,
                body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
                addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') callbacks.push(callback); }
            },
            WorldEntryModel: Model,
            CityConfigManager: { wasCityChosenAtBoot: () => false, isExplore: () => false, getCurrentCityId: () => 'new_york' },
            WorldView: { isOpen: () => false, open: vi.fn(async () => {}) },
            history: { replaceState: vi.fn() },
            whenAppBooted: () => new Promise(() => {}),
            addEventListener: vi.fn(), dispatchEvent: vi.fn()
        };
        vm.runInNewContext(read('frontend/js/ui/world-entry.js'), {
            window, URL, URLSearchParams, CustomEvent, console: { log() {}, warn() {}, error() {} }
        });
        return { window, classes, ready: () => callbacks.forEach(callback => callback()) };
    }

    it('reports a failed first-visit globe visibly and releases the boot cover', async () => {
        const app = boot();
        app.window.showEphemeralMessage = vi.fn();
        app.window.WorldView.open.mockRejectedValueOnce(new Error('WebGL unavailable'));
        app.ready();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(app.classes.has('world-view-pending')).toBe(false);
        expect(app.window.WorldEntry.ownsBoot()).toBe(false);
        expect(app.window.showEphemeralMessage).toHaveBeenCalledWith(
            expect.stringContaining('World view could not start'), 8000, 'warning');
    });

    it('opens a copied map position without a first-visit globe', () => {
        const app = boot('?at=-1.264,36.840,17');
        expect(app.window.WorldEntry.ownsBoot()).toBe(false);
        app.ready();
        expect(app.window.WorldView.open).not.toHaveBeenCalled();
        expect(app.classes.has('world-view-pending')).toBe(false);
    });

    it('still offers the city picker on a plain first visit after map boot writes its default view', () => {
        const app = boot();
        app.window.location.search = '?at=40.7128,-74.006,12';
        app.ready();
        expect(app.window.WorldView.open).toHaveBeenCalledOnce();
        expect(app.window.WorldView.open).toHaveBeenCalledWith(expect.objectContaining({ closable: false }));
    });

    it.each([
        ['', `/designs/${DESIGN_A}`], ['', `/agreements/${AGREEMENT}`], ['', '/proposals'], ['', '/proposals/'],
        ['', '/proposals/solana/devnet/abc/7'], ['', '/parcel/HR-335240-1323/2'], ['', '/bets/market-account']
    ])('does not hijack %s %s when another boot handler consumes its query', (search, pathname) => {
        const app = boot(search, pathname);
        app.window.location.search = '';
        app.ready();
        expect(app.window.WorldView.open).not.toHaveBeenCalled();
        expect(app.classes.has('world-view-pending')).toBe(false);
    });
});

describe('globe return control', () => {
    it('offers a map return only above the automatic globe threshold', () => {
        expect(Model.canReturnToMap(5)).toBe(true);
        expect(Model.canReturnToMap(4)).toBe(false);
        expect(Model.canReturnToMap(null)).toBe(false);
        expect(Model.canReturnToMap(Infinity)).toBe(false);
    });
});

describe('zoom out return to globe', () => {
    it('opens only after a user zooms out to zoom 4 or below without a blocker', () => {
        expect(Model.shouldReturnToGlobe({ fromZoom: 5, toZoom: 4, userInitiated: true })).toBe(true);
        expect(Model.shouldReturnToGlobe({ fromZoom: 4, toZoom: 3, userInitiated: true })).toBe(true);
        expect(Model.shouldReturnToGlobe({ fromZoom: 6, toZoom: 5, userInitiated: true })).toBe(false);
        expect(Model.shouldReturnToGlobe({ fromZoom: 3, toZoom: 4, userInitiated: true })).toBe(false);
        expect(Model.shouldReturnToGlobe({ fromZoom: 5, toZoom: 4, userInitiated: false })).toBe(false);
        expect(Model.shouldReturnToGlobe({ fromZoom: 5, toZoom: 4, userInitiated: true, blocked: true })).toBe(false);
    });
});

describe('the address follows the map', () => {
    it('writes the view as ?at=, keeping the rest of the address, and nothing when it is already there', () => {
        const next = Model.addressWithView(`http://localhost:5682/designs/${DESIGN_A}?city=zagreb&lang=hr`, { lat: 45.800451, lon: 15.978789, zoom: 17.4 });
        const url = new URL(next);
        expect(url.pathname).toBe(`/designs/${DESIGN_A}`);
        expect(url.searchParams.get('city')).toBe('zagreb');
        expect(url.searchParams.get('lang')).toBe('hr');
        expect(url.searchParams.get('at')).toBe('45.80045,15.97879,17.4');
        // what the boot reads back is the view written
        expect(Model.parseAt(url.searchParams.get('at'))).toMatchObject({ lat: 45.80045, lon: 15.97879, zoom: 17.4 });
        expect(Model.addressWithView(next, { lat: 45.800451, lon: 15.978789, zoom: 17.400000000000002 })).toBeNull();
        expect(Model.formatAt({ lat: 1, lon: 2, zoom: 18 })).toBe('1.00000,2.00000,18');
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

    it('goes on to the city\'s latest proposal only for a pick of the city as a whole', () => {
        const zagrebClick = { lat: 45.83, lon: 16.05, place: coverage.tierAt(45.83, 16.05) };
        expect(Model.arrivesAtLatest(Model.resolveLanding({ cityId: 'zagreb', point: zagrebClick, currentCityId: 'split', cityView: zagrebView }))).toBe(true);
        // a spot in the countrywide cadastre, a searched address, explore: the spot itself
        const osijek = { lat: 45.55, lon: 18.69, place: coverage.pointAt(45.55, 18.69) };
        expect(Model.arrivesAtLatest(Model.resolveLanding({ cityId: 'zagreb', point: osijek, currentCityId: 'zagreb', cityView: zagrebView }))).toBe(false);
        const address = { lat: 45.8132, lon: 15.9772, place: coverage.tierAt(45.8132, 15.9772) };
        expect(Model.arrivesAtLatest(Model.resolveLanding({ cityId: 'zagreb', point: address, currentCityId: 'new_york', cityView: zagrebView,
            focus: { lat: 45.8132, lon: 15.9772, zoom: 18 } }))).toBe(false);
        expect(Model.arrivesAtLatest(Model.resolveLanding({ point: osijek, currentCityId: 'zagreb', explore: true }))).toBe(false);
        expect(Model.arrivesAtLatest(null)).toBe(false);
    });

    it('inland Croatia opens the nearest Croatian city AT the clicked point, at parcel zoom', () => {
        const osijek = { lat: 45.55, lon: 18.69, place: coverage.pointAt(45.55, 18.69) };
        expect(osijek.place).toMatchObject({ kind: 'point', tier: 'live', cc: 'HR' });
        const landing = Model.resolveLanding({ cityId: osijek.place.cityId, point: osijek, currentCityId: 'new_york', cityView: zagrebView });
        expect(landing).toEqual({ cityId: osijek.place.cityId, inPlace: false, view: { lat: 45.55, lon: 18.69, zoom: 19 }, carryAt: true });
    });

    it('a Croatian spot opens in the loaded Croatian city (one countrywide cadastre), a city click switches', () => {
        const osijek = coverage.pointAt(45.55, 18.69);
        expect(Model.liveCityFor({ place: osijek, currentCityId: 'split', sameCadastre: true })).toBe('split');
        expect(Model.liveCityFor({ place: osijek, currentCityId: 'new_york', sameCadastre: false })).toBe(osijek.cityId);
        expect(Model.liveCityFor({ place: coverage.tierAt(45.83, 16.05), currentCityId: 'split', sameCadastre: true })).toBe('zagreb');
        expect(Model.liveCityFor({ place: coverage.tierAt(35.696623934, 139.766899192), currentCityId: 'split', sameCadastre: false })).toBe('tokyo');
        // ... and then lands in place, at the spot.
        const point = { lat: 45.55, lon: 18.69, place: osijek };
        expect(Model.resolveLanding({ cityId: 'split', point, currentCityId: 'split', cityView: zagrebView }))
            .toEqual({ cityId: 'split', inPlace: true, view: { lat: 45.55, lon: 18.69, zoom: 19 }, carryAt: true });
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

    it('explore opens cities and exact points at street level', () => {
        const tokyo = { lat: 35.69, lon: 139.69, place: coverage.tierAt(35.69, 139.69) };
        expect(Model.resolveLanding({ point: tokyo, currentCityId: 'zagreb', explore: true }))
            .toEqual({ cityId: 'explore', inPlace: false, view: { lat: 35.69, lon: 139.69, zoom: 19 }, carryAt: true });
        const sea = { lat: 30, lon: -40, place: coverage.pointAt(30, -40) };
        expect(Model.resolveLanding({ point: sea, currentCityId: 'explore', explore: true }))
            .toMatchObject({ cityId: 'explore', inPlace: true, view: { zoom: 19 } });
        const precise = Model.resolveLanding({ point: tokyo, currentCityId: 'zagreb', explore: true, focus: { lat: 35.69, lon: 139.69, zoom: 18 } });
        expect(precise.view.zoom).toBe(18);
    });

    it('refuses a pick without a usable point or city', () => {
        expect(() => Model.resolveLanding({ cityId: 'zagreb', point: { lat: null, lon: 1 } })).toThrow();
        expect(() => Model.resolveLanding({ point: { lat: 1, lon: 1, place: {} }, currentCityId: 'zagreb' })).toThrow();
    });

    it('keeps an arbitrary live-city point at street level rather than opening its city center or latest proposal', () => {
        const point = { lat: 45.83, lon: 16.05, place: coverage.pointAt(45.83, 16.05) };
        const landing = Model.resolveLanding({ cityId: point.place.cityId, point,
            currentCityId: 'new_york', cityView: zagrebView });
        expect(landing).toMatchObject({ carryAt: true, view: { lat: 45.83, lon: 16.05, zoom: 19 } });
        expect(Model.arrivesAtLatest(landing)).toBe(false);
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
            setScope: scope => { scopes.push([scope]); },
            getItem: () => null,
            setItem: () => {}
        },
        dispatchEvent: () => true
    };
    const fn = new Function('window', 'localStorage', 'PersistentStorage', 'URL', 'URLSearchParams', cityConfigSource());
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
        // metres are never the explored place's UTM zone (projections.md §2): no metric CRS at all
        expect(config.projection.metricCrs).toBeUndefined();
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

    it('disables every parcel-dependent section, and keeps proposing possible', () => {
        const disabled = tokyo.manager.getCityConfig('explore').sidebar.disabledSections;
        for (const section of ['parcels', 'parcelBlocks', 'roads', 'areaMonitor']) {
            expect(disabled).toContain(section);
        }
        // Buildings need no parcels: Explore's city default is OpenStreetMap through the backend.
        expect(disabled).not.toContain('buildings');
        expect(tokyo.manager.getCityConfig('explore').buildings.sources).toEqual([{ id: 'osm' }]);
        // A site drawn here has an empty binding (PARCEL-OPTIONAL.md): proposals and stations
        // need no parcels.
        expect(disabled).not.toContain('proposals');
        expect(disabled).not.toContain('stations');
        // Drawing a road needs no dataset and no parcels: the 'roads' section (Zagreb's road
        // datasets) is off, road drawing is not.
        expect(tokyo.manager.isFeatureEnabled('roadTools')).toBe(true);
        expect(tokyo.manager.isFeatureEnabled('parcelBlocks')).toBe(false);
    });

    it('keeps road drawing on in cities without Zagreb\'s road datasets', () => {
        const sibenik = loadCityConfig('?city=sibenik').manager;
        expect(sibenik.getCurrentCityConfig().sidebar.disabledSections).toContain('roads');
        expect(sibenik.isFeatureEnabled('roadTools')).toBe(true);
        expect(loadCityConfig('?city=zg').manager.isFeatureEnabled('roadTools')).toBe(true);
    });

    it('is not a city: not listed, not nearest, not stored, its own storage scope', () => {
        const { manager, writes, scopes, store } = tokyo;
        expect(manager.getAvailableCities().map(c => c.id)).not.toContain('explore');
        expect(manager.findNearestCity(35.68, 139.76).id).not.toBe('explore');
        expect(writes.filter(([key]) => key === 'cb_current_city')).toEqual([]);
        expect(scopes).toEqual([['explore']]);
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

    function fakePage(ownsBoot, search = '') {
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
        globalThis.location = { search };
        delete globalThis.__siteIntroInitialized;
        return modal;
    }

    it('does not put an automatic introduction over a globe landing', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(true);
        initSiteIntro();
        expect(modal.hidden).toBe(true);
        globalThis.dispatchEvent(new Event('worldview:landed'));
        expect(modal.hidden).toBe(true);
    });

    it('leaves a direct arrival unobstructed', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(false);
        initSiteIntro();
        expect(modal.hidden).toBe(true);
    });

    it('waits for the visitor to land when the introduction was explicitly requested', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(true, '?intro=1');
        initSiteIntro();
        expect(modal.hidden).toBe(true);
        globalThis.dispatchEvent(new Event('worldview:landed'));
        expect(modal.hidden).toBe(false);
    });

    it('shows a requested introduction at once when no globe owns the boot', () => {
        const { initSiteIntro } = require(path.join(REPO, 'frontend/js/site-intro.js'));
        const modal = fakePage(false, '?intro=1');
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
        expect(html).not.toContain('id="world-view-button"');
    });

    it('drops the commands of a section the city config hid, with the reason', () => {
        const UiCommands = require(path.join(REPO, 'frontend/js/ui/commands.js'));
        const ctx = hidden => ({
            mode: '2d', selection: { active: false, count: 0 },
            global: { startTransitStationPlacement() {} }, parcel: { parcelId: 'parcel-1' },
            isControlAvailable: () => true, isSectionHidden: section => hidden.includes(section)
        });
        const ids = hidden => UiCommands.commandsFor('palette', ctx(hidden)).map(c => c.id);
        expect(ids([])).toEqual(expect.arrayContaining(['blocks.reform', 'stations.road', 'proposals.list', 'game.new']));
        const explore = ids(['parcels', 'blocks', 'stations', 'roads', 'proposals', 'game', 'areaMonitor']);
        for (const id of ['blocks.reform', 'stations.road', 'roads.drawOsm', 'proposals.list', 'game.new', 'parcels.clearLocal']) expect(explore).not.toContain(id);
        expect(explore).toEqual(expect.arrayContaining(['tools.measure', 'world.open', 'settings.baseMap', 'activity.events', 'activity.actors']));
        const ranked = UiCommands.rankCommands('reform', ctx(['blocks']), null).find(item => item.entry.id === 'blocks.reform');
        expect(ranked).toMatchObject({ available: false, reason: 'hiddenForCity' });
    });

    it('registers the world view command through the city control and the palette', () => {
        const UiCommands = require(path.join(REPO, 'frontend/js/ui/commands.js'));
        const entry = UiCommands.findCommand('world.open');
        expect(entry).toBeTruthy();
        expect(entry.surfaces).toEqual(['palette']);
        const clickSelector = vi.fn();
        entry.run({ clickSelector });
        expect(clickSelector).toHaveBeenCalledWith('.map-search__chip');
    });
});
