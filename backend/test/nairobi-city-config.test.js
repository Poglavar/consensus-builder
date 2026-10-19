// Keep Nairobi's map configuration aligned with its geometry-only outline adapter.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

describe('Nairobi city config', () => {
    const city = cityContext.CityConfigManager.getCityConfig('nairobi');

    it('uses the bounded commercial outline source for geometry references only', () => {
        expect(city).toBeTruthy();
        expect(city).toMatchObject({
            id: 'nairobi',
            label: 'Nairobi, Kenya',
            currency: { locale: 'en-KE', code: 'KES' },
            map: {
                initialView: { type: 'center', zoom: 18 },
                defaultCenter: [-1.26592113731299, 36.845161927435],
                defaultZoom: 18
            },
            projection: {
                datasetCrs: 'EPSG:4326',
                fallbackLatLng: [-1.26592113731299, 36.845161927435],
                fallbackDataset: [36.845161927435, -1.26592113731299]
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'ke-nairobi-maps-outlines',
                idPrefix: 'KE-NAIROBI-NM-',
                requiresBackend: true,
                ownership: false,
                liveRadiusKm: 3
            }
        });
        expect(city.parcels.attribution).toContain('https://nairobimaps.com/');
        expect(city.parcels.attribution).toContain('https://nairobimaps.com/gis-data/nairobi-parcels-cadastre.html');
        expect(city.parcels.attribution).toContain('Public commercial outlines are for geometry references only');
        expect(city.parcels.attribution).toContain('source registry numbers and ownership are unavailable');
    });

    it('has a translated label in every supported locale without removing the nearby entries', () => {
        const labels = {
            en: 'Nairobi, Kenya',
            es: 'Nairobi, Kenia',
            hr: 'Nairobi, Kenija',
            sr: 'Nairobi, Kenija'
        };
        for (const [locale, label] of Object.entries(labels)) {
            const messages = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
            expect(messages.city.labels.nairobi).toBe(label);
        }
        for (const cityId of ['mboloko', 'kochi', 'surat']) {
            expect(cityContext.CityConfigManager.getCityConfig(cityId)).toBeTruthy();
        }
    });
});
