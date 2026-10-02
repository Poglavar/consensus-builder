// World-view coverage lookups (frontend/js/world/world-coverage.js) against the committed
// frontend/data/world-coverage.json: tier at a point and place search.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const WorldCoverage = require(path.join(REPO, 'frontend/js/world/world-coverage.js'));
const data = JSON.parse(readFileSync(path.join(REPO, 'frontend/data/world-coverage.json'), 'utf8'));
const coverage = WorldCoverage.create(data);

describe('tierAt', () => {
    it('opens Bogotá through its source and keeps neighbouring municipalities outside the entry area', () => {
        expect(coverage.tierAt(4.60975, -74.08175)).toMatchObject({ kind: 'live-city', cityId: 'bogota', sourceId: 'co-bogota-uaecd-lote' });
        expect(coverage.searchPlaces('bogota')[0]).toMatchObject({ cityId: 'bogota', sourceId: 'co-bogota-uaecd-lote', dataVersion: '2021-12' });
        expect(coverage.tierAt(4.58, -74.22).cityId).not.toBe('bogota');
    });
    it('opens the Toronto streaming source and respects its limited entry area', () => {
        expect(coverage.tierAt(43.6535, -79.3825)).toMatchObject({ kind: 'live-city', cityId: 'toronto', sourceId: 'ca-on-toronto-property-boundary' });
        expect(coverage.searchPlaces('toronto')[0]).toMatchObject({ cityId: 'toronto', sourceId: 'ca-on-toronto-property-boundary' });
        expect(coverage.tierAt(43.85, -79.32).cityId).not.toBe('toronto');
        expect(coverage.tierAt(43.59, -79.64).cityId).not.toBe('toronto');
    });
    it('opens a configured city near its centre', () => {
        const place = coverage.tierAt(45.83, 16.05); // eastern Zagreb, a few km from the centre
        expect(place).toMatchObject({ kind: 'live-city', tier: 'live', cityId: 'zagreb', cc: 'HR', country: 'Croatia' });
    });

    it('treats all of Croatia as live, opening the nearest Croatian city', () => {
        const osijek = coverage.tierAt(45.55, 18.69);
        expect(osijek).toMatchObject({ kind: 'country', tier: 'live', cc: 'HR', cityId: 'zagreb' });
        const dubrovnik = coverage.tierAt(42.65, 18.09);
        expect(dubrovnik.tier).toBe('live');
        expect(['split', 'sibenik']).toContain(dubrovnik.cityId);
    });

    it('marks Tokyo as a verified open source', () => {
        expect(coverage.tierAt(35.69, 139.69)).toMatchObject({ kind: 'city', tier: 'source', name: 'Tokyo', cc: 'JP', placeKey: 'geonames:1850147' });
    });

    it('marks Jakarta as researched with nothing open', () => {
        expect(coverage.tierAt(-6.2, 106.85)).toMatchObject({ kind: 'city', tier: 'none', name: 'Jakarta' });
    });

    it('returns unknown ocean in the mid-Atlantic', () => {
        expect(coverage.tierAt(30, -40)).toMatchObject({ kind: 'ocean', tier: 'unknown', cc: null, placeKey: 'point:30.0,-40.0' });
    });

    it('falls back to the country polygon away from any city', () => {
        const kansas = coverage.tierAt(38.5, -98.5);
        expect(kansas).toMatchObject({ kind: 'country', cc: 'US', tier: 'source', placeKey: 'country:US' });
        const siberia = coverage.tierAt(62, 100);
        expect(siberia).toMatchObject({ kind: 'country', cc: 'RU' });
    });

    it('prefers a live city over a registry city at the same place', () => {
        expect(coverage.tierAt(40.71, -74.0)).toMatchObject({ tier: 'live', cityId: 'new_york' });
    });

    it('rejects non-numeric input rather than returning a real-looking place', () => {
        expect(() => coverage.tierAt(null, 10)).toThrow();
        expect(() => coverage.tierAt(Number.NaN, 10)).toThrow();
    });
});

describe('searchPlaces', () => {
    it('is diacritic-insensitive both ways', () => {
        expect(coverage.searchPlaces('sibenik')[0]).toMatchObject({ kind: 'live-city', cityId: 'sibenik', name: 'Šibenik' });
        expect(coverage.searchPlaces('São')[0].name).toBe('São Paulo');
        expect(coverage.searchPlaces('sao paulo')[0].name).toBe('São Paulo');
    });

    it('ranks prefix matches above substrings and configured cities above others', () => {
        const hits = coverage.searchPlaces('bel');
        expect(hits[0]).toMatchObject({ kind: 'live-city', cityId: 'belgrade' });
        const idx = name => hits.findIndex(h => h.name === name);
        if (idx('Belgium') >= 0) expect(idx('Belgium')).toBeGreaterThan(0);
    });

    it('finds countries with a flyable centre', () => {
        const japan = coverage.searchPlaces('japan')[0];
        expect(japan).toMatchObject({ kind: 'country', cc: 'JP', tier: 'source' });
        expect(Number.isFinite(japan.lat) && Number.isFinite(japan.lon)).toBe(true);
    });

    it('does not list a registry duplicate of a configured city', () => {
        const names = coverage.searchPlaces('new york').map(h => h.name);
        expect(names[0]).toBe('New York');
        expect(names).not.toContain('New York City');
    });

    it('returns nothing for an empty query and honours the limit', () => {
        expect(coverage.searchPlaces('   ')).toEqual([]);
        expect(coverage.searchPlaces('a', { limit: 3 })).toHaveLength(3);
    });
});

// The explore city chip's name (js/ui/world-entry.js): where the map is, from local data only.
describe('nameAt (the explore chip)', () => {
    it('names the city the map is on', () => {
        expect(coverage.nameAt(35.68, 139.76, 14)).toMatchObject({ kind: 'city', name: 'Tokyo', cc: 'JP' });
        expect(coverage.nameAt(45.81, 15.97, 14)).toMatchObject({ kind: 'city', name: 'Zagreb', cc: 'HR' });
    });

    it('falls back to the country away from any registry city (Yokohama is not Tokyo)', () => {
        expect(coverage.nameAt(35.44, 139.64, 14)).toMatchObject({ kind: 'country', name: 'Japan', cc: 'JP' });
        // Still "Tokyo" for coverage, which reaches further than a name does.
        expect(coverage.tierAt(35.44, 139.64)).toMatchObject({ kind: 'city', name: 'Tokyo' });
    });

    it('has no name on open water or for a continent-wide view (the default world view is over Libya)', () => {
        expect(coverage.nameAt(34.5, 141.5, 10)).toEqual({ kind: 'ocean', name: '', cc: null });
        expect(coverage.nameAt(30, 15, 3)).toEqual({ kind: 'world', name: '', cc: null });
        expect(coverage.nameAt(30, 15, 8)).toMatchObject({ kind: 'country', name: 'Libya' });
    });

    it('refuses a non-finite point', () => {
        expect(() => coverage.nameAt(NaN, 1, 10)).toThrow(/finite/);
    });

    it('the chip is renamed from nameAt on every settled move, not once at boot', () => {
        const source = readFileSync(path.join(REPO, 'frontend/js/ui/world-entry.js'), 'utf8');
        expect(source).toMatch(/state\.explorePlace = place;/);
        expect(source).toMatch(/cov\.nameAt\(view\.lat, view\.lon, view\.zoom\)/);
        const moveend = source.slice(source.indexOf("map.on('moveend'"));
        expect(moveend.slice(0, 600)).toMatch(/identifyExplorePlace\(view\)/);
    });
});
