import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectReportEvidence } from '../../scripts/parcel-report-evidence.mjs';

const temporaryRoots = [];
function fixtureRoot() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parcel-evidence-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'world-parcels/research'), { recursive: true });
    return root;
}
function put(root, relative, value) {
    const file = path.join(root, 'world-parcels', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
afterEach(() => temporaryRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('collectReportEvidence', () => {
    it('distinguishes a documented local registry from geometry access and unresolved regional leads', () => {
        const repoRoot = fixtureRoot();
        const registry = { sources: [], cities: [true, null, false].map((registryFound, index) => {
            const cityId = `city-${index}`;
            put(repoRoot, `research/${cityId}.json`, { cityId, checkedAt: '2026-10-07' });
            return { cityId, parcelStatus: 'no_verified_open_endpoint_after_attempts',
                researchFile: `research/${cityId}.json`, dataFindings: { registryFound,
                    registryBasis: index === 0 ? 'Official local registry office; geometry API not verified.' : 'Target coverage unresolved.',
                    registryEvidenceUrls: ['https://authority.example/registry', 'javascript:invalid'] } };
        }) };
        const { cities } = collectReportEvidence({ registry, repoRoot });
        expect(cities.map(row => [row.registryFound, row.verifiedSample, row.checked])).toEqual([
            [true, false, true], [null, false, true], [false, false, true]
        ]);
        expect(cities[0].registryBasis).toContain('geometry API not verified');
        expect(cities[0].evidenceUrls).toEqual(['https://authority.example/registry']);
    });

    it('keeps unavailable leads distinct from checked negatives and verified viewer samples', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/unavailable.json', { checkedAt: '2026-10-01', status: 'temporarily_unavailable' });
        put(repoRoot, 'research/negative.json', { checkedAt: '2026-10-02', status: 'no_verified_open_endpoint_after_attempts' });
        put(repoRoot, 'research/viewer.json', { checkedAt: '2026-10-03', status: 'verified_sample_city_scope' });
        const registry = {
            sources: [{ sourceId: 'viewer-layer', endpoint: 'https://public.example/layer', verificationStatus: 'verified_nonempty_sample', verifiedCityIds: ['viewer-city'] }],
            cities: [
                { cityId: 'unavailable-city', parcelStatus: 'temporarily_unavailable', researchFile: 'research/unavailable.json' },
                { cityId: 'negative-city', parcelStatus: 'no_verified_open_endpoint_after_attempts', researchFile: 'research/negative.json' },
                { cityId: 'viewer-city', parcelStatus: 'verified_sample_city_scope', sourceIds: ['viewer-layer'], researchFile: 'research/viewer.json' }
            ]
        };
        const result = collectReportEvidence({ registry, repoRoot });
        expect(result.cities.map(row => [row.registryFound, row.verifiedSample])).toEqual([
            [null, false], [false, false], [true, true]
        ]);
        expect(result.cities[0].checked).toBe(true);
        expect(result.cities[2].evidenceUrls).toEqual(['https://public.example/layer']);
    });

    it('does not turn a two-region sample, a missing date, or a generated timestamp into national completeness', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/two-regions.json', { verifiedAt: '2026-09-30T10:00:00Z' });
        const registry = {
            updatedAt: '2099-01-01',
            sources: [], cities: [],
            countryProbes: [
                { countryCode: 'AA', status: 'national_online_cadastre_verified_sample', checkedAt: '2026-09-29', evidenceFile: 'research/two-regions.json' },
                { countryCode: 'BB', status: 'temporarily_unavailable', evidenceFile: 'research/no-date.json' },
                { countryCode: 'CC', status: 'partial_or_unofficial_sample', checkedAt: '2026-09-29' }
            ],
            countryCoverage: [{ countryCode: 'AA', status: 'verified_countrywide', basis: 'two_region_test', reviewed: false, evidenceFile: 'research/two-regions.json' }],
            subnationalCoverage: []
        };
        const rows = Object.fromEntries(collectReportEvidence({ registry, repoRoot }).countries.map(row => [row.countryCode, row]));
        expect(rows.AA).toMatchObject({ nationalCadastreFound: true, verifiedNationalSample: true, countryCoverageSampled: true, checkedDate: '2026-09-30' });
        expect(rows.BB).toMatchObject({ nationalCadastreFound: null, checked: false, checkedDate: null });
        expect(rows.CC).toMatchObject({ nationalCadastreFound: null, checked: true, checkedDate: '2026-09-29' });
    });

    it('uses city-scoped research dates and leaves implied parcel attempts unknown outside Zagreb', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/old-city.json', { checkedAt: '2026-09-01' });
        put(repoRoot, 'research/latest-city.json', { checkedAt: '2026-10-04', verifiedAt: '2026-10-05T12:00:00Z' });
        put(repoRoot, 'research/other-city.json', { checkedAt: '2026-10-07' });
        const registry = {
            updatedAt: '2099-01-01',
            sources: [{ sourceId: 'city-source', verificationStatus: 'verified_nonempty_sample', evidenceFile: 'research/other-city.json',
                integrationAttempts: [{ checkedAt: '2026-10-06', operation: 'Separate check for city-b', outcome: 'technical-hold', evidenceFile: 'research/other-city.json' }] }],
            cities: [
                { cityId: 'city-a', parcelStatus: 'verified_sample_city_scope', sourceIds: ['city-source'], researchFile: 'research/old-city.json', latestAssessmentFile: 'research/latest-city.json' },
                { cityId: 'geonames:3186886', parcelStatus: 'verified_sample_city_scope' },
                { cityId: 'city-b', parcelStatus: 'temporarily_unavailable', researchFile: 'research/other-city.json' }
            ], countryProbes: [], countryCoverage: [], subnationalCoverage: []
        };
        const rows = Object.fromEntries(collectReportEvidence({ registry, repoRoot }).cities.map(row => [row.cityId, row]));
        expect(rows['city-a'].checkedDate).toBe('2026-10-05');
        expect(rows['city-a'].checkedDateEvidence.path).toBe('research/latest-city.json');
        expect(rows['city-b'].checkedDate).toBe('2026-10-07');
        expect(rows['city-b'].impliedParcelsTried).toBeNull();
        expect(rows['geonames:3186886'].impliedParcelsTried).toBeNull();
    });

    it('marks a documented investigation checked even when its evidence has no date', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/undated-review.json', { status: 'temporarily_unavailable', attempts: [{ outcome: 'timeout' }] });
        const registry = {
            sources: [],
            cities: [{ cityId: 'undated-city', parcelStatus: 'temporarily_unavailable', researchFile: 'research/undated-review.json' }]
        };
        const [row] = collectReportEvidence({ registry, repoRoot }).cities;
        expect(row).toMatchObject({ checked: true, checkedDate: null, checkedDateEvidence: null, registryFound: null });
    });

    it('accepts an old queue identifier when the research record confirms exact city and country', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/aliased-city.json', {
            cityId: 'queue:34', name: 'Hajipur', countryCode: 'IN', checkedAt: '2026-09-29'
        });
        const registry = {
            sources: [],
            cities: [{ cityId: 'wup2025:11027', wupCityCode: 11027, name: 'Hajipur', countryCode: 'IN',
                parcelStatus: 'no_verified_open_endpoint_after_attempts', researchFile: 'research/aliased-city.json' }]
        };
        const [row] = collectReportEvidence({ registry, repoRoot }).cities;
        expect(row).toMatchObject({ checked: true, checkedDate: '2026-09-29', checkedDateEvidence: { path: 'research/aliased-city.json' } });
    });

    it('does not let a shared source’s other-city attempt or nested evidence date update this city', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/shared-batch.json', {
            checkedAt: '2026-10-01',
            results: [{ cityId: 'city-b', checkedAt: '2026-10-10' }]
        });
        const registry = {
            sources: [{ sourceId: 'shared', verificationStatus: 'verified_nonempty_sample', verifiedCityIds: ['city-a', 'city-b'],
                integrationAttempts: [{ cityId: 'city-b', checkedAt: '2026-10-12', outcome: 'technical-hold', evidenceFile: 'research/shared-batch.json' }] }],
            cities: [
                { cityId: 'city-a', parcelStatus: 'verified_sample_city_scope', sourceIds: ['shared'], researchFile: 'research/shared-batch.json' },
                { cityId: 'city-b', parcelStatus: 'verified_sample_city_scope', sourceIds: ['shared'], researchFile: 'research/shared-batch.json' }
            ]
        };
        const rows = Object.fromEntries(collectReportEvidence({ registry, repoRoot }).cities.map(row => [row.cityId, row]));
        expect(rows['city-a'].checkedDate).toBe('2026-10-01');
        expect(rows['city-b'].checkedDate).toBe('2026-10-12');
    });

    it('requires a recorded experiment result before marking the known city as tried', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'guess-spike/README.md', '# Zagreb parcel estimation');
        const registry = { sources: [], countries: [], countryProbes: [], countryCoverage: [], subnationalCoverage: [], cities: [
            { cityId: 'geonames:3186886', parcelStatus: 'verified_sample_city_scope' },
            { cityId: 'geonames:5128581', parcelStatus: 'verified_sample_city_scope' }
        ] };
        const [cityBeforeRun] = collectReportEvidence({ registry, repoRoot }).cities;
        expect(cityBeforeRun.impliedParcelsTried).toBeNull();
        put(repoRoot, 'guess-spike/output/sam3-zagreb/results.json', { tile: '2971_33018' });
        const rows = Object.fromEntries(collectReportEvidence({ registry, repoRoot }).cities.map(row => [row.cityId, row]));
        expect(rows['geonames:3186886'].impliedParcelsTried).toBe(true);
        expect(rows['geonames:5128581'].impliedParcelsTried).toBeNull();
    });

    it('adds app-only evidence from city-scoped catalog records and Belgrade assessment', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/a-live.json', { cityId: 'a', checkedAt: '2026-10-01' });
        put(repoRoot, 'research/b-live.json', { cityId: 'b', checkedAt: '2026-10-02' });
        put(repoRoot, 'research/db-city-belgrade-live-2026-10-03.json', {
            cityId: 'belgrade', countryCode: 'RS', assessedAt: '2026-10-03',
            decision: 'Official cadastral map/data existence is established, but no anonymous endpoint was verified.',
            authority: {
                officialGeoSrbijaPage: 'https://authority.example/geosrbija',
                officialeCadastrePage: 'https://authority.example/ecadastre'
            }
        });
        const registry = {
            sources: [{ sourceId: 'shared-source', verificationStatus: 'verified_live_city_adapter',
                liveIntegration: { status: 'enabled', cityIds: ['a', 'b'], evidenceFile: 'research/a-live.json',
                    additionalCityEvidence: { b: 'research/b-live.json' } },
                integrationAttempts: [{ checkedAt: '2026-10-09', cityId: 'b', outcome: 'success' }] }],
            cities: [], countryProbes: [], countryCoverage: [], subnationalCoverage: []
        };
        const sourceCatalog = { sources: [{ id: 'shared-source', cityIds: ['a', 'b'],
            endpoint: 'https://data.example/parcels', evidenceFile: 'research/a-live.json' }] };
        const result = collectReportEvidence({ registry, repoRoot, sourceCatalog, appCities: [
            { id: 'a', name: 'Alpha', cc: 'AA', sourceId: 'shared-source' },
            { id: 'b', name: 'Beta', cc: 'BB', sourceId: 'shared-source' },
            { id: 'belgrade', name: 'Belgrade', cc: 'RS' }
        ] });
        const rows = Object.fromEntries(result.appCities.map(row => [row.cityId, row]));
        expect(rows['app:a']).toMatchObject({ checked: true, checkedDate: '2026-10-01', registryFound: true, verifiedSample: true });
        expect(rows['app:b']).toMatchObject({ checked: true, checkedDate: '2026-10-09', registryFound: true, verifiedSample: true });
        expect(rows['app:a'].checkedDate).not.toBe('2026-10-09');
        expect(rows['app:belgrade']).toMatchObject({ checked: true, checkedDate: '2026-10-03', registryFound: true, verifiedSample: false });
        expect(rows['app:belgrade'].checkedDateEvidence.field).toBe('$.assessedAt');
        expect(rows['app:belgrade'].evidenceUrls).toContain('https://authority.example/geosrbija');
    });

    it('does not copy a verified shared source status onto an untested catalog city', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 'research/only-tested-city.json', { cityId: 'tested', checkedAt: '2026-10-02' });
        const registry = {
            sources: [{ sourceId: 'one-city-verified', verificationStatus: 'verified_live_city_adapter',
                verifiedCityIds: ['tested'], liveIntegration: { cityIds: ['tested'], evidenceFile: 'research/only-tested-city.json' } }],
            cities: [], countryProbes: [], countryCoverage: [], subnationalCoverage: []
        };
        const sourceCatalog = { sources: [{ id: 'one-city-verified', cityIds: ['tested', 'untested'],
            endpoint: 'https://data.example/one-city', evidenceFile: 'research/only-tested-city.json' }] };
        const result = collectReportEvidence({ registry, repoRoot, sourceCatalog, appCities: [
            { id: 'tested', name: 'Tested City', cc: 'AA', sourceId: 'one-city-verified' },
            { id: 'untested', name: 'Untested City', cc: 'BB', sourceId: 'one-city-verified' }
        ] });
        const rows = Object.fromEntries(result.appCities.map(row => [row.cityId, row]));
        expect(rows['app:tested']).toMatchObject({ checked: true, checkedDate: '2026-10-02', verifiedSample: true });
        expect(rows['app:untested']).toMatchObject({ checked: false, checkedDate: null, registryFound: true, verifiedSample: false });
    });
});
