// The coverage compiler (scripts/build-world-coverage.mjs): registry status -> tier mapping, city
// config parsing, region (state/province/UK nation) coverage gates, and that the committed
// frontend/data/world-coverage.json is what it produces now.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCoverage, buildRegions, cityStatusTier, countryProbeTier, countryCoverageTier, countryCoverageLevel, regionBucketTier,
    regionCoverageLevel, regionIdFor, parseCityConfigs, simplifyRing, strongest, UNPAINTED_SUBNATIONAL
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
        expect(regionBucketTier('regionWide')).toBe('source');
        expect(regionBucketTier('credentialed')).toBe('none');
        expect(regionBucketTier('viewerOnly')).toBe('none');
        expect(regionBucketTier('unavailable')).toBe('unknown');
        // Self-declared rural registries are not cadastral parcels.
        expect(regionBucketTier('ruralRegistryOnly')).toBe('unknown');
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

    it('parses only positive safe integer WUP city codes and preserves invalid explicit fields', () => {
        const cities = parseCityConfigs(`const CITY_CONFIGS = {
            valid: { id: 'valid', label: 'Valid', wupCityCode: 4536, map: { defaultCenter: [1, 2] } },
            maximum: { id: 'maximum', label: 'Maximum', wupCityCode: 9007199254740991, map: { defaultCenter: [1, 2] } },
            zero: { id: 'zero', label: 'Zero', wupCityCode: 0, map: { defaultCenter: [1, 2] } },
            fraction: { id: 'fraction', label: 'Fraction', wupCityCode: 4.5, map: { defaultCenter: [1, 2] } },
            expression: { id: 'expression', label: 'Expression', wupCityCode: 4536 + 0, map: { defaultCenter: [1, 2] } },
            unsafe: { id: 'unsafe', label: 'Unsafe', wupCityCode: 9007199254740992, map: { defaultCenter: [1, 2] } },
            numericString: { id: 'numericString', label: 'Numeric string', wupCityCode: '4536', map: { defaultCenter: [1, 2] } },
            malformedString: { id: 'malformedString', label: 'Malformed string', wupCityCode: '4536x', map: { defaultCenter: [1, 2] } },
            absent: { id: 'absent', label: 'Absent', map: { defaultCenter: [1, 2] } }
        };`);
        const byId = Object.fromEntries(cities.map(city => [city.id, city]));

        expect(byId.valid.wupCityCode).toBe(4536);
        expect(byId.maximum.wupCityCode).toBe(Number.MAX_SAFE_INTEGER);
        expect(byId.numericString.wupCityCode).toBe(4536);
        for (const id of ['zero', 'fraction', 'expression', 'unsafe', 'malformedString']) expect(byId[id].wupCityCode).toBeNull();
        expect(Object.hasOwn(byId.absent, 'wupCityCode')).toBe(false);
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
        regions: JSON.parse(read('world-parcels/regions.geojson')),
        regionReviews: JSON.parse(read('world-parcels/region-coverage-reviews.json')).reviews,
        catalog: JSON.parse(read('backend/parcels/source-catalog.json')).sources,
        cityConfigSource: read('frontend/js/city-config.js'),
        demographics: JSON.parse(read('world-parcels/report/city-demographics.json'))
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
        for (const cc of ['RO', 'BA']) {
            expect(byCode[cc]).toMatchObject({ coverage: 'unknown', tier: 'unknown' });
            expect(byCode[cc].note).toBeTruthy();
        }
        // Skopje now has a verified Old Bazaar parcel sample; source geometry defects keep it
        // outside the runtime catalog, while the bounded sample establishes partial coverage.
        expect(byCode.MK).toMatchObject({ coverage: 'partial', tier: 'source' });
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
        const compile = ({ sourceRows = [], reviews = [], probes = [], coverageRows = [], cities = [], cc = 'AA', cityConfigSource = 'const CITY_CONFIGS = {};', demographics = null } = {}) => {
            const countries = { type: 'FeatureCollection', features: [makeFeature(cc), ...(cc === 'AA' ? [makeFeature('BB')] : [])] };
            return buildCoverage({ registry: registry({ sources: sourceRows, countryProbes: probes, countryCoverage: coverageRows, cities }),
                countryReviews: reviews, countries, cityConfigSource, demographics });
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

        it('keeps a shared publisher separate from each explicitly associated city jurisdiction', () => {
            const provider = { ...source('shared', 'AA'), liveIntegration: { status: 'enabled', cityIds: ['first', 'second'] } };
            const config = `const CITY_CONFIGS = {
                first: { id: 'first', label: 'First', map: { defaultCenter: [0.5, 0.5] }, parcels: { sourceId: 'shared' } },
                second: { id: 'second', label: 'Second', map: { defaultCenter: [0.5, 0.5] }, parcels: { sourceId: 'shared' } }
            };`;
            const cities = [
                { cityId: 'registry:first', appCityId: 'first', sourceIds: ['shared'], countryCode: 'BB', centerLatLon: [0.5, 0.5] },
                { cityId: 'registry:second', appCityId: 'second', sourceIds: ['unrelated'], countryCode: 'BB', centerLatLon: [0.5, 0.5] }
            ];
            const result = compile({ sourceRows: [provider], cities, cityConfigSource: config });
            expect(result.liveCities.find(city => city.id === 'first').cc).toBe('BB');
            expect(result.liveCities.find(city => city.id === 'second').cc).toBe('AA');
            provider.liveIntegration.status = 'held';
            expect(compile({ sourceRows: [provider], cities, cityConfigSource: config }).liveCities.find(city => city.id === 'first').cc).toBe('AA');
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
            expect(result.cities.find(city => city.id === 'geonames:3191281')).toMatchObject({
                id: 'geonames:3191281', name: 'Sarajevo', cc: 'BA', lat: 43.8486, lon: 18.3564,
                tier: 'unknown', note
            });
        });

        it('joins population by exact IDs, rejects ambiguity and country mismatches, and leaves missing values null', () => {
            const config = `const CITY_CONFIGS = {
                alpha: { id: 'alpha', label: 'Same name', map: { defaultCenter: [0.5, 0.5] } },
                wrong_country: { id: 'wrong_country', label: 'Wrong country', map: { defaultCenter: [0.5, 0.5] } },
                duplicate: { id: 'duplicate', label: 'Duplicate', map: { defaultCenter: [0.5, 0.5] } },
                unmatched: { id: 'unmatched', label: 'Same name', map: { defaultCenter: [0.5, 0.5] } }
            };`;
            const demographics = {
                sources: [{ name: 'UN DESA WUP 2025 city populations', url: 'https://population.un.org/wup/downloads?tab=Cities', retrieved: '2026-10-07' }],
                cities: [
                    { id: 'wup2025:789', appCityIds: ['alpha'], countryCode: 'AA', population2025: 1234 },
                    { id: 'wup2025:790', appCityIds: ['wrong_country'], countryCode: 'BB', population2025: 2345 },
                    { id: 'wup2025:791', appCityIds: ['duplicate'], countryCode: 'AA', population2025: 3456 },
                    { id: 'wup2025:792', appCityIds: ['duplicate'], countryCode: 'AA', population2025: 4567 },
                    { id: 'wup2025:793', appCityIds: ['some_other_id'], countryCode: 'AA', name: 'Same name', population2025: 5678 },
                    { id: 'wup2025:794', appCityIds: [], countryCode: 'BB', population2025: 7890 }
                ]
            };
            const registryCities = [
                { cityId: 'wup2025:789', countryCode: 'AA', centerLatLon: [0.5, 0.5] },
                { cityId: 'wup2025:794', countryCode: 'AA', centerLatLon: [0.5, 0.5] }
            ];
            const result = compile({ cities: registryCities, cityConfigSource: config, demographics });
            const liveById = Object.fromEntries(result.liveCities.map(city => [city.id, city]));
            const researchById = Object.fromEntries(result.cities.map(city => [city.id, city]));

            expect(liveById.alpha.population2025).toBe(1234);
            expect(liveById.wrong_country.population2025).toBeNull();
            expect(liveById.duplicate.population2025).toBeNull();
            expect(liveById.unmatched.population2025).toBeNull();
            expect(researchById['wup2025:789'].population2025).toBe(1234);
            expect(researchById['wup2025:794'].population2025).toBeNull();
            expect(result.populationSource).toMatchObject({
                title: 'UN DESA WUP 2025 city populations', year: 2025, retrieved: '2026-10-07'
            });
        });

        it('joins shared-provider cities by explicit WUP code and never falls back from a broken code to app-city slugs', () => {
            const cityIds = ['newcastle', 'oxford', 'wrong_country', 'ambiguous', 'missing_population', 'invalid_code', 'legacy'];
            const config = `const CITY_CONFIGS = {
                newcastle: { id: 'newcastle', label: 'Newcastle upon Tyne', wupCityCode: 4536, parcels: { sourceId: 'shared' }, map: { defaultCenter: [54.9873, -1.5538] } },
                oxford: { id: 'oxford', label: 'Oxford', wupCityCode: 5278, parcels: { sourceId: 'shared' }, map: { defaultCenter: [51.752, -1.2577] } },
                wrong_country: { id: 'wrong_country', label: 'Wrong Country', wupCityCode: 111, parcels: { sourceId: 'shared' }, map: { defaultCenter: [52, -1] } },
                ambiguous: { id: 'ambiguous', label: 'Ambiguous', wupCityCode: 222, parcels: { sourceId: 'shared' }, map: { defaultCenter: [52, -1] } },
                missing_population: { id: 'missing_population', label: 'Missing Population', wupCityCode: 333, parcels: { sourceId: 'shared' }, map: { defaultCenter: [52, -1] } },
                invalid_code: { id: 'invalid_code', label: 'Invalid Code', wupCityCode: 0, parcels: { sourceId: 'shared' }, map: { defaultCenter: [52, -1] } },
                legacy: { id: 'legacy', label: 'Legacy', parcels: { sourceId: 'shared' }, map: { defaultCenter: [52, -1] } }
            };`;
            const provider = {
                ...source('shared', 'GB'),
                liveIntegration: { status: 'enabled', cityIds }
            };
            const demographics = { cities: [
                { wupCityCode: 4536, countryCode: 'GB', population2025: 760_969 },
                { wupCityCode: 5278, countryCode: 'GB', population2025: 172_436 },
                { wupCityCode: 111, countryCode: 'AA', population2025: 99_000 },
                { wupCityCode: 222, countryCode: 'GB', population2025: 20_000 },
                { wupCityCode: 222, countryCode: 'GB', population2025: 21_000 },
                { wupCityCode: 333, countryCode: 'GB', population2025: null },
                { wupCityCode: 444, countryCode: 'GB', appCityIds: ['wrong_country'], population2025: 88_000 },
                { wupCityCode: 445, countryCode: 'GB', appCityIds: ['ambiguous'], population2025: 77_000 },
                { wupCityCode: 446, countryCode: 'GB', appCityIds: ['missing_population'], population2025: 66_000 },
                { wupCityCode: 447, countryCode: 'GB', appCityIds: ['invalid_code'], population2025: 55_000 },
                { id: 'legacy-wup-row', appCityIds: ['legacy'], countryCode: 'GB', population2025: 44_000 }
            ] };
            const result = compile({ cc: 'GB', sourceRows: [provider], cityConfigSource: config, demographics });
            const liveById = Object.fromEntries(result.liveCities.map(city => [city.id, city]));

            expect(find(result, 'GB').coverage).toBe('partial');
            expect(liveById.newcastle).toMatchObject({ cc: 'GB', population2025: 760_969 });
            expect(liveById.oxford).toMatchObject({ cc: 'GB', population2025: 172_436 });
            for (const id of ['wrong_country', 'ambiguous', 'missing_population', 'invalid_code']) {
                expect(liveById[id].population2025).toBeNull();
            }
            expect(liveById.legacy.population2025).toBe(44_000);
        });
    });

    describe('regions in the current data', () => {
        const regions = Object.fromEntries(built.regions.map(region => [region.id, region]));
        const countries = Object.fromEntries(built.countries.map(country => [country.cc, country]));
        const reviews = JSON.parse(read('world-parcels/region-coverage-reviews.json')).reviews;

        it('paints England and Wales full from the HMLR review while the United Kingdom stays partial', () => {
            for (const id of ['GB-ENG', 'GB-WLS']) {
                expect(regions[id]).toMatchObject({
                    cc: 'GB', coverage: 'full', tier: 'source', note: expect.stringMatching(/registered freehold/),
                    coverageSources: expect.arrayContaining([{ title: expect.any(String), url: 'https://www.gov.uk/guidance/inspire-index-polygons-spatial-data' }])
                });
                expect(regions[id].rings.length).toBeGreaterThan(0);
            }
            expect(regions['GB-SCT']).toMatchObject({ coverage: 'partial', note: expect.stringMatching(/Edinburgh and Glasgow/) });
            expect(regions['GB-NIR']).toMatchObject({ coverage: 'unknown', tier: 'unknown' });
            expect(countries.GB.coverage).toBe('partial');
        });

        it('keeps the United States partial while reviewed states are full and gapped states stay partial', () => {
            expect(countries.US.coverage).toBe('partial');
            for (const id of ['US-MD', 'US-NC', 'US-ND', 'US-NJ', 'US-UT', 'US-WI']) expect(regions[id].coverage, id).toBe('full');
            // Asotin County is missing from the Washington compilation; Esmeralda has no digital parcels.
            expect(regions['US-WA']).toMatchObject({ coverage: 'partial', note: expect.stringMatching(/Asotin absent/) });
            expect(regions['US-NV'].coverage).toBe('partial');
            expect(built.regions.filter(region => region.cc === 'US')).toHaveLength(51);
        });

        it('grants full exactly to the reviewed regions, so a review that stops passing its gates is caught', () => {
            const fullReviews = reviews.filter(review => review.coverage === 'full').map(review => review.regionCode).sort();
            expect(built.regions.filter(region => region.coverage === 'full').map(region => region.id).sort()).toEqual(fullReviews);
            for (const review of reviews) {
                expect(review.evidenceFiles.every(file => existsSync(path.join(REPO, file))), `${review.regionCode} evidence files`).toBe(true);
            }
        });

        it('emits each region scheme in full and leaves district-level Rwanda as a country', () => {
            const perCountry = built.regions.reduce((m, region) => ({ ...m, [region.cc]: (m[region.cc] || 0) + 1 }), {});
            expect(perCountry).toMatchObject({ US: 51, CA: 13, AU: 8, DE: 16, CH: 26, BE: 3, GB: 4, MX: 32, MY: 16, BR: 27, AR: 24 });
            expect(perCountry.RW).toBeUndefined();
            expect(Object.keys(UNPAINTED_SUBNATIONAL)).toEqual(['RW']);
            // Malaysia's registry letter codes join the numeric ISO 3166-2 outlines.
            expect(regionIdFor('MY', 'SGR')).toBe('MY-10');
            expect(regions['MY-10']).toMatchObject({ name: 'Selangor', coverage: 'partial' });
            expect(regions['BE-VLG']).toMatchObject({ coverage: 'partial', note: expect.stringMatching(/Flanders/) });
        });

        it('keeps every region record compact and deterministic', () => {
            const ids = built.regions.map(region => region.id);
            expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
            for (const region of built.regions) {
                expect(Object.keys(region).filter(key => key !== 'coverageSources'))
                    .toEqual(['id', 'cc', 'name', 'tier', 'coverage', 'note', 'center', 'rings']);
                expect(region.id.startsWith(`${region.cc}-`)).toBe(true);
                expect(region.note).toBeTruthy();
            }
        });
    });

    describe('synthetic region coverage gates', () => {
        const box = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
        const outline = (id, geometry, extra = {}) => ({ type: 'Feature', properties: { id, cc: id.slice(0, 2), name: `Region ${id}`, labelLat: 0.5, labelLon: 0.5, ...extra }, geometry });
        const outlines = (...features) => ({ type: 'FeatureCollection', features });
        const twoRegions = outlines(outline('AA-ONE', box(0, 0, 1, 1)), outline('AA-TWO', box(1, 0, 2, 1)));
        const registry = ({ sources = [], cities = [], subnationalCoverage = [] } = {}) => ({ updatedAt: '2026-10-12', sources, cities, subnationalCoverage, countryProbes: [], countryCoverage: [] });
        const verified = sourceId => ({ sourceId, countryCode: 'AA', verificationStatus: 'verified_nonempty_sample' });
        const review = (regionCode, sourceIds, overrides = {}) => ({
            regionCode, coverage: 'full', checkedAt: '2026-10-12', sourceIds, exclusions: [], note: 'Reviewed regional scope',
            evidence: [{ title: 'Regional scope evidence', url: 'https://scope.invalid/region' }], ...overrides
        });
        const sub = rows => [{ countryCode: 'AA', regions: rows.map(([code, bucket]) => ({ code, name: code, bucket, sourceName: `Source ${code}` })) }];
        const regionsOf = args => Object.fromEntries(buildRegions({ outlines: twoRegions, tolerance: 0.01, ...args }).map(region => [region.id, region]));

        it('paints a reviewed region full over a country that stays partial', () => {
            const country = { type: 'Feature', properties: { ISO_A2: 'AA', NAME: 'Test AA', LABEL_Y: 0.5, LABEL_X: 1 }, geometry: box(0, 0, 2, 1) };
            const result = buildCoverage({
                registry: registry({ sources: [verified('aa-one-parcels')], subnationalCoverage: sub([['ONE', 'regionWide'], ['TWO', 'none']]) }),
                countries: { type: 'FeatureCollection', features: [country] }, cityConfigSource: 'const CITY_CONFIGS = {};',
                regions: twoRegions, regionReviews: [review('AA-ONE', ['aa-one-parcels'])]
            });
            expect(result.countries.find(entry => entry.cc === 'AA').coverage).toBe('partial');
            expect(result.regions).toMatchObject([
                { id: 'AA-ONE', coverage: 'full', tier: 'source', note: 'Reviewed regional scope', coverageSources: [{ title: 'Regional scope evidence', url: 'https://scope.invalid/region' }] },
                { id: 'AA-TWO', coverage: 'none', tier: 'none', note: 'No open regional parcel source found' }
            ]);
        });

        it('never makes a region full without a review that passes every gate', () => {
            const sources = [verified('aa-one-parcels')];
            const subnationalCoverage = sub([['ONE', 'regionWide']]);
            const provider = { id: 'aa-statewide', discovery: { jurisdiction: { countryCode: 'AA', admin1: ['AA-ONE'], basis: 'Statewide layer, every county present.' } } };
            expect(regionsOf({ registry: registry({ sources, subnationalCoverage }), catalog: [provider] })['AA-ONE'].coverage).toBe('partial');
            for (const invalid of [
                review('AA-ONE', ['aa-one-parcels'], { exclusions: ['One county'] }),
                review('AA-ONE', ['aa-one-parcels'], { exclusions: undefined }),
                review('AA-ONE', ['aa-one-parcels'], { evidence: [] }),
                review('AA-ONE', ['aa-one-parcels'], { evidence: [{ title: 'Regional scope evidence', url: 'http://scope.invalid/region' }] }),
                review('AA-ONE', ['aa-one-parcels'], { checkedAt: 'last week' }),
                review('AA-ONE', ['not-a-verified-source'])
            ]) {
                const region = regionsOf({ registry: registry({ sources, subnationalCoverage }), reviews: [invalid] })['AA-ONE'];
                expect(region.coverage).toBe('partial');
                expect(region.coverageSources).toBeUndefined();
            }
            // A partial review only explains a partial region, like a country review does.
            const explained = regionsOf({ registry: registry({ sources, subnationalCoverage }), reviews: [review('AA-ONE', [], { coverage: 'partial', note: 'Two counties missing' })] })['AA-ONE'];
            expect(explained).toMatchObject({ coverage: 'partial', note: 'Two counties missing' });
            // A provider named for the region can back its review; a provider for the neighbour cannot.
            const neighbour = { id: 'aa-two-statewide', discovery: { jurisdiction: { admin1: ['AA-TWO'], basis: 'Neighbour layer.' } } };
            expect(regionsOf({ registry: registry(), catalog: [provider], reviews: [review('AA-ONE', ['aa-statewide'])] })['AA-ONE'].coverage).toBe('full');
            expect(regionsOf({ registry: registry(), catalog: [neighbour], reviews: [review('AA-ONE', ['aa-two-statewide'])] })['AA-ONE'].coverage).toBe('unknown');
        });

        it('derives partial from buckets, executable providers and verified cities inside the outline only', () => {
            expect(regionCoverageLevel({ buckets: ['credentialed', 'partial'] })).toBe('partial');
            expect(regionCoverageLevel({ buckets: ['ruralRegistryOnly'] })).toBe('unknown');
            expect(regionCoverageLevel({ buckets: ['viewerOnly'] })).toBe('none');
            expect(regionCoverageLevel({})).toBe('unknown');

            const provider = { id: 'aa-one-layer', discovery: { jurisdiction: { admin1: ['AA-ONE'], basis: 'Region-wide layer for One.' } } };
            const byProvider = regionsOf({ registry: registry(), catalog: [provider] });
            expect(byProvider['AA-ONE']).toMatchObject({ coverage: 'partial', note: 'Region-wide layer for One.' });
            expect(byProvider['AA-TWO']).toMatchObject({ coverage: 'unknown', note: 'No open parcel source verified in this region yet' });

            const cities = [
                { cityId: 'c1', name: 'Inside', countryCode: 'AA', centerLatLon: [0.5, 1.5], parcelStatus: 'verified_sample_city_scope' },
                { cityId: 'c2', name: 'Foreign', countryCode: 'BB', centerLatLon: [0.5, 0.5], parcelStatus: 'verified_sample_city_scope' },
                { cityId: 'c3', name: 'Unverified', countryCode: 'AA', centerLatLon: [0.5, 0.5], parcelStatus: 'no_verified_open_endpoint_after_attempts' }
            ];
            const byCity = regionsOf({ registry: registry({ cities }) });
            expect(byCity['AA-TWO']).toMatchObject({ coverage: 'partial', note: expect.stringMatching(/verified in Inside/) });
            expect(byCity['AA-ONE'].coverage).toBe('unknown');
        });

        it('joins providers that name the admin-1 members of a map-unit region', () => {
            const mapUnit = outlines(outline('AA-NAT', box(0, 0, 1, 1), { members: ['AA-P1', 'AA-P2'] }));
            const provider = { id: 'aa-p1-layer', discovery: { jurisdiction: { admin1: ['AA-P1'], basis: 'Province one layer.' } } };
            const [region] = buildRegions({ outlines: mapUnit, registry: registry(), catalog: [provider], tolerance: 0.01 });
            expect(region).toMatchObject({ id: 'AA-NAT', coverage: 'partial', note: 'Province one layer.' });
        });

        it('lets one outline answer for provinces split after Natural Earth was cut', () => {
            const split = outlines(outline('AA-OLD', box(0, 0, 1, 1), { codes: ['AA-OLD', 'AA-NEW'] }));
            const [region] = buildRegions({ outlines: split, registry: registry({ subnationalCoverage: sub([['OLD', 'none'], ['NEW', 'partial']]) }), tolerance: 0.01 });
            expect(region.coverage).toBe('partial');
        });

        it('fails loudly on registry, catalog or review codes without an outline', () => {
            expect(() => buildRegions({ outlines: twoRegions, registry: registry({ subnationalCoverage: sub([['THREE', 'partial']]) }) }))
                .toThrow(/AA\/THREE/);
            expect(() => buildRegions({ outlines: twoRegions, registry: registry({ subnationalCoverage: [{ countryCode: 'BB', regions: [] }] }) }))
                .toThrow(/BB without region outlines/);
            expect(() => buildRegions({ outlines: twoRegions, registry: registry({ subnationalCoverage: [{ countryCode: 'RW', regions: [{ code: 'Gasabo', bucket: 'regionWide' }] }] }) }))
                .not.toThrow();
            expect(() => buildRegions({ outlines: twoRegions, registry: registry(), catalog: [{ id: 'typo', discovery: { jurisdiction: { admin1: ['AA-TRE'] } } }] }))
                .toThrow(/typo names admin-1 AA-TRE/);
            expect(() => buildRegions({ outlines: twoRegions, registry: registry(), reviews: [review('AA-ZZZ', [])] }))
                .toThrow(/AA-ZZZ/);
            expect(() => buildRegions({ outlines: twoRegions, registry: registry(), reviews: [review('AA-ONE', []), review('AA-ONE', [])] }))
                .toThrow(/more than one/);
        });
    });

    it('matches the committed output byte for byte and keeps outline and per-city payloads small', () => {
        const committed = read('frontend/data/world-coverage.json');
        expect(committed).toBe(`${JSON.stringify(built)}\n`);
        // Allow the catalog to grow without repeatedly lifting a total-file ceiling. Geography
        // has a fixed budget; city records retain a compact average budget as their count grows.
        const bytes = value => Buffer.byteLength(JSON.stringify(value));
        expect(bytes({ ...built, liveCities: [], cities: [], regions: [] })).toBeLessThan(200 * 1024);
        // Regions have their own geography budget (about 215 KB with 253 regions on 2026-10-12).
        expect(bytes(built.regions)).toBeLessThan(240 * 1024);
        expect(bytes(built.liveCities) + bytes(built.cities))
            .toBeLessThan(256 * (built.liveCities.length + built.cities.length) + 4);
    });
});
