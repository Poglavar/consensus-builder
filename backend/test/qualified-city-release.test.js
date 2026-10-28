// Working city settings must reproduce runtime source bindings without historical task archives.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { cityConfigSource } from './helpers/city-config-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const json = file => JSON.parse(read(file));
const directory = new URL('world-parcels/cities/', root);
const settings = readdirSync(directory).filter(code => /^\d+$/.test(code)
    && existsSync(new URL(`${code}/settings.json`, directory)))
    .map(code => ({ code, ...json(`world-parcels/cities/${code}/settings.json`) }));
const catalog = json('frontend/data/source-catalog.json');
const context = { console, URL, URLSearchParams }; context.window = context;
runInNewContext(cityConfigSource(), context);
const queryFields = ['adapter', 'endpoint', 'idPrefix', 'idField', 'idFields', 'identityKind',
    'lookupCellSize', 'attributeFilters', 'attributeExclusions', 'attributeNotNull', 'attributeNull',
    'featureType', 'boundsQueryMode', 'idsQueryMode', 'boundsSrid', 'boundsProjection', 'queryFormat',
    'nativeGeometryMode', 'disjointParts', 'overlapResolution', 'zoom', 'layer', 'groupFields', 'extent'];

describe('working city settings', () => {
    it('keeps one settings file per WUP city and uniquely binds app entries', () => {
        expect(settings.length).toBeGreaterThan(0);
        const ids = settings.flatMap(row => row.bindings.map(binding => binding.appCityId));
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(settings.map(row => row.cityCode)).size).toBe(settings.length);
    });

    it.each(settings)('WUP $cityCode preserves its executable source configuration', row => {
        expect(row.schemaVersion).toBe(1);
        expect(String(row.cityCode)).toBe(row.code);
        if (!row.bindings.length) {
            expect(row.sources.length).toBeGreaterThan(0);
            for (const source of row.sources) {
                expect(browserParcelFactories[source.adapter], `adapter is not installed: ${source.adapter}`).toBeTypeOf('function');
                expect(source.endpoint).toMatch(/^https?:\/\//);
            }
            return;
        }
        for (const binding of row.bindings) {
            const runtime = context.CityConfigManager.getCityConfig(binding.appCityId);
            expect(runtime.id).toBe(binding.appCityId);
            expect(runtime.parcels).toEqual(binding.runtimeConfig.parcels);
            const ids = [runtime.parcels.sourceId, runtime.parcels.liveSource?.sourceId,
                ...(runtime.parcels.sources || []).map(source => source.sourceId || source.id)].filter(Boolean);
            if (!ids.length && runtime.parcels.source !== 'parcel-source') ids.push(runtime.parcels.source);
            for (const id of ids) {
                const saved = row.sources.find(source => source.id === id);
                expect(saved, `missing source settings: ${id}`).toBeTruthy();
                const live = [...catalog.sources, ...(catalog.databaseSources || [])].find(source => source.id === id);
                expect(live, `missing executable source: ${id}`).toBeTruthy();
                for (const field of queryFields) expect(saved[field] ?? null).toEqual(live[field] ?? null);
                if (saved.cityIds) expect(saved.cityIds).toContain(binding.appCityId);
                if (saved.metricSridByCity) expect(saved.metricSridByCity[binding.appCityId]).toBe(live.metricSridByCity[binding.appCityId]);
            }
        }
    });
});
