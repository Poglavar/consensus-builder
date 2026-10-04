import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import proj4 from 'proj4';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));
const manager = cityContext.CityConfigManager;

describe('new city parcel source configs', () => {
    it('keeps each integration within its verified source and metric footprint', () => {
        const expected = {
            london: ['gb-hmlr-city-of-london', 'GB-HMLR-LONDON-', 32630, 1.5],
            manchester: ['gb-hmlr-manchester', 'GB-HMLR-MANCHESTER-', 32630, 8],
            madrid: ['es-dgc-inspire-cp-wfs', 'ES-DGC-', 25830, 25],
            barcelona: ['es-dgc-inspire-cp-wfs', 'ES-DGC-', 25831, 25],
            savar: ['bd-dlrs-dhamsona-bds-sheet-001', 'BD-DLRS-201901-4105-010510026-001-', 32646, 0.35]
        };
        for (const [cityId, [sourceId, idPrefix, metricSrid, radiusKm]] of Object.entries(expected)) {
            const city = manager.getCityConfig(cityId);
            expect(city).toBeTruthy();
            expect(city.parcels).toMatchObject({ sourceId, idPrefix, liveRadiusKm: radiusKm, ownership: false });
            expect(Number(city.projection.metricCrs.replace('EPSG:', ''))).toBe(metricSrid);
            expect(city.parcels.attribution).toContain('href=');
            expect(city.buildings.source).toBe('none');
        }
        expect(manager.getCityConfig('savar').map.defaultZoom).toBe(19);
        expect(manager.getCityConfig('london').parcels.attribution).toContain('City of London authority only');
        expect(manager.getCityConfig('manchester').parcels.attribution).toContain('Manchester metropolitan borough only');
    });

    it('adds all city label translations in each supported locale', () => {
        const cityIds = ['london', 'manchester', 'madrid', 'barcelona', 'savar'];
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            const translations = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels;
            for (const cityId of cityIds) expect(translations[cityId]).toBeTruthy();
        }
    });
    it('uses explicit ETRS89 ellipsoid parameters for Spanish measurements', () => {
        for (const [cityId, point, expected] of [
            ['madrid', [-3.7038, 40.4168], [440290.4580539469, 4474257.381891725]],
            ['barcelona', [2.168, 41.387], [430438.087481, 4582053.087623]]
        ]) {
            const definition = manager.getCityConfig(cityId).projection.metricDefinition;
            expect(definition).toContain('+ellps=GRS80');
            const measured = proj4('EPSG:4326', definition, point);
            if (cityId === 'madrid') measured.forEach((coordinate, i) => expect(coordinate).toBeCloseTo(expected[i], 4));
            const restored = proj4(definition, 'EPSG:4326', measured);
            restored.forEach((coordinate, i) => expect(coordinate).toBeCloseTo(point[i], 8));
        }
    });
});
