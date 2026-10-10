// Keeps the Astana app entry aligned with its sampled Esil-only public parcel source.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

describe('Astana city config', () => {
    const city = cityContext.CityConfigManager.getCityConfig('astana');

    it('uses the verified metric CRS, local map point and Esil-limited source', () => {
        expect(city).toBeTruthy();
        expect(city).toMatchObject({
            id: 'astana',
            label: 'Astana, Kazakhstan',
            currency: { locale: 'ru-KZ', code: 'KZT' },
            map: {
                defaultCenter: [51.1282, 71.4304],
                defaultZoom: 18,
                initialView: { type: 'center', zoom: 18 }
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                fallbackLatLng: [51.1282, 71.4304],
                fallbackDataset: [71.4304, 51.1282]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'kz-astana-pkk-esil',
                idPrefix: 'KZ-ASTANA-PKK-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 2
            }
        });
        expect(city.projection.metricDefinition).toBeUndefined();
        expect(city.parcels.attribution).toContain('https://map.gov4c.kz/egkn/');
        expect(city.parcels.attribution).toContain('Esil district only');
        expect(city.parcels.attribution).toContain('partial Astana coverage');
        expect(city.parcels.attribution).toContain('ownership and boundary update dates unestablished');
    });

    it('provides the localized city label in every supported locale', () => {
        const labels = {
            en: 'Astana, Kazakhstan',
            es: 'Astaná, Kazajistán',
            hr: 'Astana, Kazahstan',
            sr: 'Astana, Kazahstan'
        };
        for (const [locale, label] of Object.entries(labels)) {
            expect(JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels.astana).toBe(label);
        }
    });
});
