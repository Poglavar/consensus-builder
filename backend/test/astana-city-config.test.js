// Keeps the Astana app entry aligned with its sampled Esil-only public parcel source.
import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
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
                metricCrs: 'EPSG:32642',
                metricDefinition: '+proj=utm +zone=42 +datum=WGS84 +units=m +no_defs +type=crs',
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
        const projected = proj4('EPSG:4326', city.projection.metricDefinition, [71.4304, 51.1282]);
        expect(projected[0]).toBeGreaterThan(650000);
        expect(projected[0]).toBeLessThan(690000);
        expect(projected[1]).toBeGreaterThan(5650000);
        expect(projected[1]).toBeLessThan(5680000);
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
