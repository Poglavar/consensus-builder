// Provider/source credits keep links safe and stay scoped to the selected city and basemap.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { providerCredits, parcelCredits, creditParts } = require('../../frontend/js/ui/map-credits.js');

describe('map credits helpers', () => {
    it('returns linked credits for the active OSM or MapTiler basemap', () => {
        expect(providerCredits('openstreetmap')).toEqual([
            ['© OpenStreetMap', 'https://www.openstreetmap.org/copyright']
        ]);
        expect(providerCredits('maptiler')).toEqual([
            ['© MapTiler', 'https://www.maptiler.com/copyright/'],
            ['© OpenStreetMap', 'https://www.openstreetmap.org/copyright']
        ]);
        expect(providerCredits('unknown')).toEqual(providerCredits('openstreetmap'));
    });

    it('deduplicates city and raster credits without carrying credits between cities', () => {
        const oldCityCredit = '<a href="https://old.example/">Old city source</a>';
        const newCityCredit = '<a href="https://new.example/">New city source</a>';
        const rasterCredit = '<a href="https://raster.example/">Raster source</a>';

        expect(parcelCredits({ parcels: { attribution: oldCityCredit } })).toEqual([oldCityCredit]);
        expect(parcelCredits({ parcels: { attribution: newCityCredit,
            raster: { attribution: newCityCredit } } })).toEqual([newCityCredit]);
        expect(parcelCredits({ parcels: { attribution: newCityCredit,
            raster: { attribution: `${newCityCredit} · ${rasterCredit}` } } })).toEqual([
            newCityCredit, `${newCityCredit} · ${rasterCredit}`
        ]);
        expect(parcelCredits({ parcels: { attribution: newCityCredit,
            raster: { attribution: rasterCredit } } })).toEqual([newCityCredit, rasterCredit]);
    });

    it('preserves only safe HTTP(S) anchors as links and strips publisher markup', () => {
        const parts = creditParts('Base <a href="https://publisher.example/terms" onclick="run()">Terms</a>'
            + ' <a href="http://publisher.example/data">Data</a>'
            + '<script>alert(1)</script><img src=x onerror="run()">');

        expect(parts).toEqual([
            { text: 'Base' },
            { text: 'Terms', url: 'https://publisher.example/terms' },
            { text: 'Data', url: 'http://publisher.example/data' }
        ]);
        expect(JSON.stringify(parts)).not.toMatch(/[<>]|script|onclick|onerror|alert/);
    });

    it('keeps unsafe schemes and userinfo URLs inert while retaining their readable labels', () => {
        const parts = creditParts('<a href="javascript:alert(1)">Script link</a> '
            + '<a href="data:text/html,evil">Data link</a> '
            + '<a href="https://user:pass@publisher.example/">Private URL</a>');

        expect(parts).toEqual([
            { text: 'Script link', url: null },
            { text: 'Data link', url: null },
            { text: 'Private URL', url: null }
        ]);
        expect(parts.every(part => !part.url)).toBe(true);
    });
});
