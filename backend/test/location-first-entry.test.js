// Location first (location-first.md phase 1): the city a boot opens in comes from ?at= through the
// same coverage the globe and the server use, ?city= is an alias for its centre, record links keep
// their city, and the boot subset of the coverage answers exactly like the full JSON.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { bootCoverage, bootCoverageScript } from '../../scripts/build-boot-coverage.mjs';
import { coverageRadiusKm, MIN_CITY_RADIUS_KM } from '../../scripts/build-world-coverage.mjs';
import { resolvePublicationCity } from '../proposals/publication-city.js';
import { cityNameAt, isConfiguredCity } from '../jurisdiction.js';

const require = createRequire(import.meta.url);
const WorldEntryModel = require('../../frontend/js/world/world-entry-model.js');
const WorldCoverage = require('../../frontend/js/world/world-coverage.js');
const fullJson = require('../../frontend/data/world-coverage.json');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

const full = WorldCoverage.create(fullJson);
const boot = WorldCoverage.create(bootCoverage(fullJson));

const ZAGREB = { lat: 45.81305, lon: 15.9706 };
const MANHATTAN = { lat: 40.7484, lon: -73.9857 };
const MID_ATLANTIC = { lat: 30, lon: -40 };
const OSIJEK = { lat: 45.5550, lon: 18.6955 }; // Croatia, beyond every city circle: countrywide

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('WorldEntryModel.resolveEntry', () => {
    const configured = new Set(['zagreb', 'new_york', 'explore', 'split']);
    const shortCodes = { zg: 'zagreb', ny: 'new_york', st: 'split' };
    const resolveCityParam = raw => {
        const id = shortCodes[raw.toLowerCase()] || raw.toLowerCase();
        return configured.has(id) ? id : null;
    };
    const jurisdictionAt = (lat, lon) => full.jurisdictionAt(lat, lon);
    const resolve = (search, extra = {}) => WorldEntryModel.resolveEntry({
        pathname: '/', search, storedCityId: null, resolveCityParam, jurisdictionAt, ...extra
    });

    it('takes the city from ?at= alone, whatever city is stored', () => {
        expect(resolve('?at=45.81305,15.97060,19', { storedCityId: 'new_york' })).toMatchObject({
            cityId: 'zagreb', source: 'at', view: { lat: 45.81305, lon: 15.9706, zoom: 19 }, ignoredCity: null, dropCityParam: false
        });
    });

    it('opens explore where no city covers the point', () => {
        expect(resolve('?at=30,-40,6')).toMatchObject({ cityId: 'explore', source: 'at', view: { lat: 30, lon: -40, zoom: 6 } });
    });

    it('lets ?at= win over a ?city= that disagrees, naming the ignored city and dropping it', () => {
        expect(resolve('?city=zagreb&at=40.7484,-73.9857,17')).toMatchObject({
            cityId: 'new_york', source: 'at', ignoredCity: 'zagreb', dropCityParam: true
        });
    });

    it('drops an agreeing ?city= without calling it ignored, short codes included', () => {
        expect(resolve('?city=zg&at=45.81305,15.97060,19')).toMatchObject({ cityId: 'zagreb', ignoredCity: null, dropCityParam: true });
    });

    it('treats a legacy ?city=explore beside ?at= as just the point', () => {
        expect(resolve('?city=explore&at=45.81305,15.97060,19')).toMatchObject({ cityId: 'zagreb', ignoredCity: null, dropCityParam: true });
        expect(resolve('?city=explore&at=30,-40,6')).toMatchObject({ cityId: 'explore', ignoredCity: null });
    });

    it('reads ?city= alone as that city at its own default view', () => {
        expect(resolve('?city=zg', { storedCityId: 'new_york' })).toMatchObject({ cityId: 'zagreb', view: null, source: 'city', dropCityParam: true });
        expect(resolve('?city=explore')).toMatchObject({ cityId: 'explore', view: null, source: 'city' });
    });

    it('keeps a record link in the city it names, ignoring ?at=', () => {
        expect(resolve('?focusProposal=12&city=split&at=40.7484,-73.9857,17')).toMatchObject({ cityId: 'split', view: null, source: 'record', dropCityParam: false });
        // The ?proposalShare= and ?shared= payload links are gone (M2): they name no record any more.
        expect(resolve('?proposalShare=abc', { storedCityId: 'zagreb' })).toMatchObject({ cityId: 'zagreb', source: 'stored' });
        expect(resolve('?shared=abc&city=split', { storedCityId: 'zagreb' })).toMatchObject({ cityId: 'split', source: 'city' });
        // Published designs and agreements are linked by CID (plan-design-agreement.md M2); a row id is no record link.
        expect(resolve('?city=ny', { pathname: '/designs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq' })).toMatchObject({ cityId: 'new_york', source: 'record' });
        expect(resolve('?city=ny', { pathname: '/agreements/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })).toMatchObject({ cityId: 'new_york', source: 'record' });
        expect(resolve('?city=ny', { pathname: '/proposals/7' })).toMatchObject({ cityId: 'new_york', source: 'city' });
        expect(resolve('?at=40.7484,-73.9857,17', { pathname: '/parcel/HR-1-2' , storedCityId: 'zagreb' })).toMatchObject({ cityId: 'zagreb', source: 'record' });
    });

    it('does not treat view-mode flags as records', () => {
        expect(resolve('?model&at=40.7484,-73.9857,17', { storedCityId: 'zagreb' })).toMatchObject({ cityId: 'new_york', source: 'at' });
    });

    it('ignores a malformed ?at= and an unknown ?city=', () => {
        expect(resolve('?at=not-a-place&city=zg')).toMatchObject({ cityId: 'zagreb', source: 'city' });
        expect(resolve('?city=atlantis', { storedCityId: 'split' })).toMatchObject({ cityId: 'split', source: 'stored', dropCityParam: false });
    });

    it('falls back to the stored city, then to nothing', () => {
        expect(resolve('', { storedCityId: 'split' })).toMatchObject({ cityId: 'split', source: 'stored' });
        expect(resolve('')).toMatchObject({ cityId: null, source: 'default' });
    });

    it('cannot choose by ?at= without a coverage, so it falls through rather than guessing explore', () => {
        expect(resolve('?at=45.81305,15.97060,19', { jurisdictionAt: undefined, storedCityId: 'split' })).toMatchObject({ cityId: 'split', source: 'stored' });
    });
});

describe('WorldEntryModel.addressWithView', () => {
    it('drops ?city= on request and keeps the view readable', () => {
        expect(WorldEntryModel.addressWithView('https://x.test/?city=zg&model', { lat: 45.81305, lon: 15.9706, zoom: 19 }, { dropCity: true }))
            .toBe('https://x.test/?model=&at=45.81305,15.97060,19');
        // already at the view: only dropping the city still changes the address
        expect(WorldEntryModel.addressWithView('https://x.test/?city=zg&at=45.81305,15.97060,19', { lat: 45.81305, lon: 15.9706, zoom: 19 }, { dropCity: true }))
            .toBe('https://x.test/?at=45.81305,15.97060,19');
        expect(WorldEntryModel.addressWithView('https://x.test/?city=zg&at=45.81305,15.97060,19', { lat: 45.81305, lon: 15.9706, zoom: 19 })).toBeNull();
    });
});

describe('jurisdictionAt over the configured cities', () => {
    it("resolves every live city's own centre to that city", () => {
        const wrong = fullJson.liveCities.filter(city => full.jurisdictionAt(city.lat, city.lon) !== city.id)
            .map(city => `${city.id} -> ${full.jurisdictionAt(city.lat, city.lon)}`);
        expect(fullJson.liveCities.length).toBeGreaterThan(600);
        expect(wrong).toEqual([]);
    });

    it('answers Croatia countrywide, the open sea with nothing', () => {
        expect(full.jurisdictionAt(ZAGREB.lat, ZAGREB.lon)).toBe('zagreb');
        expect(full.jurisdictionAt(MANHATTAN.lat, MANHATTAN.lon)).toBe('new_york');
        expect(full.liveCitiesAt(OSIJEK.lat, OSIJEK.lon)[0]).toMatchObject({ via: 'country' });
        expect(full.jurisdictionAt(MID_ATLANTIC.lat, MID_ATLANTIC.lon)).toBeNull();
    });

    it('opens a globe pick in the same city the boot would', () => {
        const random = mulberry32(7);
        for (let i = 0; i < 400; i++) {
            const city = fullJson.liveCities[Math.floor(random() * fullJson.liveCities.length)];
            const lat = city.lat + (random() - 0.5) * 0.3, lon = city.lon + (random() - 0.5) * 0.3;
            const place = full.tierAt(lat, lon);
            if (place.kind === 'live-city') expect(place.cityId).toBe(full.jurisdictionAt(lat, lon));
        }
    });
});

describe('server labels by place (phase 4)', () => {
    it('names the city whose data applies at a point, and knows the configured ids', () => {
        expect(cityNameAt(16.4402, 43.5081)).toBe('Split');
        expect(cityNameAt(15.9775, 45.8131)).toBe('Zagreb');
        expect(cityNameAt(-30, 30)).toBeNull();
        expect(isConfiguredCity('split')).toBe(true);
        expect(isConfiguredCity('atlantis')).toBe(false);
        expect(isConfiguredCity(null)).toBe(false);
    });
});

describe('boot coverage subset', () => {
    it('is the generated file for the current world-coverage.json', () => {
        expect(read('../../frontend/data/boot-coverage.js')).toBe(bootCoverageScript(fullJson));
    });

    it('answers liveCitiesAt exactly like the full coverage, near cities, in Croatia and anywhere', () => {
        const random = mulberry32(42);
        const points = [ZAGREB, MANHATTAN, MID_ATLANTIC, OSIJEK];
        for (const city of fullJson.liveCities) {
            points.push({ lat: city.lat, lon: city.lon });
            const r = Math.min(60, city.radiusKm ?? 60) / 111;
            points.push({ lat: city.lat + (random() - 0.5) * 2.4 * r, lon: city.lon + (random() - 0.5) * 2.4 * r });
        }
        for (let i = 0; i < 300; i++) points.push({ lat: 42.3 + random() * 4.3, lon: 13.4 + random() * 6.1 }); // Croatia and its neighbours
        for (let i = 0; i < 1500; i++) points.push({ lat: (random() - 0.5) * 160, lon: (random() - 0.5) * 360 });
        const mismatches = points.filter(p => JSON.stringify(boot.liveCitiesAt(p.lat, p.lon)) !== JSON.stringify(full.liveCitiesAt(p.lat, p.lon)));
        expect(points.length).toBeGreaterThan(3000);
        expect(mismatches).toEqual([]);
    });
});

describe('the server files a city-less publication where the boot opens', () => {
    it('agrees with jurisdictionAt for points across the configured cities and beyond', () => {
        const random = mulberry32(3);
        const points = [ZAGREB, MANHATTAN, MID_ATLANTIC, OSIJEK];
        for (let i = 0; i < 300; i++) {
            const city = fullJson.liveCities[Math.floor(random() * fullJson.liveCities.length)];
            points.push({ lat: city.lat + (random() - 0.5) * 0.4, lon: city.lon + (random() - 0.5) * 0.4 });
        }
        for (const p of points) {
            expect(resolvePublicationCity({ city: null, lon: p.lon, lat: p.lat }).city).toBe(full.jurisdictionAt(p.lat, p.lon) || 'explore');
            // a requested city decides nothing where some city covers the site (phase 4)
            const covered = full.jurisdictionAt(p.lat, p.lon);
            if (covered) expect(resolvePublicationCity({ city: 'new_york', lon: p.lon, lat: p.lat }).city).toBe(covered);
        }
    });
});

describe('city-config boot', () => {
    // city-config.js in a fresh realm, with the boot scripts it loads after (index.html order).
    function boot(search, { stored = null, pathname = '/' } = {}) {
        const storage = new Map(stored ? [['cb_current_city', stored]] : []);
        const logs = [];
        const context = {
            URLSearchParams, URL,
            console: { ...console, info: message => logs.push(message), error: message => logs.push(message) },
            location: { search, pathname, href: `https://x.test${pathname}${search}` },
            localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
            WorldEntryModel, WorldCoverage, BOOT_COVERAGE: bootCoverage(fullJson)
        };
        context.window = context;
        runInContext(read('../../frontend/js/city-config.js'), createContext(context));
        return { manager: context.CityConfigManager, storage, logs };
    }

    it('boots a Zagreb ?at= in Zagreb over a stored New York, and stores Zagreb', () => {
        const { manager, storage } = boot('?at=45.81305,15.97060,19', { stored: 'new_york' });
        expect(manager.getCurrentCityId()).toBe('zagreb');
        expect(manager.getBootEntry()).toMatchObject({ source: 'at', dropCityParam: false });
        expect(storage.get('cb_current_city')).toBe('zagreb');
        expect(manager.wasCityChosenAtBoot()).toBe(true);
    });

    it('logs and drops a contradicting ?city=', () => {
        const { manager, logs } = boot('?city=zagreb&at=40.7484,-73.9857,17');
        expect(manager.getCurrentCityId()).toBe('new_york');
        expect(manager.getBootEntry()).toMatchObject({ ignoredCity: 'zagreb', dropCityParam: true });
        expect(logs.some(line => /city=zagreb ignored: at= lies in new_york/.test(line))).toBe(true);
    });

    it('opens explore at an uncovered ?at= without storing it, centred on the point', () => {
        const { manager, storage } = boot('?at=30,-40,6', { stored: 'split' });
        expect(manager.getCurrentCityId()).toBe('explore');
        expect(manager.getCurrentCityConfig().map.defaultCenter).toEqual([30, -40]);
        expect(storage.get('cb_current_city')).toBe('split');
    });

    it('keeps a record link in its ?city=', () => {
        const { manager } = boot('?city=split&focusProposal=4&at=40.7484,-73.9857,17');
        expect(manager.getCurrentCityId()).toBe('split');
    });

    it('answers which city applies at any point, whatever city booted (geography follows the place)', () => {
        const { manager } = boot('?at=45.81305,15.97060,19');
        expect(manager.cityAt(43.5081, 16.4402)).toBe('split');
        expect(manager.cityAt(40.7484, -73.9857)).toBe('new_york');
        expect(manager.cityAt(30, -40)).toBe('explore');
        expect(manager.getCityConfigAt(45.81305, 15.9706)).toBe(manager.getCurrentCityConfig());
        expect(manager.getCityConfigAt(40.7484, -73.9857).id).toBe('new_york');
    });

    it('says so loudly, and falls back to the stored city, when the boot coverage is missing', () => {
        const storage = new Map([['cb_current_city', 'split']]);
        const errors = [];
        const context = {
            URLSearchParams, URL, console: { ...console, error: message => errors.push(message) },
            location: { search: '?at=45.81305,15.97060,19', pathname: '/', href: 'https://x.test/?at=45.81305,15.97060,19' },
            localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: () => {} },
            WorldEntryModel, WorldCoverage
        };
        context.window = context;
        runInContext(read('../../frontend/js/city-config.js'), createContext(context));
        expect(context.CityConfigManager.getCurrentCityId()).toBe('split');
        expect(errors.some(line => /boot coverage missing/.test(line))).toBe(true);
    });
});

describe('coverage sized to the city (phase 2b)', () => {
    it('widens a sampled radius to 10 km and keeps larger declared ones and the 60 km cap', () => {
        expect(coverageRadiusKm(3)).toBe(MIN_CITY_RADIUS_KM);
        expect(coverageRadiusKm(8)).toBe(MIN_CITY_RADIUS_KM);
        expect(coverageRadiusKm(12)).toBe(12); // Bogotá: a researched limit stands
        expect(coverageRadiusKm(90)).toBe(60);
    });

    it('never shrinks a city that declares no radius (it keeps the 60 km cap)', () => {
        expect(coverageRadiusKm(undefined)).toBeNull();
        expect(coverageRadiusKm(null)).toBeNull();
    });

    it('leaves no live city covering less than 10 km, and every former 3 km city at 10', () => {
        const small = fullJson.liveCities.filter(city => city.radiusKm != null && city.radiusKm < MIN_CITY_RADIUS_KM).map(city => city.id);
        expect(small).toEqual([]);
        expect(fullJson.liveCities.find(city => city.id === 'surat').radiusKm).toBe(10); // declared 3 km
        expect(fullJson.liveCities.find(city => city.id === 'bogota').radiusKm).toBe(12);
    });
});
