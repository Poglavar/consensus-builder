// The coverage compiler (scripts/build-world-coverage.mjs): registry status -> tier mapping, city
// config parsing, and that the committed frontend/data/world-coverage.json is what it produces now.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCoverage, cityStatusTier, countryProbeTier, countryCoverageTier, regionBucketTier,
    parseCityConfigs, simplifyRing, strongest
} from '../../scripts/build-world-coverage.mjs';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');

describe('tier mapping', () => {
    it('maps city parcel statuses', () => {
        expect(cityStatusTier('verified_sample_city_scope')).toBe('source');
        expect(cityStatusTier('verified_sample_partial_coverage')).toBe('source');
        expect(cityStatusTier('no_verified_open_endpoint_after_attempts')).toBe('none');
        expect(cityStatusTier('temporarily_unavailable')).toBe('unknown');
        expect(cityStatusTier('no_verified_sample_candidate_citywide')).toBe('unknown');
        expect(cityStatusTier(undefined)).toBe('unknown');
    });

    it('maps country probes, using subnational counts for subnational_only', () => {
        expect(countryProbeTier('national_online_cadastre_verified_sample')).toBe('source');
        expect(countryProbeTier('partial_or_unofficial_sample')).toBe('source');
        expect(countryProbeTier('no_online_cadastre_found')).toBe('none');
        expect(countryProbeTier('national_cadastre_credentialed_or_paid')).toBe('none');
        expect(countryProbeTier('national_cadastre_viewer_only')).toBe('none');
        expect(countryProbeTier('temporarily_unavailable')).toBe('unknown');
        expect(countryProbeTier('subnational_only', { regionWide: 3, partial: 0 })).toBe('source');
        expect(countryProbeTier('subnational_only', { regionWide: 0, partial: 0, ruralRegistryOnly: 0 })).toBe('unknown');
        expect(countryProbeTier('subnational_only')).toBe('unknown');
        expect(countryCoverageTier('verified_countrywide')).toBe('source');
        expect(regionBucketTier('partial')).toBe('source');
        expect(regionBucketTier('credentialed')).toBe('none');
        expect(regionBucketTier('unavailable')).toBe('unknown');
    });

    it('keeps the strongest tier', () => {
        expect(strongest('none', 'source', 'unknown')).toBe('source');
        expect(strongest()).toBe('unknown');
    });
});

describe('city config parsing', () => {
    it('reads every configured city with its centre from the source text', () => {
        const cities = parseCityConfigs(read('frontend/js/city-config.js'));
        const zagreb = cities.find(c => c.id === 'zagreb');
        expect(zagreb).toMatchObject({ name: 'Zagreb', lat: 45.804503, lon: 15.978786 });
        expect(cities.find(c => c.id === 'colorado')).toMatchObject({ name: 'Denver' });
        expect(cities.length).toBeGreaterThanOrEqual(8);
    });
});

describe('simplifyRing', () => {
    it('drops collinear points and keeps corners', () => {
        const square = [[0, 0], [0.5, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
        expect(simplifyRing(square, 0.01)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    });
});

describe('buildCoverage', () => {
    const inputs = {
        registry: JSON.parse(read('world-parcels/registry.json')),
        countries: JSON.parse(read('world-parcels/countries.geojson')),
        cityConfigSource: read('frontend/js/city-config.js')
    };
    const built = buildCoverage(inputs);

    it('marks Croatia live and assigns configured cities their country', () => {
        expect(built.countries.find(c => c.cc === 'HR').tier).toBe('live');
        expect(built.liveCities.find(c => c.id === 'belgrade').cc).toBe('RS');
        expect(built.liveCities.find(c => c.id === 'new_york').cc).toBe('US');
    });

    it('carries tiers from the registry', () => {
        expect(built.cities.find(c => c.name === 'Tokyo').tier).toBe('source');
        expect(built.cities.find(c => c.name === 'Jakarta').tier).toBe('none');
        expect(built.countries.find(c => c.cc === 'US').tier).toBe('source');
    });

    it('matches the committed output byte for byte and stays small', () => {
        const committed = read('frontend/data/world-coverage.json');
        expect(committed).toBe(`${JSON.stringify(built)}\n`);
        expect(committed.length).toBeLessThan(400 * 1024);
    });
});
