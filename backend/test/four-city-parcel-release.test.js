import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parcelSourceForCity } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const revive = (_key, value) => value?.$number === 'Infinity' ? Infinity : value;
const json = file => JSON.parse(read(file), revive);
const catalog = json('backend/parcels/source-catalog.json');
const registry = json('world-parcels/registry.json');
const report = json('frontend/data/parcel-coverage-report.json');
const coverage = json('frontend/data/world-coverage.json');
const context = { console, URL, URLSearchParams }; context.window = context;
runInNewContext(read('frontend/js/city-config.js'), context);
const cities = [['3008', 'sisulu_village'], ['5590', 'jakarta'], ['7935', 'rio_de_janeiro'], ['9913', 'hyderabad']];
const queryFields = ['adapter', 'endpoint', 'layerId', 'idField', 'objectIdField', 'idPrefix',
    'identityKind', 'outFields', 'queryFormat', 'boundsQueryMode', 'idsQueryMode', 'timeoutMs',
    'attributeNotNull', 'attributeExclusions'];

describe('four accepted city parcel sources', () => {
    it.each(cities)('WUP %s executes its saved source configuration as %s', (code, appId) => {
        const settings = json(`world-parcels/cities/${code}/settings.json`);
        expect(settings.cityCode).toBe(code);
        const binding = settings.bindings.find(row => row.appCityId === appId);
        const config = context.CityConfigManager.getCityConfig(appId);
        expect(config.id).toBe(appId);
        expect(config.parcels).toEqual(binding.runtimeConfig.parcels);
        expect(config.map.defaultCenter).toEqual(binding.runtimeConfig.map.defaultCenter);
        const sourceId = config.parcels.sourceId;
        const saved = settings.sources.find(row => row.id === sourceId);
        const descriptor = catalog.sources.find(row => row.id === sourceId);
        for (const field of queryFields) expect(descriptor[field] ?? null).toEqual(saved[field] ?? null);
        expect(descriptor.cityIds).toContain(appId);
        expect(browserParcelFactories[descriptor.adapter]).toBeTypeOf('function');
        expect(parcelSourceForCity(appId).descriptor.id).toBe(sourceId);
        const city = registry.cities.find(row => String(row.wupCityCode) === code);
        expect(city.appCityId).toBe(appId);
        expect(city.sourceIds).toContain(sourceId);
        expect(settings.bindings.map(row => row.appCityId)).toContain(city.appCityId);
        expect(coverage.liveCities.find(row => row.id === appId).sourceId).toBe(sourceId);
        const reportCity = report.cities.find(row => String(row.wupCityCode) === code);
        expect(reportCity.appCityIds).toContain(appId);
        expect(reportCity.sourceIds).toContain(sourceId);
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            expect(json(`frontend/i18n/${locale}.json`).city.labels[appId]).toBeTypeOf('string');
        }
    });
});
