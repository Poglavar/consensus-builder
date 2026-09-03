// Which city does a deep-linked parcel belong to? (frontend/js/parcels/route.js)
//
// Every Croatian city reads ONE countrywide cadastre, so an `HR-` id names the country and the
// cadastral municipality but not the city. It used to hardcode `HR-` → zagreb, which meant a shared
// link to any Split or Šibenik parcel opened Zagreb — the parcel still loaded (the backend serves
// all of Croatia) but the city selector, the currency and, more seriously, the city a proposal made
// from there gets filed under were all wrong.
//
// These tests drive the REAL city configs, not a restatement of them, so a new Croatian city is
// covered the moment it is added to city-config.js.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// city-config.js is a classic script that assigns window.CityConfigManager. Evaluate it in THIS
// realm behind a minimal window stub (it guards every other browser dependency with typeof checks),
// then route.js — required after, so its `global.CityConfigManager` lookup finds the real one.
let CityConfigManager;
let route;

beforeAll(() => {
    globalThis.window = globalThis;
    const src = readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8');
    (0, eval)(src);
    CityConfigManager = globalThis.window.CityConfigManager;
    route = require('../../frontend/js/parcels/route.js');
});

describe('parcelIdToCityId — prefixes that are unambiguous', () => {
    it('maps each one-city country prefix', () => {
        expect(route.parcelIdToCityId('US-NY-1000010001')).toBe('new_york');
        expect(route.parcelIdToCityId('US-CO-12345')).toBe('colorado');
        expect(route.parcelIdToCityId('SI-1234-56')).toBe('ljubljana');
        expect(route.parcelIdToCityId('SR-123456')).toBe('belgrade');
        expect(route.parcelIdToCityId('001-005-027A')).toBe('buenos_aires');
    });

    it('refuses to guess a city for an HR id', () => {
        // The whole point: the prefix cannot answer this, so it must not pretend to.
        expect(route.parcelIdToCityId('HR-330264-4975/4')).toBeNull();
        expect(route.parcelIdToCityId('HR-335550-1')).toBeNull();
    });

    it('returns null for junk rather than throwing', () => {
        expect(route.parcelIdToCityId('')).toBeNull();
        expect(route.parcelIdToCityId(null)).toBeNull();
        expect(route.parcelIdToCityId('nonsense')).toBeNull();
    });
});

describe('firstLatLngOfFeature', () => {
    it('reaches the first coordinate through Polygon and MultiPolygon nesting', () => {
        const polygon = { geometry: { coordinates: [[[15.88, 43.73], [15.89, 43.74]]] } };
        const multi = { geometry: { coordinates: [[[[16.44, 43.50], [16.45, 43.51]]]] } };
        expect(route.firstLatLngOfFeature(polygon)).toEqual([43.73, 15.88]);
        expect(route.firstLatLngOfFeature(multi)).toEqual([43.50, 16.44]);
    });

    it('returns null when there is no usable coordinate', () => {
        expect(route.firstLatLngOfFeature(null)).toBeNull();
        expect(route.firstLatLngOfFeature({})).toBeNull();
        expect(route.firstLatLngOfFeature({ geometry: { coordinates: [] } })).toBeNull();
        expect(route.firstLatLngOfFeature({ geometry: { coordinates: [[['x', 'y']]] } })).toBeNull();
    });
});

describe('CityConfigManager.getCitiesByParcelSource', () => {
    it('collects exactly the cities reading the Croatian cadastre', () => {
        const ids = CityConfigManager.getCitiesByParcelSource('oss-wfs').map(c => c.id).sort();
        expect(ids).toEqual(['sibenik', 'split', 'zagreb']);
    });
});

describe('findNearestCity with a filter', () => {
    const croatian = config => config.parcels?.source === 'oss-wfs';

    it('places real coordinates in the right Croatian city', () => {
        // Šibenik cathedral, Split Riva, Zagreb main square.
        expect(CityConfigManager.findNearestCity(43.7359, 15.8890, { filter: croatian }).id).toBe('sibenik');
        expect(CityConfigManager.findNearestCity(43.5081, 16.4402, { filter: croatian }).id).toBe('split');
        expect(CityConfigManager.findNearestCity(45.8131, 15.9775, { filter: croatian }).id).toBe('zagreb');
    });

    it('keeps a Croatian parcel out of a foreign city that happens to be nearer', () => {
        // Vukovar: ~140 km from Belgrade, ~230 km from Zagreb. Unfiltered, Belgrade wins — and
        // Belgrade's parcels come from a different country's cadastre entirely, so a Croatian
        // parcel routed there would be fetched from /parcel-bg and never found.
        const unfiltered = CityConfigManager.findNearestCity(45.3511, 18.9946);
        expect(unfiltered.id).toBe('belgrade');
        const filtered = CityConfigManager.findNearestCity(45.3511, 18.9946, { filter: croatian });
        expect(filtered.id).toBe('zagreb');
    });
});

describe('resolveCroatianCityId — placing an HR parcel from its coordinates', () => {
    let ensureIds;

    beforeEach(() => {
        ensureIds = vi.fn();
        globalThis.CadastralParcelRepository = { ensureIds };
    });

    afterEach(() => {
        delete globalThis.CadastralParcelRepository;
    });

    function stubParcelAt(lng, lat) {
        ensureIds.mockResolvedValue({
            status: 'ready',
            features: [{ geometry: { coordinates: [[[lng, lat]]] } }]
        });
    }

    it('resolves a Šibenik parcel to sibenik, not zagreb', async () => {
        stubParcelAt(15.889585, 43.735019); // real coords of HR-330264-4975/4
        await expect(route.resolveCroatianCityId('HR-330264-4975/4')).resolves.toBe('sibenik');
    });

    it('resolves a Split parcel to split', async () => {
        stubParcelAt(16.4402, 43.5081);
        await expect(route.resolveCroatianCityId('HR-346381-1')).resolves.toBe('split');
    });

    it('still resolves a Zagreb parcel to zagreb', async () => {
        stubParcelAt(16.053835, 45.800510); // real coords of HR-335550-1 (Žitnjak)
        await expect(route.resolveCroatianCityId('HR-335550-1')).resolves.toBe('zagreb');
    });

    it('asks the one cadastral repository for the exact id', async () => {
        stubParcelAt(15.889585, 43.735019);
        await route.resolveCroatianCityId('HR-330264-4975/4');
        expect(ensureIds).toHaveBeenCalledTimes(1);
        expect(ensureIds).toHaveBeenCalledWith(['HR-330264-4975/4']);
    });

    it('falls back to zagreb when the lookup fails, rather than leaving the user nowhere', async () => {
        ensureIds.mockRejectedValueOnce(new Error('HTTP 502'));
        await expect(route.resolveCroatianCityId('HR-330264-4975/4')).resolves.toBe('zagreb');

        ensureIds.mockRejectedValueOnce(new Error('offline'));
        await expect(route.resolveCroatianCityId('HR-330264-4975/4')).resolves.toBe('zagreb');
    });

    it('falls back when the parcel exists but carries no usable geometry', async () => {
        ensureIds.mockResolvedValue({ status: 'ready', features: [] });
        await expect(route.resolveCroatianCityId('HR-330264-4975/4')).resolves.toBe('zagreb');
    });

    it('bounds the repository wait so a wedged transport cannot stall deep-link boot', async () => {
        globalThis.__CB_CITY_LOOKUP_TIMEOUT_MS__ = 50; // real deadline is 6 s; don't idle for it here
        ensureIds.mockReturnValue(new Promise(() => {}));
        try {
            await expect(route.resolveCroatianCityId('HR-330264-4975/4')).resolves.toBe('zagreb');
            expect(ensureIds).toHaveBeenCalledTimes(1);
        } finally {
            delete globalThis.__CB_CITY_LOOKUP_TIMEOUT_MS__;
        }
    });
});
