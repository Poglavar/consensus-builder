// Keeps the Surat app entry scoped to the municipal final-plot layer and its metric CRS.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

describe('Surat city config', () => {
    const city = cityContext.CityConfigManager.getCityConfig('surat');

    it('uses the scoped final-plot source, metric projection and local view', () => {
        expect(city).toBeTruthy();
        expect(city).toMatchObject({
            id: 'surat',
            label: 'Surat, India',
            currency: { locale: 'en-IN', code: 'INR' },
            map: {
                defaultCenter: [21.174179236185818, 72.78092615417103],
                defaultZoom: 18,
                initialView: { type: 'center', zoom: 18 }
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                fallbackLatLng: [21.174179236185818, 72.78092615417103],
                fallbackDataset: [72.78092615417103, 21.174179236185818]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.005,
                source: 'parcel-source',
                sourceId: 'in-gj-tpvd-surat-final-plots',
                idPrefix: 'IN-GJ-SURAT-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 3
            }
        });
        expect(city.parcels.attribution).toContain('https://tpvd.openprp.in/ctpvd/index.html');
        expect(city.parcels.attribution).toContain('Surat Municipal Corporation Final plots only');
        expect(city.parcels.attribution).toContain('partial coverage');
        expect(city.parcels.attribution).toContain('not ownership or current-title evidence');
        expect(city.parcels.attribution).toContain('registration/currentness unverified');
    });

    it('provides a city label in each supported locale and keeps nearby entries available', () => {
        const labels = {
            en: 'Surat, India',
            es: 'Surat, India',
            hr: 'Surat, Indija',
            sr: 'Surat, Indija'
        };
        for (const [locale, label] of Object.entries(labels)) {
            expect(JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels.surat).toBe(label);
        }
        for (const cityId of ['ahmedabad', 'kochi', 'iravipuram', 'mboloko']) {
            expect(cityContext.CityConfigManager.getCityConfig(cityId)).toBeTruthy();
        }
    });
});
