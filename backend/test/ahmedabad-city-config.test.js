// Keeps the Ahmedabad app entry tied to its bounded final-scheme source and metric projection.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

describe('Ahmedabad city config', () => {
    const city = cityContext.CityConfigManager.getCityConfig('ahmedabad');

    it('uses the bounded final TPVD planning-plot source and metric projection', () => {
        expect(city).toBeTruthy();
        expect(city).toMatchObject({
            id: 'ahmedabad',
            label: 'Ahmedabad, India',
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                defaultCenter: [23.02004, 72.59975],
                defaultZoom: 18,
                initialView: { type: 'center', zoom: 18 }
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                metricCrs: 'EPSG:32643',
                metricDefinition: '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs +type=crs',
                fallbackLatLng: [23.02004, 72.59975],
                fallbackDataset: [72.59975, 23.02004]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005,
                source: 'parcel-source',
                sourceId: 'in-gj-tpvd-final-plots',
                idPrefix: 'IN-GJ-TPVD-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 3
            }
        });
        expect(city.parcels.attribution).toContain('https://tpvd.openprp.in/ctpvd/index.html');
        expect(city.parcels.attribution).toContain('Ahmedabad Municipal Corporation');
        expect(city.parcels.attribution).toContain('Final town-planning plots only');
        expect(city.parcels.attribution).toContain('partial coverage');
        expect(city.parcels.attribution).toContain('not ownership or current-title evidence');
        expect(city.parcels.attribution).toContain('registration/currentness unverified');
    });

    it('provides the normal city label in every supported locale', () => {
        const labels = {
            en: 'Ahmedabad, India',
            es: 'Ahmedabad, India',
            hr: 'Ahmedabad, Indija',
            sr: 'Ahmedabad, Indija'
        };
        for (const [locale, label] of Object.entries(labels)) {
            expect(JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels.ahmedabad).toBe(label);
        }
    });

    it('keeps the existing nearby city configs available', () => {
        for (const cityId of ['kochi', 'iravipuram', 'mboloko']) {
            expect(cityContext.CityConfigManager.getCityConfig(cityId)).toBeTruthy();
        }
    });
});
