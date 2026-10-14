import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    AFRICAN_UN_MEMBER_CODES, buildAfricaPopulationRanking, parseCsvLine, writeCohort
} from '../build-africa-city-queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function city(cityCode, iso2, pop2025k, point = [0, 0]) {
    return {
        year: 2025, cityCode, iso2, iso3: `${iso2}X`, name: `City ${cityCode}`,
        country: `Country ${iso2}`, locId: cityCode + 1000, capital: false,
        pop2025k, plausibility: null, point
    };
}

test('selects the African-only top N while keeping exact WUP coordinates and both rank systems', () => {
    const rows = [
        city(100, 'US', 900, [38.1, -77.1]),
        city(30, 'NG', 800, [6.5244, 3.3792]),
        city(20, 'EG', 800, [30.0444, 31.2357]),
        city(50, 'IN', 790, [19.07, 72.88]),
        city(10, 'ZA', 750, [-26.2, 28.04]),
        { ...city(11, 'ZA', 1000), year: 2015 }
    ];
    const { ranked, pending } = buildAfricaPopulationRanking(rows, { limit: 2, sourceSha256: 'abc123' });
    assert.deepEqual(ranked.roster.map(row => [row.cityCode, row.rank, row.globalRank]), [[20, 1, 2], [30, 2, 3]]);
    assert.deepEqual(ranked.roster[0].point, [30.0444, 31.2357]);
    assert.equal(ranked.roster[0].pop2025k, 800);
    assert.equal(ranked.roster[0].populationUnit, 'thousands');
    assert.equal(ranked.roster[0].name, 'City 20');
    assert.equal(pending.sourceRoster, 'ranked-population.json');
    assert.deepEqual(pending.cities.map(row => row.cityCode), [20, 30]);
    assert.equal(ranked.source.sha256, 'abc123');
    assert.equal(ranked.countryScope.iso2Codes.length, 54);
    assert.equal(AFRICAN_UN_MEMBER_CODES.includes('US'), false);
});

test('sort order is deterministic for ties and ignores input order', () => {
    const rows = [city(9, 'GH', 100), city(3, 'KE', 100), city(4, 'BR', 110)];
    const first = buildAfricaPopulationRanking(rows, { limit: 5 }).ranked.roster;
    const second = buildAfricaPopulationRanking([...rows].reverse(), { limit: 5 }).ranked.roster;
    assert.deepEqual(first.map(row => [row.cityCode, row.rank, row.globalRank]), [[3, 1, 2], [9, 2, 3]]);
    assert.deepEqual(second, first);
});

test('attaches prior and live app evidence only through exact country plus explicit WUP IDs, and retains each city', () => {
    const rows = [city(7, 'BJ', 500), city(8, 'GH', 400)];
    const evidenceInputs = {
        registry: [
            { cityId: 'wup2025:7', wupCityCode: 7, countryCode: 'BJ', name: 'Registry match', parcelStatus: 'checked', sourceIds: ['provider-bj'], researchFile: 'research/bj.json', appCityId: 'app-bj' },
            { cityId: 'wup2025:7', wupCityCode: 7, countryCode: 'GH', name: 'Wrong-country collision', sourceIds: ['provider-foreign'], researchFile: 'research/wrong.json' },
            { cityId: 'wup2025:8', wupCityCode: 8, countryCode: 'GH', name: 'Ghana match', parcelStatus: 'no_sample', researchFile: 'research/gh.json' }
        ],
        demographics: [
            { id: 'wup2025:7', wupCityCode: 7, countryCode: 'BJ', populationMatch: { confidence: 'high' }, registryCityIds: ['legacy-bj'], appCityIds: ['app-bj'] },
            { id: 'wup2025:7', wupCityCode: 7, countryCode: 'GH', populationMatch: { confidence: 'high' }, appCityIds: ['wrong-country-app'] },
            { id: 'wup2025:8', wupCityCode: 8, countryCode: 'GH', populationMatch: { confidence: 'high' } }
        ],
        coverage: [
            { id: 'wup2025:7', wupCityCode: 7, countryCode: 'BJ', appCityIds: ['coverage-app-bj'], sourceIds: ['provider-coverage'], integrationAttempts: [{ outcome: 'held', summary: 'Retry needed.', checkedAt: '2026-10-13', evidenceUrl: 'https://example.test/evidence', checkedDateEvidence: { date: '2026-10-13', path: 'world-parcels/research/qualification/7/result.json', field: '$.finishedAt' } }] },
            { id: 'wup2025:7', wupCityCode: 7, countryCode: 'GH', appCityIds: ['wrong-country-coverage-app'], integrationAttempts: [{ outcome: 'wrong-country' }] },
            { id: 'wup2025:8', wupCityCode: 8, countryCode: 'GH', integrationAttempts: [{ outcome: 'held' }] }
        ],
        capitals: [
            { cityId: 'wup2025:7', countryCode: 'BJ', checked: true, researchStatus: 'previously_checked', evidenceFiles: ['research/capital-bj.json'] },
            { cityId: 'wup2025:7', countryCode: 'GH', checked: true, researchStatus: 'previously_checked', evidenceFiles: ['research/capital-wrong.json'] },
            { cityId: 'geonames:123', countryCode: 'BJ', checked: true, researchStatus: 'previously_checked', registryMatches: [{ cityId: 'wup2025:7', researchFile: 'research/capital-linked.json' }] }
        ]
    };
    evidenceInputs.registry.push({ cityId: 'legacy-bj', countryCode: 'BJ', parcelStatus: 'prior_attempt', researchFile: 'research/legacy-bj.json', sourceIds: ['provider-legacy'] });
    const { ranked, pending } = buildAfricaPopulationRanking(rows, { evidenceInputs });
    const benin = ranked.roster[0];
    const ghana = ranked.roster[1];
    assert.equal(benin.priorEvidence.length > 0, true);
    assert.equal(benin.priorEvidence.some(item => item.cityId === 'wup2025:7' && item.source === 'registry'), true);
    assert.equal(benin.priorEvidence.some(item => item.cityId === 'legacy-bj' && item.source === 'city-demographics-registry-crosswalk'), true);
    assert.equal(benin.priorEvidence.some(item => item.evidenceFiles?.includes('world-parcels/research/capital-bj.json')), true);
    assert.equal(benin.priorEvidence.some(item => item.source === 'parcel-coverage-report-integration-attempts' && item.integrationAttempts?.[0]?.outcome === 'held'), true);
    assert.equal(benin.priorEvidence.some(item => item.source === 'world-capitals-prior-check-roster' && item.matchedWupCityId === 'wup2025:7'), true);
    assert.equal(benin.priorEvidence.some(item => item.cityId === 'wup2025:7' && item.source === 'registry' && item.sourceIds?.includes('provider-foreign')), false);
    assert.deepEqual(benin.appBindings, [
        { appCityId: 'app-bj', evidenceReuseOnly: true, researchQueueRetained: true, sourceIds: ['provider-bj'], parcelStatuses: ['checked'] },
        { appCityId: 'coverage-app-bj', evidenceReuseOnly: true, researchQueueRetained: true, sourceIds: [], parcelStatuses: [] }
    ]);
    assert.deepEqual(ghana.appBindings, []);
    assert.equal(pending.cities.length, 2);
    assert.equal(pending.cities.every(row => row.researchPolicy.retainInQueue), true);
    assert.equal(JSON.stringify({ ranked, pending }).includes('/Users/'), false);
});

test('rejects duplicate WUP identities and exposes a quote-aware CSV parser', () => {
    assert.throws(() => buildAfricaPopulationRanking([city(1, 'BJ', 1), city(1, 'BJ', 2)]), /Duplicate WUP City_Code/);
    assert.deepEqual(parseCsvLine('1,"City, with ""quotes""",2025'), ['1', 'City, with "quotes"', '2025']);
});

test('cohort writes are readback-idempotent and refuse changed artifacts without replacing them', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'africa-queue-test-'));
    try {
        const outputs = buildAfricaPopulationRanking([city(1, 'BJ', 100)], { limit: 1 });
        writeCohort(tmp, outputs);
        const queuePath = path.join(tmp, 'pending-queue.json');
        const original = readFileSync(queuePath, 'utf8');
        writeCohort(tmp, outputs);
        assert.equal(readFileSync(queuePath, 'utf8'), original);
        writeFileSync(queuePath, '{"cities":[]}\n');
        assert.throws(() => writeCohort(tmp, outputs), /Refusing to overwrite different cohort artifact/);
        assert.equal(readFileSync(queuePath, 'utf8'), '{"cities":[]}\n');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('CLI without --run is inert', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'africa-queue-inert-'));
    try {
        const output = path.join(tmp, 'must-not-exist');
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-africa-city-queue.mjs'), '--source', path.join(tmp, 'missing.gz'), '--output', output], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.includes('Without --run'), true);
        assert.equal(existsSync(output), false);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

