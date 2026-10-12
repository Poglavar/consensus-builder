import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));
const manager = cityContext.CityConfigManager;

describe('new city parcel source configs', () => {
    it('keeps each integration within its verified source and metric footprint', () => {
        const expected = {
            london: ['gb-hmlr-browser-v1', 'GB-HMLR-BROWSER-v1-', 32630, 8],
            manchester: ['gb-hmlr-browser-v1', 'GB-HMLR-BROWSER-v1-', 32630, 8],
            madrid: ['es-dgc-inspire-cp-wfs', 'ES-DGC-', 25830, 25],
            barcelona: ['es-dgc-inspire-cp-wfs', 'ES-DGC-', 25831, 25],
            savar: ['bd-dlrs-dhamsona-bds-sheet-001', 'BD-DLRS-201901-4105-010510026-001-', 32646, 0.35]
        };
        for (const [cityId, [sourceId, idPrefix, metricSrid, radiusKm]] of Object.entries(expected)) {
            const city = manager.getCityConfig(cityId);
            expect(city).toBeTruthy();
            expect(city.parcels).toMatchObject({ sourceId, idPrefix, liveRadiusKm: radiusKm, ownership: false });
            expect(city.projection.metricCrs).toBeUndefined();
            expect(city.parcels.attribution).toContain('href=');
            // OpenStreetMap is the default building source for every city without its own.
            expect(city.buildings.source).toBe('osm');
        }
        expect(manager.getCityConfig('savar').map.defaultZoom).toBe(19);
        for (const city of ['london', 'manchester']) {
            expect(manager.getCityConfig(city).parcels.attribution).toContain('HM Land Registry INSPIRE Index Polygons');
        }
        // IDs issued by the sources these cities used before still load from those sources.
        expect(manager.getCityConfig('london').parcels.historicalSources).toEqual([{ sourceId: 'gb-hmlr-city-of-london', idPrefix: 'GB-HMLR-LONDON-' }]);
        expect(manager.getCityConfig('manchester').parcels.historicalSources).toEqual([{ sourceId: 'gb-hmlr-manchester', idPrefix: 'GB-HMLR-MANCHESTER-' }]);
    });

    it('adds all city label translations in each supported locale', () => {
        const cityIds = ['london', 'manchester', 'madrid', 'barcelona', 'savar'];
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            const translations = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels;
            for (const cityId of cityIds) expect(translations[cityId]).toBeTruthy();
        }
    });
});
