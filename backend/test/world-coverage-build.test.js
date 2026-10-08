// The coverage compiler (scripts/build-world-coverage.mjs): registry status -> tier mapping, city
// config parsing, and that the committed frontend/data/world-coverage.json is what it produces now.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCoverage, cityStatusTier, countryProbeTier, countryCoverageTier, countryCoverageLevel, regionBucketTier,
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
        countryReviews: JSON.parse(read('world-parcels/country-coverage-reviews.json')).reviews,
        countries: JSON.parse(read('world-parcels/countries.geojson')),
        cityConfigSource: read('frontend/js/city-config.js')
    };
    const built = buildCoverage(inputs);

    it('marks Croatia live and assigns configured cities their country', () => {
        expect(built.countries.find(c => c.cc === 'HR').tier).toBe('live');
        expect(built.liveCities.find(c => c.id === 'belgrade').cc).toBe('RS');
        expect(built.liveCities.find(c => c.id === 'new_york').cc).toBe('US');
        // Source jurisdiction remains authoritative when the coarse country outline omits an SAR.
        expect(built.liveCities.find(c => c.id === 'hong_kong').cc).toBe('HK');
    });

    it('carries tiers from the registry', () => {
        expect(built.cities.find(c => c.name === 'Tokyo').tier).toBe('source');
        expect(built.cities.find(c => c.name === 'Jakarta').tier).toBe('none');
        expect(built.countries.find(c => c.cc === 'US').tier).toBe('source');
    });

    it('keeps coverage separate from operational tier for reviewed countries', () => {
        const byCode = Object.fromEntries(built.countries.map(country => [country.cc, country]));
        expect(byCode.NL).toMatchObject({ coverage: 'full', tier: 'source', coverageSources: [{ title: expect.any(String), url: expect.stringMatching(/^https:\/\//) }] });
        expect(byCode.SI).toMatchObject({ coverage: 'full', tier: 'source' });
        expect(byCode.ES.coverage).toBe('partial');
        expect(byCode.HR).toMatchObject({
            coverage: 'full', tier: 'live',
            coverageSources: expect.arrayContaining([expect.objectContaining({ url: 'https://catalog.uredjenazemlja.hr/katalogpodataka/atom-usluga-preuzimanja-dkp-a' })])
        });
        expect(byCode.RS).toMatchObject({
            coverage: 'partial', tier: 'source',
            coverageSources: expect.arrayContaining([expect.objectContaining({ url: 'https://portal.rgz.gov.rs/' })])
        });
        for (const cc of ['RO', 'MK', 'BA']) {
            expect(byCode[cc]).toMatchObject({ coverage: 'unknown', tier: 'unknown' });
            expect(byCode[cc].note).toBeTruthy();
        }
        for (const cc of ['HR', 'RS', 'RO', 'MK', 'BA']) {
            expect(byCode[cc].coverageSources.length).toBeGreaterThan(0);
            expect(byCode[cc].coverageSources.every(source => /^https:\/\//.test(source.url))).toBe(true);
        }
    });

    it('keeps the archived Belgrade sample as source evidence while the configured city remains canonical', () => {
        expect(built.cities.find(city => city.id === 'wup2025:556')).toMatchObject({
            name: 'Belgrade', cc: 'RS', tier: 'source', note: expect.stringMatching(/nationwide coverage is unconfirmed/i)
        });
        expect(built.liveCities.find(city => city.id === 'belgrade')).toMatchObject({ name: 'Belgrade', cc: 'RS' });
        expect(built.cities.find(city => city.id === 'geonames:3191281')).toMatchObject({
            name: 'Sarajevo', cc: 'BA', lat: 43.8486, lon: 18.3564, tier: 'unknown',
            note: expect.stringMatching(/sign-in.*inconclusive|inconclusive.*sign-in/i)
        });
    });

    describe('synthetic country coverage gates', () => {
        const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
        const makeFeature = cc => ({ type: 'Feature', properties: { ISO_A2: cc, NAME: `Test ${cc}`, LABEL_Y: 0.5, LABEL_X: 0.5 }, geometry: square });
        const registry = ({ sources = [], countryProbes = [], countryCoverage = [], cities = [] } = {}) => ({
            updatedAt: '2026-10-08', sources, countryProbes, countryCoverage, cities, subnationalCoverage: []
        });
        const review = (countryCode, sourceIds, overrides = {}) => ({
            countryCode, coverage: 'full', checkedAt: '2026-10-08', sourceIds, exclusions: [],
            note: 'Reviewed national scope', evidence: [{ title: 'Scope evidence', url: 'https://scope.invalid/source' }],
            ...overrides
        });
        const source = (sourceId, countryCode, verificationStatus = 'verified_nonempty_sample') => ({ sourceId, countryCode, verificationStatus });
        const compile = ({ sourceRows = [], reviews = [], probes = [], coverageRows = [], cities = [], cc = 'AA', cityConfigSource = 'const CITY_CONFIGS = {};' } = {}) => {
            const countries = { type: 'FeatureCollection', features: [makeFeature(cc), ...(cc === 'AA' ? [makeFeature('BB')] : [])] };
            return buildCoverage({ registry: registry({ sources: sourceRows, countryProbes: probes, countryCoverage: coverageRows, cities }),
                countryReviews: reviews, countries, cityConfigSource });
        };
        const find = (result, cc) => result.countries.find(country => country.cc === cc);

        it('promotes only a dated, evidenced, exclusion-free review with a matching local verified source', () => {
            const goodSource = source('aa-parcels', 'AA');
            const valid = find(compile({ sourceRows: [goodSource], reviews: [review('AA', ['aa-parcels'])] }), 'AA');
            expect(valid).toMatchObject({ coverage: 'full', tier: 'source', note: 'Reviewed national scope', coverageSources: [{ title: 'Scope evidence', url: 'https://scope.invalid/source' }] });

            const invalidReviews = [
                review('AA', ['aa-parcels'], { exclusions: ['One region'] }),
                review('AA', ['aa-parcels'], { exclusions: undefined }),
                review('AA', ['aa-parcels'], { evidence: [] }),
                review('AA', ['aa-parcels'], { evidence: [{ title: '', url: 'https://scope.invalid/source' }] }),
                review('AA', ['aa-parcels'], { evidence: [{ title: 'Scope evidence', url: 'http://scope.invalid/source' }] }),
                review('AA', ['aa-parcels'], { checkedAt: 'yesterday' }),
                review('AA', ['aa-parcels'], { sourceIds: ['not-the-verified-source'] })
            ];
            for (const invalid of invalidReviews) {
                const country = find(compile({ sourceRows: [goodSource], reviews: [invalid] }), 'AA');
                expect(country.coverage).toBe('partial'); // locally verified data remains partial evidence
            }
            const unverified = find(compile({ sourceRows: [source('aa-parcels', 'AA', 'candidate_not_verified')], reviews: [review('AA', ['aa-parcels'])] }), 'AA');
            expect(unverified.coverage).toBe('unknown');
        });

        it('does not let a verified source from another country satisfy a full-review claim', () => {
            const result = compile({ sourceRows: [source('bb-parcels', 'BB')], reviews: [review('AA', ['bb-parcels'])] });
            expect(find(result, 'AA').coverage).toBe('unknown');
            expect(find(result, 'BB').coverage).toBe('partial');
        });

        it('keeps legacy two-region countrywide samples partial', () => {
            const result = compile({ coverageRows: [{ countryCode: 'AA', status: 'verified_countrywide', basis: 'two_region_test', reviewed: false }] });
            expect(find(result, 'AA').coverage).toBe('partial');
        });

        it('uses country probes and verified local evidence without treating one configured city as national evidence', () => {
            for (const status of ['temporarily_unavailable', 'not_probed']) {
                expect(countryCoverageLevel({ probe: { status } })).toBe('unknown');
                expect(find(compile({ probes: [{ countryCode: 'AA', status }] }), 'AA').coverage).toBe('unknown');
            }
            expect(find(compile({ probes: [{ countryCode: 'AA', status: 'no_online_cadastre_found' }] }), 'AA').coverage).toBe('none');
            expect(find(compile({ probes: [{ countryCode: 'AA', status: 'national_online_cadastre_verified_sample' }] }), 'AA').coverage).toBe('partial');
            expect(find(compile({ probes: [{ countryCode: 'AA', status: 'no_online_cadastre_found' }], sourceRows: [source('aa-parcels', 'AA')] }), 'AA').coverage).toBe('partial');
            expect(find(compile({ probes: [{ countryCode: 'AA', status: 'no_online_cadastre_found' }], cities: [{ countryCode: 'AA', parcelStatus: 'verified_sample_city_scope' }] }), 'AA').coverage).toBe('partial');
            expect(find(compile({ cities: [{ countryCode: 'AA', parcelStatus: 'no_verified_open_endpoint_after_attempts' }] }), 'AA').coverage).toBe('unknown');
            const configured = "const CITY_CONFIGS = { sample_city: { id: 'sample_city', label: 'Sample City', map: { defaultCenter: [0.5, 0.5] } } };";
            const result = compile({ cityConfigSource: configured });
            expect(result.liveCities).toHaveLength(1);
            expect(find(result, 'AA').coverage).toBe('unknown');
        });

        it('preserves a city-specific research note instead of replacing it with the generic status note', () => {
            const note = 'Sarajevo parcel access remains inconclusive: the advertised FGU service requires sign-in and the separate public canton viewer is unreachable. No existing Sarajevo import was found in the databases checked.';
            const result = compile({ cities: [{
                cityId: 'geonames:3191281', name: 'Sarajevo', country: 'Bosnia and Herz.', countryCode: 'BA',
                centerLatLon: [43.84864, 18.35644], parcelStatus: 'temporarily_unavailable', sourceIds: [],
                researchFile: 'research/cities/sarajevo.json', note
            }] });
            expect(result.cities).toContainEqual({
                id: 'geonames:3191281', name: 'Sarajevo', cc: 'BA', lat: 43.8486, lon: 18.3564,
                tier: 'unknown', note
            });
        });
    });

    it('matches the committed output byte for byte and stays small', () => {
        const committed = read('frontend/data/world-coverage.json');
        expect(committed).toBe(`${JSON.stringify(built)}\n`);
        expect(committed.length).toBeLessThan(400 * 1024);
    });
});
