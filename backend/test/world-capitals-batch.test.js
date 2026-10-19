// Checks active parcel bindings for selected world-capital city profiles.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const coverage = JSON.parse(read('frontend/data/world-coverage.json'));
const selectedCities = ['cetinje', 'eastjerusalem', 'jerusalem', 'thehague', 'thimphu', 'wellington'];

describe('world-capital city parcel bindings', () => {
    it('matches active city profiles to registered providers and executable adapters', () => {
        const context = { console, URL, URLSearchParams };
        context.window = context;
        runInNewContext(read('frontend/js/city-config.js'), context);
        const sources = new Map(parcelSourceCatalog.sources.map(source => [source.id, source]));
        const liveCities = new Map(coverage.liveCities.map(city => [city.id, city]));

        for (const cityId of selectedCities) {
            const city = context.CityConfigManager.getCityConfig(cityId);
            const live = liveCities.get(cityId);
            expect(city?.parcels?.sourceId, cityId).toBeTruthy();
            expect(live?.sourceId, cityId).toBe(city.parcels.sourceId);
            const source = sources.get(city.parcels.sourceId);
            expect(source?.cityIds, cityId).toContain(cityId);

            const fetchImpl = vi.fn(async () => { throw new Error('unexpected live source request'); });
            const adapter = createParcelSource(source, { fetchImpl });
            expect(adapter).toMatchObject({
                queryBounds: expect.any(Function),
                queryIds: expect.any(Function),
                queryGeometry: expect.any(Function)
            });
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    });
});
