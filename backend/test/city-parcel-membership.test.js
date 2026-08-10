// Every configured city must be one isInCity knows about.
//
// This is the quietest failure in the app, so it gets a test that cannot be forgotten rather than a
// list someone has to remember to update. A city absent from isInCity does not degrade — it fails
// totally and silently: isInCity answers false for the city's OWN parcels, rebuildAppliedFabric
// filters every applied proposal out of the replay, and the rebuild reports a cheerful
// {ok: true, applied: 0}. Proposals there mark themselves applied, cut nothing, draw nothing, and
// come back invisible after a reload, with no error logged anywhere.
//
// Šibenik and Split were both in that state: configured cities, fully working parcels, and every
// proposal applied in them silently did nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const storageSource = read('../../frontend/js/proposals/storage.js');
const cityConfigSource = read('../../frontend/js/city-config.js');

// The cities the app actually offers, taken from the config rather than restated here — restating
// them is what let two of them drift out of isInCity in the first place.
function configuredCityIds() {
    const ids = new Set();
    const pattern = /^\s{12}id:\s*'([a-z_]+)'/gm;
    let match;
    while ((match = pattern.exec(cityConfigSource)) !== null) ids.add(match[1]);
    return [...ids];
}

// isInCity's own table and the function itself, lifted out of the classic script so the real source
// is what gets exercised.
function loadIsInCity() {
    const start = storageSource.indexOf('const CITY_PARCEL_ID_PREFIXES');
    expect(start).toBeGreaterThan(-1);
    const marker = '\nfunction isInCity(';
    const functionStart = storageSource.indexOf(marker, start);
    expect(functionStart).toBeGreaterThan(-1);
    const end = storageSource.indexOf('\n}', functionStart);
    expect(end).toBeGreaterThan(-1);
    const snippet = storageSource.slice(start, end + 2);
    // eslint-disable-next-line no-new-func
    return new Function(`${snippet}; return { isInCity, CITY_PARCEL_ID_PREFIXES };`)();
}

const { isInCity, CITY_PARCEL_ID_PREFIXES } = loadIsInCity();

describe('isInCity covers every configured city', () => {
    it('finds the cities in the config at all', () => {
        const ids = configuredCityIds();
        expect(ids).toContain('zagreb');
        expect(ids).toContain('sibenik');
        expect(ids.length).toBeGreaterThanOrEqual(6);
    });

    it('knows a parcel-id space for each of them', () => {
        const known = new Set([...Object.keys(CITY_PARCEL_ID_PREFIXES), 'buenos_aires']);
        const unhandled = configuredCityIds().filter(id => !known.has(id));
        expect(unhandled).toEqual([]);
    });

    it('accepts each city its own parcels rather than refusing them', () => {
        const sample = {
            zagreb: 'HR-335533-4090/1',
            split: 'HR-334286-1',
            sibenik: 'HR-330264-628',
            belgrade: 'SR-70123-456',
            ljubljana: 'SI-1234-56',
            buenos_aires: '001-002-3A',
            colorado: 'US-CO-12345',
            new_york: 'US-NY-1-100'
        };
        configuredCityIds().forEach(city => {
            expect(sample[city], `no sample parcel id for configured city ${city}`).toBeTruthy();
            expect(isInCity(sample[city], city), `${city} refuses its own parcel`).toBe(true);
        });
    });
});

describe('isInCity still separates the id spaces', () => {
    it('keeps a Croatian parcel out of a foreign city', () => {
        expect(isInCity('HR-330264-628', 'belgrade')).toBe(false);
        expect(isInCity('HR-330264-628', 'new_york')).toBe(false);
        expect(isInCity('SR-70123-456', 'zagreb')).toBe(false);
    });

    it('treats the Croatian cities as one id space, because they share one national dataset', () => {
        // Not a looseness introduced here: Zagreb has always accepted any HR- id, and there is no
        // per-city cadastre to distinguish them by.
        ['zagreb', 'split', 'sibenik'].forEach(city => {
            expect(isInCity('HR-330264-628', city)).toBe(true);
        });
    });

    it('refuses an unknown city instead of waving its parcels through', () => {
        expect(isInCity('HR-330264-628', 'atlantis')).toBe(false);
        expect(isInCity('HR-330264-628', '')).toBe(false);
        expect(isInCity('', 'zagreb')).toBe(false);
        expect(isInCity(null, 'zagreb')).toBe(false);
    });
});
