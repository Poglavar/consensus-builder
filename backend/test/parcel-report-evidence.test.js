import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectReportEvidence } from '../../scripts/parcel-report-evidence.mjs';

const temporaryRoots = [];
function fixtureRoot() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parcel-evidence-'));
    temporaryRoots.push(root);
    return root;
}
function put(root, code, name, value) {
    const file = path.join(root, 'world-parcels/cities', String(code), name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function settings(code, appCityId, sourceId = 'source-a', endpoint = 'https://source.example/api') {
    return {
        schemaVersion: 1,
        cityCode: String(code),
        name: 'Fixture city',
        checkedAt: '2099-12-31',
        bindings: [{ appCityId, runtimeConfig: {
            id: appCityId, wupCityCode: String(code),
            parcels: { source: 'parcel-source', sourceId }
        } }],
        sources: [{ id: sourceId, cityIds: [appCityId], endpoint }]
    };
}
afterEach(() => temporaryRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('collectReportEvidence', () => {
    it('uses validated city settings as a working source without claiming completeness or inventing dates', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 10, 'settings.json', settings(10, 'alpha'));
        put(repoRoot, 10, 'failed-urls.json', [
            { url: 'https://offline.example/query?where=city#attempt', reason: 'timeout' },
            { url: 'https://unsafe.example/query?api_key=should-not-escape' }
        ]);
        const registry = {
            sources: [],
            cities: [{ cityId: 'wup2025:10', wupCityCode: 10, appCityId: 'alpha',
                dataFindings: { registryFound: false, registryBasis: 'stale registry note' } }]
        };
        const [row] = collectReportEvidence({ registry, repoRoot }).cities;
        expect(row).toMatchObject({
            cityId: 'wup2025:10', checked: true, checkedDate: null, checkedDateEvidence: null,
            registryFound: true, verifiedSample: true, sourceIds: ['source-a'],
            registryBasis: expect.stringContaining('citywide completeness remains unverified'),
            evidenceFiles: ['cities/10/settings.json', 'cities/10/failed-urls.json'],
            failureUrls: ['https://offline.example/query?where=city'], impliedParcelsTried: null
        });
        expect(row.evidenceUrls).toEqual([
            'https://source.example/api', 'https://offline.example/query?where=city'
        ]);
    });

    it('treats failed URL records as checked research but never reports absence or a working sample', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 20, 'failed-urls.json', [{ url: 'http://portal.example/parcels', reason: 'connection refused' }]);
        const registry = { sources: [], cities: [{ cityId: 'wup2025:20', wupCityCode: '20' }] };
        const [row] = collectReportEvidence({ registry, repoRoot }).cities;
        expect(row).toMatchObject({
            checked: true, checkedDate: null, checkedDateEvidence: null,
            registryFound: null, verifiedSample: false,
            failureUrls: ['http://portal.example/parcels'],
            evidenceFiles: ['cities/20/failed-urls.json']
        });
    });

    it('binds app evidence only through exact settings appCityId values', () => {
        const repoRoot = fixtureRoot();
        put(repoRoot, 30, 'settings.json', settings(30, 'exact-app', 'source-exact', 'https://exact.example/data'));
        put(repoRoot, 30, 'failed-urls.json', [{ url: 'https://failed.example/data' }]);
        const registry = {
            sources: [],
            cities: [{ cityId: 'registry:unrelated', wupCityCode: 999, name: 'Exact App City', countryCode: 'AA' }]
        };
        const { appCities } = collectReportEvidence({ registry, repoRoot, appCities: [
            { id: 'exact-app', name: 'Different visible name', cc: 'ZZ' },
            { id: 'name-only', name: 'Exact App City', cc: 'AA' }
        ] });
        expect(appCities[0]).toMatchObject({
            cityId: 'app:exact-app', checked: true, checkedDate: null,
            registryFound: true, verifiedSample: true, sourceIds: ['source-exact'],
            evidenceFiles: ['cities/30/settings.json', 'cities/30/failed-urls.json'],
            failureUrls: ['https://failed.example/data']
        });
        expect(appCities[1]).toMatchObject({
            cityId: 'app:name-only', checked: false, checkedDate: null,
            registryFound: null, verifiedSample: false, sourceIds: [], evidenceFiles: []
        });
    });

    it('retains country registry evidence metadata without opening referenced research files', () => {
        const repoRoot = fixtureRoot();
        const registry = {
            sources: [], cities: [],
            countryProbes: [{ countryCode: 'AA', status: 'national_online_cadastre_verified_sample',
                checkedAt: '2026-10-12', evidenceFile: 'research/never-read.json',
                inspireRecordUrl: 'https://country.example/record' }],
            countryCoverage: [{ countryCode: 'AA', status: 'verified_countrywide',
                evidenceFile: 'research/also-not-read.json' }],
            subnationalCoverage: [{ countryCode: 'AA', regionsTotal: 2, regionWide: 1, partial: 1,
                ruralRegistryOnly: 0, regions: [{ code: 'A1', name: 'Region A', status: 'reviewed', bucket: 'regionWide',
                    evidenceFile: 'research/region.json' }] }]
        };
        const { countries, warnings } = collectReportEvidence({ registry, repoRoot });
        expect(countries[0]).toMatchObject({
            countryCode: 'AA', checked: true, checkedDate: '2026-10-12',
            nationalCadastreFound: true, verifiedNationalSample: true,
            countryCoverageSampled: true, parentSource: false,
            evidenceUrls: ['https://country.example/record'],
            evidenceFiles: ['registry.json']
        });
        expect(countries[0].subnationalEvidence.regions[0].evidenceFile).toBe('registry.json');
        expect(warnings).toEqual([]);
    });
});
