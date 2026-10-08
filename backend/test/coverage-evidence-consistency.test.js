// Cross-check the generated coverage against the evidence that feeds it. These assertions guard
// against registry entries being silently omitted from country/city status when new sources land.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoverage, parseCityConfigs } from '../../scripts/build-world-coverage.mjs';
import { createRequire } from 'node:module';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');

const registry = JSON.parse(read('world-parcels/registry.json'));
const sourceReviews = JSON.parse(read('world-parcels/country-coverage-reviews.json')).reviews;
const countries = JSON.parse(read('world-parcels/countries.geojson'));
const cityConfigSource = read('frontend/js/city-config.js');
const built = buildCoverage({ registry, countryReviews: sourceReviews, countries, cityConfigSource });
const require = createRequire(import.meta.url);
const WorldCoverage = require(path.join(REPO, 'frontend/js/world/world-coverage.js'));
const coverageModel = WorldCoverage.create(built);
const countryByCode = new Map(built.countries.map(country => [country.cc, country]));
const registryCityById = new Map(registry.cities.map(city => [city.cityId, city]));
const verifiedSources = registry.sources.filter(source => source.verificationStatus?.startsWith('verified_'));

describe('coverage evidence consistency across current inputs', () => {
    it('keeps every configured live-city country positively covered', () => {
        const configuredCountries = new Set(parseCityConfigs(cityConfigSource)
            .map(city => built.liveCities.find(configured => configured.id === city.id)?.cc)
            .filter(Boolean));

        for (const cc of configuredCountries) {
            expect(['full', 'partial'], `${cc} has configured live cities`).toContain(countryByCode.get(cc)?.coverage);
        }
    });

    it('keeps every country with a verified registry source positively covered', () => {
        const verifiedCountries = new Set(verifiedSources.map(source => source.countryCode));
        for (const cc of verifiedCountries) {
            expect(['full', 'partial'], `${cc} has a verified registry source`).toContain(countryByCode.get(cc)?.coverage);
        }
    });

    it('does not leave a source-verified city negative when its linked source explicitly verifies its ID', () => {
        for (const source of verifiedSources) {
            for (const cityId of source.verifiedCityIds || []) {
                const city = registryCityById.get(cityId);
                if (!city || !(city.sourceIds || []).includes(source.sourceId)) continue;
                const rendered = built.cities.find(candidate => candidate.id === cityId);
                expect(rendered?.tier, `${city.name} (${cityId}) verified by ${source.sourceId}`).toBe('source');
            }
        }
    });

    it('keeps Athens and both point-lookup cities configured without promising area enumeration', () => {
        expect(built.liveCities.find(city => city.id === 'athens')?.cc).toBe('GR');
        for (const [id, cc] of [['tbilisi', 'GE'], ['istanbul', 'TR']]) {
            const city = built.liveCities.find(city => city.id === id);
            expect(city).toMatchObject({ cc, queryMode: 'point' });
            const searched = coverageModel.searchPlaces(city.name)[0];
            const hit = coverageModel.tierAt(city.lat, city.lon);
            expect(searched).toMatchObject({ cityId: id, tier: 'live', queryMode: 'point' });
            expect(hit).toMatchObject({ cityId: id, tier: 'live', queryMode: 'point' });
            const source = registry.sources.find(source => source.sourceId === city.sourceId);
            expect(source.liveIntegration).toMatchObject({ status: 'enabled', queryMode: 'point', areaEnumeration: false });
        }
    });

    it('keeps reviewed nationwide parcel scope full for New Zealand and Singapore', () => {
        expect(countryByCode.get('NZ')).toMatchObject({ coverage: 'full', tier: 'source' });
        expect(countryByCode.get('SG')).toMatchObject({ coverage: 'full', tier: 'source' });
    });
});
