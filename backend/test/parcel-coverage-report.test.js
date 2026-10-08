// Regressions for comparable report totals, null preservation and every column's sorting behavior.
import { describe, expect, it } from 'vitest';
import { nextSort, sortRows, filterCities, countryCategory, summarizeJurisdictions, mapLinks } from '../../frontend/js/parcel-coverage-report-model.mjs';
import { buildParcelReport } from '../../scripts/build-parcel-coverage-report.mjs';
import { reportMessages } from '../../frontend/js/parcel-coverage-report-i18n.mjs';

function buildSmallReport({ registry, liveCities, enrichmentCities = [] }) {
    const statistics = { landAreaKm2: 10, builtUpAreaKm2: 2, population: 100 };
    return buildParcelReport({
        registry,
        evidence: { cities: [], appCities: [], countries: [], warnings: [] },
        enrichment: { asOf: '2026-10-08', cities: enrichmentCities },
        countryData: {
            countries: [{ code: 'AA', name: 'Testland', stats: statistics }],
            world: statistics, sources: []
        },
        coverage: { liveCities },
        sourceCatalog: { sources: [] }
    });
}

describe('parcel coverage report', () => {
    it('sorts numeric values rather than formatted text, toggles both ways, and leaves missing values last', () => {
        const rows = [{ id: 'missing', population: null }, { id: 'hundred', population: 100 }, { id: 'nine', population: 9 }, { id: 'zero', population: 0 }];
        const first = nextSort(null, 'population');
        expect(sortRows(rows, first).map(row => row.id)).toEqual(['zero', 'nine', 'hundred', 'missing']);
        const second = nextSort(first, 'population');
        expect(sortRows(rows, second).map(row => row.id)).toEqual(['hundred', 'nine', 'zero', 'missing']);
        expect(nextSort(second, 'population')).toEqual(first);
        expect(nextSort(second, 'name')).toEqual({ key: 'name', direction: 'asc' });
    });

    it('preserves checked negatives, unavailable findings and unchecked candidates as distinct states', () => {
        const cities = [{ name: 'First', country: 'Country', countryCode: 'AA', checked: true, registryFound: false }, { name: 'Second', country: 'Country', countryCode: 'AA', checked: true, registryFound: null }, { name: 'Third', country: 'Country', countryCode: 'AA', checked: false, registryFound: null }];
        expect(filterCities(cities, { checked: 'yes', registry: 'no' }).map(row => row.name)).toEqual(['First']);
        expect(filterCities(cities, { checked: 'no' }).map(row => row.name)).toEqual(['Third']);
        expect(filterCities(cities, { checked: 'yes', registry: 'unknown' }).map(row => row.name)).toEqual(['Second']);
        expect(sortRows(cities, { key: 'registryFound', direction: 'desc' })[0].registryFound).toBe(false);
    });

    it('filters largest and growth cohorts, limiting the growth top 20 to saved numeric ranks 1–20', () => {
        const cities = [
            { name: 'Largest only', cohorts: ['largest200'], growthRank: null },
            { name: 'Growth rank one', cohorts: ['growth200'], growthRank: 1 },
            { name: 'Growth rank twenty', cohorts: ['growth200'], growthRank: 20 },
            { name: 'Growth rank twenty-one', cohorts: ['growth200'], growthRank: 21 },
            { name: 'Missing growth rank', cohorts: ['growth200'], growthRank: null },
            { name: 'Numeric rank without cohort tag', cohorts: [], growthRank: 2 }
        ];
        expect(filterCities(cities, { cohort: 'all' }).map(row => row.name)).toEqual(cities.map(row => row.name));
        expect(filterCities(cities, { cohort: 'largest200' }).map(row => row.name)).toEqual(['Largest only']);
        expect(filterCities(cities, { cohort: 'growth200' }).map(row => row.name)).toEqual(['Growth rank one', 'Growth rank twenty', 'Growth rank twenty-one', 'Missing growth rank']);
        expect(filterCities(cities, { cohort: 'growth-top20' }).map(row => row.name)).toEqual(['Growth rank one', 'Growth rank twenty', 'Numeric rank without cohort tag']);
    });

    it('does not count a dependency twice or silently lose unallocated world amounts', () => {
        const world = { landAreaKm2: 1000, builtUpAreaKm2: 100, population: 10000 };
        const countries = [
            { code: 'AA', category: 'national', landAreaKm2: 600, builtUpAreaKm2: 60, population: 6000 },
            { code: 'BB', category: 'local', landAreaKm2: 300, builtUpAreaKm2: 30, population: 3000 },
            { code: 'XAA', category: 'unknown', statisticsIncluded: false, landAreaKm2: 600, builtUpAreaKm2: 60, population: 6000 }
        ];
        const summary = summarizeJurisdictions(countries, world);
        expect(summary.rows.find(row => row.id === 'national').landAreaKm2Pct).toBe(60);
        expect(summary.rows.find(row => row.id === 'unknown')).toMatchObject({ landAreaKm2: 100, builtUpAreaKm2: 10, population: 1000 });
        expect(summary.rows.reduce((sum, row) => sum + row.populationPct, 0)).toBe(100);
        expect(() => summarizeJurisdictions([...countries, { ...countries[0], code: 'duplicate' }], world)).toThrow(/exceed world/);
    });

    it('filters the saved India and Africa cohort membership independently of free-text country names', () => {
        const cities = [
            { name: 'Indian target', researchFocusRegion: 'India', checked: false },
            { name: 'African target', researchFocusRegion: 'Africa', checked: true },
            { name: 'Outside the two saved cohorts', countryCode: 'IN', researchFocusRegion: null, checked: true }
        ];
        expect(filterCities(cities, { cohort: 'india-africa' }).map(row => row.name)).toEqual(['Indian target', 'African target']);
        expect(filterCities(cities, { cohort: 'india' }).map(row => row.name)).toEqual(['Indian target']);
        expect(filterCities(cities, { cohort: 'africa' }).map(row => row.name)).toEqual(['African target']);
        expect(filterCities(cities, { cohort: 'india-africa', checked: 'yes' }).map(row => row.name)).toEqual(['African target']);
    });

    it('attaches fresh WUP research to an existing demographic city without duplicating or mutating it', () => {
        const original = { id: 'demographic:123', wupCityCode: 123, name: 'Target', countryCode: 'AA', registryCityIds: [], appCityIds: [], cohorts: ['growth200'], latitude: 1, longitude: 2, population2025: 50000 };
        const report = buildParcelReport({
            registry: { cities: [{ cityId: 'wup2025:123', name: 'Target', countryCode: 'AA' }], sources: [] },
            sourceCatalog: { sources: [] }, coverage: { liveCities: [] },
            evidence: { cities: [{ cityId: 'wup2025:123', checked: true, registryFound: null, verifiedSample: false, sourceIds: [], evidenceUrls: [], evidenceFiles: ['research/fresh.json'], checkedDateEvidence: { date: '2026-10-08', path: 'research/fresh.json' } }], countries: [], warnings: [] },
            enrichment: { cities: [original] }, growthQueue: [{ cityCode: 123, rank: 12 }], focusQueue: [{ wupCityCode: 123, region: 'Africa', priority: 4 }],
            countryData: { countries: [{ code: 'AA', name: 'Country', stats: { landAreaKm2: 10, builtUpAreaKm2: 1, population: 100000 } }], world: { landAreaKm2: 10, builtUpAreaKm2: 1, population: 100000 }, sources: [] }
        });
        expect(report.cities).toHaveLength(1);
        expect(report.cities[0]).toMatchObject({ id: 'demographic:123', population2025: 50000, registryCityIds: ['wup2025:123'], checked: true, checkedDate: '2026-10-08', registryFound: null, growthRank: 12, researchFocusRegion: 'Africa', researchPriority: 4 });
        expect(report.cities[0].cohorts).toEqual(['growth200', 'registry']);
        expect(original.registryCityIds).toEqual([]);
        expect(original.cohorts).toEqual(['growth200']);
    });

    it('links a new registry city to its explicitly enabled app source without mutating enrichment', () => {
        const enrichmentCity = {
            id: 'demographic:1', name: 'Tbilisi', countryCode: 'AA', registryCityIds: [], appCityIds: [],
            latitude: 1, longitude: 2, population2025: 100
        };
        const report = buildSmallReport({
            registry: {
                cities: [{ cityId: 'msda:tbilisi', name: 'Tbilisi', countryCode: 'AA', centerLatLon: [41.7, 44.8] }],
                sources: [{ sourceId: 'msda-tbilisi', verifiedCityIds: ['msda:tbilisi'], liveIntegration: { status: 'enabled', appCityId: 'tbilisi' } }]
            },
            liveCities: [{ id: 'tbilisi', sourceId: 'msda-tbilisi' }],
            enrichmentCities: [enrichmentCity]
        });

        expect(report.cities.find(city => city.id === 'msda:tbilisi')).toMatchObject({
            registryCityIds: ['msda:tbilisi'], appCityIds: ['tbilisi'], sourceIds: ['msda-tbilisi']
        });
        expect(enrichmentCity.registryCityIds).toEqual([]);
        expect(enrichmentCity.appCityIds).toEqual([]);
    });

    it('does not infer app bindings from multi-city sources, mismatched source IDs, or non-live integrations', () => {
        const registryCities = ['multi:one', 'multi:two', 'mismatch:one', 'disabled:one', 'not-live:one'].map(cityId => ({
            cityId, name: cityId, countryCode: 'AA'
        }));
        const report = buildSmallReport({
            registry: {
                cities: registryCities,
                sources: [
                    { sourceId: 'multi-source', verifiedCityIds: ['multi:one', 'multi:two'], liveIntegration: { status: 'enabled', appCityId: 'app-multi' } },
                    { sourceId: 'registry-source', verifiedCityIds: ['mismatch:one'], liveIntegration: { status: 'enabled', appCityId: 'app-mismatch' } },
                    { sourceId: 'disabled-source', verifiedCityIds: ['disabled:one'], liveIntegration: { status: 'disabled', appCityId: 'app-disabled' } },
                    { sourceId: 'not-live-source', verifiedCityIds: ['not-live:one'], liveIntegration: { status: 'enabled', appCityId: 'app-not-live' } }
                ]
            },
            liveCities: [
                { id: 'app-multi', sourceId: 'multi-source' },
                { id: 'app-mismatch', sourceId: 'different-source' },
                { id: 'app-disabled', sourceId: 'disabled-source' }
            ]
        });

        expect(report.cities.map(city => city.appCityIds)).toEqual([[], [], [], [], []]);
    });

    it('binds reviewed city rows to a shared provider only when all explicit source references agree', () => {
        const rows = [
            { cityId: 'capital:one', appCityId: 'app-one', sourceIds: ['shared'] },
            { cityId: 'capital:two', appCityId: 'app-two', sourceIds: ['different'] },
            { cityId: 'capital:three', appCityId: 'app-three', sourceIds: ['shared'] }
        ].map(city => ({ ...city, name: city.cityId, countryCode: 'AA' }));
        const report = buildSmallReport({
            registry: { cities: rows, sources: [{ sourceId: 'shared', verifiedCityIds: rows.map(city => city.cityId),
                liveIntegration: { status: 'enabled', cityIds: ['app-one', 'app-two'] } }] },
            liveCities: rows.map(city => ({ id: city.appCityId, sourceId: 'shared' }))
        });
        expect(report.cities.map(city => city.appCityIds)).toEqual([['app-one'], [], []]);
    });

    it('keeps discovery categories separate from territorial completeness', () => {
        expect(countryCategory({ nationalCadastreFound: true, probeStatus: 'national_cadastre_viewer_only' })).toBe('national');
        expect(countryCategory({ nationalCadastreFound: null, citiesWithRegistry: 1 })).toBe('local');
        expect(countryCategory({ nationalCadastreFound: false, citiesWithRegistry: 0 })).toBe('none');
        expect(countryCategory({ nationalCadastreFound: null, citiesWithRegistry: 0 })).toBe('unknown');
        expect(mapLinks(null, 15).osmUrl).toBeNull();
        expect(mapLinks(0, 0).googleMapsUrl).toContain('query=0.00000%2C0.00000');
    });

    it('includes checked and queued cities, keeps unknowns null, and never sums overlapping city populations for world shares', () => {
        const report = buildParcelReport({
            growthQueue: [{ cityCode: 123, rank: 20 }],
            registry: { cities: [], sources: [] }, sourceCatalog: { sources: [] }, coverage: { liveCities: [{ id: 'first' }] },
            evidence: { cities: [
                { cityId: 'checked', checked: true, checkedDate: '2026-10-01', checkedDateEvidence: { date: '2026-10-01', path: 'research/check.json' }, registryFound: true, verifiedSample: true, sourceIds: [], evidenceUrls: [], evidenceFiles: [] }
            ], appCities: [
                { cityId: 'app:first', checked: true, checkedDate: '2026-10-02', checkedDateEvidence: { date: '2026-10-02', path: 'research/app-check.json' }, registryFound: true, verifiedSample: true, sourceIds: [], evidenceUrls: [], evidenceFiles: [] }
            ], countries: [{ countryCode: 'AA', checked: true, nationalCadastreFound: true }], warnings: [] },
            enrichment: { asOf: '2026-10-07', cities: [
                { id: 'one', wupCityCode: 123, name: 'First', countryCode: 'AA', registryCityIds: ['checked'], appCityIds: ['first'], population2025: 100000, population2015: 50000, annualGrowthPct2015To2025: 6.93, latitude: 1, longitude: 1 },
                { id: 'two', name: 'Second', countryCode: 'AA', registryCityIds: [], appCityIds: [], population2025: null, latitude: 2, longitude: 2 }
            ] },
            countryData: { countries: [{ code: 'AA', name: 'Country', stats: { year: 2025, landAreaKm2: 1000, builtUpAreaKm2: 100, population: 10000 } }], world: { landAreaKm2: 1000, builtUpAreaKm2: 100, population: 10000 }, sources: [] }
        });
        expect(report.countries[0]).toMatchObject({ citiesChecked: 1, citiesWithRegistry: 1 });
        expect(report.cities[1]).toMatchObject({ checked: false, checkedDate: null, registryFound: null, population2025: null, annualGrowthPct2015To2025: null });
        expect(report.world.population).toBe(10000);
        expect(report.metadata.checkedCityCount).toBe(1);
        expect(report.cities[0].checkedDate).toBe('2026-10-02');
        expect(report.cities.map(row => row.growthRank)).toEqual([20, null]);
    });

    it('keeps all four locales and their interpolation fields complete', () => {
        for (const messages of Object.values(reportMessages)) {
            expect(Object.keys(messages).sort()).toEqual(Object.keys(reportMessages.en).sort());
            for (const key of Object.keys(reportMessages.en)) expect((messages[key].match(/\{\w+\}/g) || []).sort()).toEqual((reportMessages.en[key].match(/\{\w+\}/g) || []).sort());
        }
    });
});
