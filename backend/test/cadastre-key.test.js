// Which parcel data a city reads (CityConfigManager.getCadastreKey), and the search box's
// in-place moves that depend on it (search-model.js classifyPlaceLocation), over the REAL city
// configs. Every catalogue city's provider kind is 'parcel-source', so comparing that called 29
// neighbouring pairs one cadastre (San Francisco and Oakland, Saint Paul and Minneapolis); and any
// place within 40 km of the current city counted as "here". Either kept the user in one city while
// authoring on another's land, with the first city's parcels — none — loaded.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/ui/search-model.js');

let manager;
let cities;

beforeAll(() => {
    // city-config.js is a classic script that assigns window.CityConfigManager (same realm, as
    // parcel-deep-link-city.test.js does)
    globalThis.window = globalThis;
    (0, eval)(readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8'));
    manager = globalThis.window.CityConfigManager;
    // what map-search.js configuredCities() hands the model
    cities = manager.getAvailableCities().map(config => ({
        id: config.id, label: config.label, center: manager.getCityCenter(config), parcelSource: manager.getPlaceDataKey(config.id)
    }));
});

const centreOf = id => { const c = cities.find(city => city.id === id).center; return { lat: c[0], lon: c[1] }; };

describe('getCadastreKey', () => {
    it('a place\'s data is the cadastre and the buildings together', () => {
        expect(manager.getPlaceDataKey('split')).toBe(manager.getPlaceDataKey('sibenik'));
        expect(manager.getPlaceDataKey('zagreb')).not.toBe(manager.getPlaceDataKey('split'));
        expect(manager.getPlaceDataKey('explore')).toBe(null);
    });

    it('is the source id for catalogue cities, the provider for the rest, none for explore', () => {
        expect(manager.getCadastreKey('san_francisco')).toBe('us-ca-sf-datasf-active-parcels');
        expect(manager.getCadastreKey('oakland')).toBe('us-ca-oakland-parcels');
        expect(manager.getCadastreKey('cologne')).toBe(manager.getCadastreKey('dusseldorf'));
        for (const id of ['zagreb', 'split', 'sibenik']) expect(manager.getCadastreKey(id)).toBe('oss-wfs');
        expect(manager.getCadastreKey('explore')).toBe(null);
        expect(manager.getCadastreKey('no_such_city')).toBe(null);
    });
});

describe('the search box moves in place only onto the same parcel data', () => {
    it('sends a place in a neighbouring city with other parcel data to that city', () => {
        expect(Model.classifyPlaceLocation(centreOf('oakland'), cities, 'san_francisco')).toMatchObject({ kind: 'other-city', city: { id: 'oakland' } });
        expect(Model.classifyPlaceLocation(centreOf('minneapolis'), cities, 'saint_paul')).toMatchObject({ kind: 'other-city', city: { id: 'minneapolis' } });
    });

    it('keeps a place in a city reading the same cadastre and buildings in place', () => {
        expect(Model.classifyPlaceLocation(centreOf('sibenik'), cities, 'split')).toMatchObject({ kind: 'here', city: { id: 'sibenik' } });
        expect(Model.classifyPlaceLocation(centreOf('dusseldorf'), cities, 'cologne')).toMatchObject({ kind: 'here', city: { id: 'dusseldorf' } });
        // one countrywide cadastre, but Zagreb's buildings are its own survey: Split reloads
        expect(Model.classifyPlaceLocation(centreOf('split'), cities, 'zagreb')).toMatchObject({ kind: 'other-city', city: { id: 'split' } });
    });

    it('holds for every pair of configured cities within reach of each other', () => {
        const wrong = [];
        for (const a of cities) {
            for (const b of cities) {
                if (a.id === b.id) continue;
                // an in-place move from a to b's centre ('here'): only onto the same parcel and building data
                if (Model.classifyPlaceLocation(centreOf(b.id), cities, a.id).kind !== 'here') continue;
                if (manager.getCadastreKey(a.id) !== manager.getCadastreKey(b.id)
                    || manager.getCityConfig(a.id).buildings?.source !== manager.getCityConfig(b.id).buildings?.source) wrong.push(`${a.id} -> ${b.id}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('could fail: the provider kind every catalogue city shares calls San Francisco and Oakland one cadastre', () => {
        const byProvider = cities.map(city => ({ ...city, parcelSource: manager.getCityConfig(city.id).parcels.source }));
        expect(Model.classifyPlaceLocation(centreOf('oakland'), byProvider, 'san_francisco')).toMatchObject({ kind: 'here' });
    });
});

describe('city identity in links and storage', () => {
    it('a share link names every configured city so that the boot opens it', () => {
        const { buildCityQueryParam } = require('../../frontend/js/proposals/server-sync.js');
        const wrong = cities.filter(city => {
            const value = new URLSearchParams(buildCityQueryParam(city.id)).get('city');
            return manager.resolveCityId(value) !== city.id;
        }).map(city => city.id);
        expect(wrong).toEqual([]);
    });

    it('resolves the spellings links and records use, and nothing else', () => {
        expect(manager.resolveCityId('Zagreb')).toBe('zagreb');
        expect(manager.resolveCityId(' zg ')).toBe('zagreb');
        expect(manager.resolveCityId('city')).toBe(null);
        expect(manager.resolveCityId('')).toBe(null);
        expect(manager.resolveCityId(null)).toBe(null);
    });

    it('sends a record home only when its city reads other parcel data than the current one', () => {
        // the current city is whatever the boot chose; the rule is relative to it
        const current = manager.getCurrentCityId();
        const sameData = cities.find(city => city.id !== current && manager.getCadastreKey(city.id) === manager.getCadastreKey(current));
        const otherData = cities.find(city => manager.getCadastreKey(city.id) && manager.getCadastreKey(city.id) !== manager.getCadastreKey(current));
        expect(manager.foreignCityFor(current)).toBe(null);
        if (sameData) expect(manager.foreignCityFor(sameData.id)).toBe(null);
        expect(manager.foreignCityFor(otherData.id)).toBe(otherData.id);
        // legacy rows naming no configured city stay where they are opened
        expect(manager.foreignCityFor('city')).toBe(null);
        expect(manager.foreignCityFor(null)).toBe(null);
        // explore has no cadastre: a city's record is never explore's, nor explore's a city's
        expect(manager.foreignCityFor('explore')).toBe(current === 'explore' ? null : 'explore');
    });
});

describe('minted proposals found on chain', () => {
    // one contract serves every city and the chain record names no city: a sync adds only this
    // city's (proposals/storage.js chainProposalBelongsHere)
    it('belong here only when every parcel is this city\'s, and never without parcels', () => {
        (0, eval)(readFileSync(new URL('../../frontend/js/proposals/storage.js', import.meta.url), 'utf8'));
        const belongs = globalThis.chainProposalBelongsHere;
        const current = manager.getCurrentCityId();
        const prefix = manager.getCityConfig(current).parcels.idPrefix || (current === 'new_york' ? 'US-NY-' : 'HR-');
        expect(belongs([`${prefix}1`, `${prefix}2`])).toBe(true);
        expect(belongs([`${prefix}1`, 'XX-OTHER-9'])).toBe(false);
        expect(belongs(['XX-OTHER-9'])).toBe(false);
        expect(belongs([])).toBe(false);
        expect(belongs(null)).toBe(false);
    });
});
