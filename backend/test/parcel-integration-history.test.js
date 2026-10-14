import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    indexIntegrationHistory,
    integrationCityKey,
    integrationCityKeys,
    integrationHistoryForCity,
    integrationOutcomeKeys,
    readIntegrationOutcomeBatches
} from '../../scripts/parcel-integration-history.mjs';
import { buildParcelReport } from '../../scripts/build-parcel-coverage-report.mjs';

const tempDirs = [];
function tempRoot() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parcel-integration-history-'));
    tempDirs.push(root);
    return root;
}

afterEach(() => {
    for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function batch(name, cities) {
    return {
        evidenceFile: `world-parcels/research/qualification-outcomes/${name}`,
        data: { schemaVersion: 1, cities }
    };
}

function outcome(cityCode, outcome, finishedAt, extra = {}) {
    return { cityCode, countryCode: 'AA', outcome, finishedAt, ...extra };
}

function smallReport({ cities, integrationOutcomeBatches, liveCities = [], catalogSources = [], countryCodes = ['AA'] }) {
    const statistics = { landAreaKm2: 100, builtUpAreaKm2: 10, population: 1000, year: 2025 };
    return buildParcelReport({
        registry: { cities: [], sources: [] },
        evidence: { cities: [], appCities: [], countries: [], warnings: [] },
        enrichment: { asOf: '2026-01-01', cities },
        countryData: {
            countries: countryCodes.map(code => ({ code, name: code === 'AA' ? 'Testland' : `${code}land`, stats: statistics })),
            world: statistics,
            sources: [],
            methodology: [],
            scope: 'test roster'
        },
        coverage: { liveCities },
        sourceCatalog: { sources: catalogSources },
        integrationOutcomeBatches
    });
}

describe('parcel integration outcome history', () => {
    it('publishes every recorded city outcome, including candidates absent from the old research ledger', () => {
        const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
        const report = JSON.parse(readFileSync(path.join(repoRoot, 'frontend/data/parcel-coverage-report.json'), 'utf8'));
        const expected = readIntegrationOutcomeBatches(repoRoot).flatMap(({ evidenceFile, data }) => data.cities.map(record =>
            JSON.stringify([record.registryCityId ? `${record.countryCode}:registry:${record.registryCityId}`
                : `${record.countryCode}:${Number(record.cityCode)}`, evidenceFile, record.outcome, record.finishedAt || null])));
        const actual = report.cities.flatMap(city => city.integrationAttempts.map(attempt => {
            const evidenceFile = decodeURIComponent(new URL(attempt.evidenceUrl).pathname.split('/blob/colosseum-worlds-fair/')[1]);
            const key = attempt.registryCityId ? `${city.countryCode}:registry:${attempt.registryCityId}` : integrationCityKey(city);
            return JSON.stringify([key, evidenceFile, attempt.outcome, attempt.checkedAt]);
        }));
        expect(actual.sort()).toEqual(expected.sort());
    });

    it('reads only sorted JSON outcome batches and matches exact country plus WUP city identity', () => {
        const root = tempRoot();
        const dir = path.join(root, 'world-parcels/research/qualification-outcomes');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, '2026-02.json'), JSON.stringify({ schemaVersion: 1, cities: [outcome('0042', 'qualified', '2026-02-01')] }));
        writeFileSync(path.join(dir, '2026-01.json'), JSON.stringify({ schemaVersion: 1, cities: [outcome('42', 'held', '2026-01-01')] }));
        writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

        const batches = readIntegrationOutcomeBatches(root);
        expect(batches.map(item => path.basename(item.evidenceFile))).toEqual(['2026-01.json', '2026-02.json']);
        const index = indexIntegrationHistory(batches);
        expect(integrationHistoryForCity({ countryCode: 'AA', wupCityCode: 42 }, index).map(item => item.outcome))
            .toEqual(['qualified', 'held']);
        expect(integrationHistoryForCity({ countryCode: 'BB', wupCityCode: 42 }, index)).toEqual([]);
    });

    it('uses one unambiguous WUP registry ID as fallback, while explicit WUP identity takes precedence', () => {
        const index = indexIntegrationHistory([
            batch('identity.json', [
                outcome(111, 'held', '2026-01-01'),
                outcome(222, 'qualified', '2026-01-02')
            ])
        ]);

        expect(integrationHistoryForCity({ countryCode: 'AA', id: 'registry:alpha', registryCityIds: ['wup2025:111'] }, index))
            .toHaveLength(1);
        expect(integrationHistoryForCity({
            countryCode: 'AA', wupCityCode: 222, id: 'wup2025:111', registryCityIds: ['wup2025:111']
        }, index).map(item => item.outcome)).toEqual(['qualified']);
    });

    it('attaches a mixed WUP and explicit registry identity once to the exact city aliases', () => {
        const index = indexIntegrationHistory([
            batch('mixed-identity.json', [
                { ...outcome(2241, 'held', '2026-10-14T07:39:45Z', { countryCode: 'BJ' }), registryCityId: 'capital:BJ:porto-novo' }
            ])
        ]);
        const porto = {
            id: 'capital:BJ:porto-novo', countryCode: 'BJ', wupCityCode: null,
            registryCityIds: ['capital:BJ:porto-novo']
        };
        const wupCrosswalk = {
            id: 'wup2025:2241', countryCode: 'BJ', wupCityCode: 2241,
            registryCityIds: ['capital:BJ:porto-novo']
        };
        expect(integrationCityKey(porto)).toBe('BJ:registry:capital:BJ:porto-novo');
        expect(integrationCityKeys(wupCrosswalk)).toEqual(['BJ:2241', 'BJ:registry:capital:BJ:porto-novo']);
        const attempts = integrationHistoryForCity(wupCrosswalk, index);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ outcome: 'held', registryCityId: 'capital:BJ:porto-novo' });
    });

    it('accepts registry-only outcomes and never joins by name or provider across countries', () => {
        const index = indexIntegrationHistory([
            batch('registry-only.json', [
                { registryCityId: 'capital:SC:victoria', countryCode: 'SC', cityName: 'Victoria', outcome: 'held', finishedAt: '2026-10-14' },
                { registryCityId: 'capital:BJ:porto-novo', countryCode: 'SC', cityName: 'Porto-Novo', outcome: 'qualified', finishedAt: '2026-10-14', sourceIds: ['shared'] }
            ])
        ]);
        expect(integrationOutcomeKeys({ registryCityId: 'capital:SC:victoria', countryCode: 'SC' }))
            .toEqual(['SC:registry:capital:SC:victoria']);
        expect(integrationHistoryForCity({ id: 'capital:SC:victoria', countryCode: 'SC', registryCityIds: ['capital:SC:victoria'] }, index))
            .toHaveLength(1);
        expect(integrationHistoryForCity({ id: 'capital:BJ:porto-novo', countryCode: 'BJ', registryCityIds: ['capital:BJ:porto-novo'], name: 'Porto-Novo', sourceIds: ['shared'] }, index))
            .toEqual([]);
        expect(() => indexIntegrationHistory([batch('invalid.json', [{ countryCode: 'SC', outcome: 'held' }])]))
            .toThrow(/Invalid city outcome/);
    });

    it('does not join on names or shared source IDs and omits ambiguous WUP fallback IDs', () => {
        const index = indexIntegrationHistory([
            batch('shared.json', [outcome(111, 'held', '2026-01-01', { sourceIds: ['shared-source'], name: 'Same Name' })])
        ]);
        expect(integrationHistoryForCity({ countryCode: 'AA', name: 'Same Name', sourceIds: ['shared-source'] }, index)).toEqual([]);
        expect(integrationHistoryForCity({
            countryCode: 'AA', name: 'Same Name', sourceIds: ['shared-source'],
            registryCityIds: ['wup2025:111', 'wup2025:222']
        }, index)).toEqual([]);
    });

    it('keeps chronological historical failures, uses only finishedAt, and creates safe evidence links', () => {
        const root = tempRoot();
        const dir = path.join(root, 'world-parcels/research/qualification-outcomes');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'outcome latest.json'), JSON.stringify({ schemaVersion: 1, cities: [
            outcome(111, 'qualified', '2026-03-04T10:00:00Z', {
                sourceIds: ['src'], diagnosticsEvidenceFile: 'world-parcels/research/audits/diagnostic one.json'
            }),
            { ...outcome(222, 'held', undefined), generatedAt: '2099-01-01T00:00:00Z' }
        ] }));
        writeFileSync(path.join(dir, 'outcome old.json'), JSON.stringify({ schemaVersion: 1, cities: [
            outcome(111, 'held', '2026-02-01')
        ] }));

        const batches = readIntegrationOutcomeBatches(root);
        const index = indexIntegrationHistory(batches, new Map([['src', 'Survey plots']]));
        const attempts = integrationHistoryForCity({ countryCode: 'AA', wupCityCode: 111 }, index);
        expect(attempts.map(item => [item.outcome, item.checkedAt])).toEqual([
            ['qualified', '2026-03-04T10:00:00Z'], ['held', '2026-02-01']
        ]);
        expect(attempts[0]).toMatchObject({
            sources: [{ id: 'src', name: 'Survey plots' }],
            evidenceUrl: 'https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/world-parcels/research/qualification-outcomes/outcome%20latest.json',
            diagnosticsUrl: 'https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/world-parcels/research/audits/diagnostic%20one.json',
            checkedDateEvidence: {
                date: '2026-03-04',
                field: '$.cities[0].finishedAt'
            }
        });
        const generatedOnly = integrationHistoryForCity({ countryCode: 'AA', wupCityCode: 222 }, index)[0];
        expect(generatedOnly).toMatchObject({ checkedAt: null, checkedDateEvidence: null });

        expect(() => indexIntegrationHistory([
            batch('../outside.json', [outcome(111, 'held', '2026-01-01')])
        ])).toThrow(/Invalid integration evidence path/);
        expect(() => indexIntegrationHistory([
            batch('valid.json', [outcome(111, 'held', '2026-01-01', { diagnosticsEvidenceFile: 'world-parcels/research/../secret.json' })])
        ])).toThrow(/Invalid integration evidence path/);
    });

    it('reports completed checks without treating unchecked outcomes as checks or history as app admission', () => {
        const history = [
            batch('attempts.json', [
                outcome(101, 'held', '2026-02-02'),
                outcome(101, 'qualified', '2026-02-01'),
                outcome(202, 'qualified', '2026-02-03'),
                outcome(303, 'unchecked', '2026-02-04'),
                { ...outcome(404, 'held', undefined), generatedAt: '2099-01-01T00:00:00Z' }
            ])
        ];
        const report = smallReport({
            cities: [
                { id: 'alpha', name: 'Alpha', countryCode: 'AA', wupCityCode: 101, registryCityIds: [], appCityIds: ['app-alpha'] },
                { id: 'beta', name: 'Beta', countryCode: 'AA', wupCityCode: 202, registryCityIds: [], appCityIds: [] },
                { id: 'gamma', name: 'Gamma', countryCode: 'AA', wupCityCode: 303, registryCityIds: [], appCityIds: [] },
                { id: 'delta', name: 'Delta', countryCode: 'AA', wupCityCode: 404, registryCityIds: [], appCityIds: [] }
            ],
            integrationOutcomeBatches: history,
            liveCities: [{ id: 'app-alpha', sourceId: 'src-alpha' }],
            catalogSources: [{ id: 'src-alpha', cityIds: ['app-alpha'] }]
        });
        const rows = Object.fromEntries(report.cities.map(city => [city.name, city]));

        expect(rows.Alpha).toMatchObject({
            checked: true,
            checkedDate: '2026-02-02',
            appCityIds: ['app-alpha'],
            integrationAttempts: [{ outcome: 'held' }, { outcome: 'qualified' }]
        });
        expect(rows.Beta).toMatchObject({ checked: true, checkedDate: '2026-02-03', appCityIds: [], registryFound: null });
        expect(rows.Gamma).toMatchObject({ checked: false, checkedDate: null, integrationAttempts: [{ outcome: 'unchecked' }] });
        expect(rows.Delta).toMatchObject({ checked: true, checkedDate: null, checkedDateEvidence: null });
        expect(report.metadata.checkedCitiesMissingDate).toBe(1);
    });

    it('adds absent failed candidates once by country and WUP code with newest history and no app or population admission', () => {
        const oldAttempt = batch('absent-city-old.json', [
            { cityCode: 707, countryCode: 'AA', cityName: 'Unlisted City', point: [12.25, 34.5], sourceIds: ['shared'],
                outcome: 'held', summary: 'First attempt failed.', finishedAt: '2026-02-01T10:00:00Z' }
        ]);
        const laterAttempt = batch('absent-city-later.json', [
            { cityCode: '0707', countryCode: 'AA', cityName: 'Unlisted City', point: [12.25, 34.5], sourceIds: ['shared'],
                outcome: 'held', summary: 'A later retry also failed.', finishedAt: '2026-02-05T10:00:00Z' }
        ]);
        const report = smallReport({
            cities: [],
            integrationOutcomeBatches: [laterAttempt, oldAttempt]
        });
        const sameCountryRows = report.cities.filter(city => city.countryCode === 'AA' && city.wupCityCode === 707);
        expect(sameCountryRows).toHaveLength(1);
        expect(sameCountryRows[0]).toMatchObject({
            name: 'Unlisted City',
            countryCode: 'AA',
            wupCityCode: 707,
            latitude: 12.25,
            longitude: 34.5,
            checked: true,
            checkedDate: '2026-02-05',
            appCityIds: [],
            population2015: null,
            population2025: null,
            annualGrowthPct2015To2025: null,
            integrationAttempts: [
                { outcome: 'held', summary: 'A later retry also failed.', checkedAt: '2026-02-05T10:00:00Z' },
                { outcome: 'held', summary: 'First attempt failed.', checkedAt: '2026-02-01T10:00:00Z' }
            ]
        });
    });

    it('does not append a WUP duplicate when an existing capital row matches the explicit registry alias', () => {
        const report = smallReport({
            cities: [{
                id: 'capital:BJ:porto-novo', name: 'Porto-Novo', countryCode: 'BJ',
                wupCityCode: null, latitude: 6.4969, longitude: 2.6289,
                registryCityIds: ['capital:BJ:porto-novo'], appCityIds: [], cohorts: ['capital']
            }],
            countryCodes: ['BJ'],
            integrationOutcomeBatches: [batch('porto.json', [
                { cityCode: 2241, registryCityId: 'capital:BJ:porto-novo', cityName: 'Porto-Novo', countryCode: 'BJ',
                    point: [6.50766879735021, 2.62222651952885], outcome: 'held', finishedAt: '2026-10-14T07:39:45Z' }
            ])]
        });
        const portoRows = report.cities.filter(city => city.countryCode === 'BJ' && city.name === 'Porto-Novo');
        expect(portoRows).toHaveLength(1);
        expect(portoRows[0]).toMatchObject({
            id: 'capital:BJ:porto-novo', wupCityCode: null,
            integrationAttempts: [{ outcome: 'held', registryCityId: 'capital:BJ:porto-novo' }]
        });
    });

    it('adds registry-only city outcomes without inventing a WUP code', () => {
        const report = smallReport({
            cities: [], countryCodes: ['SC'],
            integrationOutcomeBatches: [batch('victoria.json', [
                { registryCityId: 'capital:SC:victoria', cityName: 'Victoria', countryCode: 'SC',
                    point: [-4.6191, 55.4513], outcome: 'held', finishedAt: '2026-10-14T08:00:00Z' }
            ])]
        });
        const victoria = report.cities.find(city => city.id === 'capital:SC:victoria');
        expect(victoria).toMatchObject({
            wupCityCode: null, registryCityIds: ['capital:SC:victoria'],
            latitude: -4.6191, longitude: 55.4513,
            integrationAttempts: [{ outcome: 'held', registryCityId: 'capital:SC:victoria' }]
        });
        expect(report.cities.some(city => city.id === 'wup2025:undefined')).toBe(false);
    });
});
