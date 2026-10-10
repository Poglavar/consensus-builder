import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));
const parcelSources = JSON.parse(read('../parcels/source-catalog.json')).sources;

const citySamples = [
    {
        id: 'kochi',
        center: [9.963406805925196, 76.36082896288808],
        locationCode: '070211',
        village: 'Thiruvankulam'
    },
    {
        id: 'iravipuram',
        center: [8.847550832774829, 76.62751009273858],
        locationCode: '020301',
        village: 'Iravipuram'
    },
];

describe('Kerala village city configs', () => {
    const cities = citySamples.map(sample => ({
        sample,
        city: cityContext.CityConfigManager.getCityConfig(sample.id)
    }));

    it('uses the verified village sample centers and EPSG:32643 projections', () => {
        for (const { sample, city } of cities) {
            expect(city).toBeTruthy();
            expect(city.map.defaultCenter).toEqual(sample.center);
            expect(city.map.defaultZoom).toBe(19);
            expect(city.projection).toMatchObject({
                datasetCrs: 'EPSG:4326',
                fallbackLatLng: sample.center,
                fallbackDataset: [sample.center[1], sample.center[0]]
            });
            expect(city.projection.metricDefinition).toBeUndefined();
            expect(city.parcels).toMatchObject({
                strategy: 'grid',
                gridSize: 0.001,
                sourceId: `in-kl-entebhoomi-${sample.locationCode}`,
                idPrefix: `IN-KL-ENTEBHOOMI-${sample.locationCode}-`,
                liveRadiusKm: 1.5,
                ownership: false
            });
        }
    });

    it('keeps each village source and identifier prefix isolated', () => {
        const sourceIds = cities.map(({ city }) => city.parcels.sourceId);
        const prefixes = cities.map(({ city }) => city.parcels.idPrefix);
        expect(new Set(sourceIds).size).toBe(citySamples.length);
        expect(new Set(prefixes).size).toBe(citySamples.length);
        for (const { sample, city } of cities) {
            expect(city.id).toBe(sample.id);
            const catalogSource = parcelSources.find(source => source.id === city.parcels.sourceId);
            expect(catalogSource).toBeTruthy();
            expect(catalogSource.cityIds).toContain(city.id);
            expect(city.parcels.attribution).toContain(`${sample.village} village coverage only`);
            expect(city.parcels.attribution).toContain('adapted');
            expect(city.parcels.attribution).toContain('https://entebhoomi.kerala.gov.in/web/ilms/map');
        }
    });

    it('provides a translated city label in every supported locale', () => {
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            const labels = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels;
            for (const { sample } of cities) expect(labels[sample.id]).toBeTruthy();
        }
    });

    it('keeps unsettled Kozhikode and Thiruvananthapuram entries out of the app config', () => {
        for (const heldCityId of ['kozhikode', 'thiruvananthapuram']) {
            expect(cityContext.CityConfigManager.getCityConfig(heldCityId)).toBeNull();
        }
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            const labels = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels;
            for (const heldCityId of ['kozhikode', 'thiruvananthapuram']) {
                expect(labels).not.toHaveProperty(heldCityId);
            }
        }
    });
});
