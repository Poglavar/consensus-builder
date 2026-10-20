import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAdmissionPlanSummary, collectLiveCityCodes, currencyFor, sourceActivationDecision, validateCountryConfig, verifyAdmissionEvidence } from '../admit-qualified-cities.mjs';

const temporaryDirectories = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function evidenceFixture(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-admission-policy-'));
    temporaryDirectories.push(directory);
    const source = { id: 'fixture-source', adapter: 'geojson-snapshot', endpoint: 'https://example.test/parcels.geojson',
        idPrefix: 'FIX-', identityKind: 'native-id' };
    const candidate = { descriptor: { ...source }, city: { code: '100', name: 'Fixture City', point: [36, -1] },
        sampleIds: ['FIX-1'], sourceClassification: { isParcel: true, evidence: ['Published cadastral parcel layer.'] } };
    const candidateBytes = Buffer.from(JSON.stringify(candidate));
    const feature = { type: 'Feature', id: 'FIX-1', properties: { parcelId: 'FIX-1', sourceId: source.id, sourceParcelId: '1' },
        geometry: { type: 'Polygon', coordinates: [[[36, -1], [36.001, -1], [36.001, -1.001], [36, -1]]] } };
    const cacheBytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [feature] }));
    const cacheSha256 = sha256(cacheBytes);
    const checks = { classification: { passed: true }, exactIds: { passed: true }, stableGeometry: { passed: true },
        explicitAbsence: { passed: false, reason: 'No explicit absence test.' },
        sampling: { passed: true }, completeness: { passed: false }, binding: { passed: true },
        metric: { passed: true, metricCrs: 'EPSG:32736' }, alignment: { passed: true } };
    const qualification = { schemaVersion: 1, status: 'technical-qualified', sourceId: source.id, cityCode: '100',
        candidateSha256: sha256(candidateBytes), cacheSha256, featureCount: 1, checks, failures: {} };
    const metric = { inputSha256: cacheSha256, metricCrs: 'EPSG:32736', featureCount: 1 };
    const independent = { inputSha256: cacheSha256, geometryChangedOrRepaired: false, geometryPass: false,
        invalidCount: 1, overlapPairCount: 2 };
    const write = (name, value) => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value));
        return file;
    };
    const evidence = { candidate: write('candidate.json', candidateBytes), qualification: write('qualification.json', qualification),
        metric: write('metric.json', metric), independent: write('independent.json', independent), cache: write('cache.geojson', cacheBytes) };
    Object.assign(evidence, overrides.evidence || {});
    if (overrides.candidate) {
        Object.assign(candidate, overrides.candidate);
        const changedCandidate = Buffer.from(JSON.stringify(candidate));
        fs.writeFileSync(evidence.candidate, changedCandidate);
        qualification.candidateSha256 = sha256(changedCandidate);
    }
    if (overrides.checks) Object.assign(checks, overrides.checks);
    if (overrides.qualification) Object.assign(qualification, overrides.qualification);
    fs.writeFileSync(evidence.qualification, JSON.stringify(qualification));
    return { directory, candidate, source, evidence, qualification, checks };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('admission country configuration', () => {
    it('accepts a matching ISO country, valid locale, and supported ISO currency', () => {
        expect(validateCountryConfig({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } }, 'KE'))
            .toEqual({ countryCode: 'KE', currency: { locale: 'sw-KE', code: 'KES' } });
        expect(validateCountryConfig({ countryCode: 'ET', currency: { locale: 'am-ET', code: 'ETB' } }, 'ET'))
            .toEqual({ countryCode: 'ET', currency: { locale: 'am-ET', code: 'ETB' } });
        expect(currencyFor('ET', null)).toEqual({ locale: 'am-ET', code: 'ETB' });
    });

    it('rejects missing or mismatched country metadata', () => {
        expect(() => validateCountryConfig({ currency: { locale: 'en-KE', code: 'KES' } })).toThrow(/countryCode/);
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'en-KE', code: 'KES' } }, 'TZ'))
            .toThrow(/match/);
    });

    it('rejects invalid locales and non-ISO currency codes', () => {
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'not a locale', code: 'KES' } })).toThrow(/locale/);
        expect(() => validateCountryConfig({ countryCode: 'KE', currency: { locale: 'en-KE', code: 'ZZZ' } })).toThrow(/ISO-4217/);
    });

    it('does not treat unknown two-letter codes as ISO countries', () => {
        expect(() => validateCountryConfig({ countryCode: 'ZZ', currency: { locale: 'en', code: 'USD' } })).toThrow(/ISO-3166/);
    });
});

describe('qualified source activation policy', () => {
    it('promotes only a newly qualified candidate into its admitted default scope', () => {
        const candidate = { id: 'new-source', defaultForCity: false, cityIds: ['wup2025:6353'] };
        const { eligible, descriptor, activation } = sourceActivationDecision(candidate);
        expect(eligible).toBe(true);
        expect(descriptor).toMatchObject({ id: candidate.id, defaultForCity: true, cityIds: [] });
        expect(candidate).toMatchObject({ defaultForCity: false, cityIds: ['wup2025:6353'] });
        expect(activation).toMatchObject({ policy: 'newly_qualified_city_default', defaultForCity: true,
            scope: 'admitted_city_ids', candidateDefaultForCity: false });
    });

    it('does not promote a source that is already cataloged as opt-in', () => {
        const existing = { id: 'existing-opt-in', defaultForCity: false, cityIds: ['ljubljana'] };
        const decision = sourceActivationDecision({ id: existing.id }, existing);
        expect(decision.eligible).toBe(false);
        expect(decision.descriptor).toBe(existing);
        expect(existing.defaultForCity).toBe(false);
    });
});

describe('admission plan summary', () => {
    it('serializes accepted, refused and skipped requested codes with explicit outcome reasons', () => {
        const reviewPath = path.join(os.tmpdir(), 'parcel-review', 'review.json');
        const initialQualificationReview = { policy: 'parcel-availability-v1', evidencePath: reviewPath };
        const plan = [{ code: '101', appCityId: 'example_city', name: 'Example City', countryCode: 'EX',
            descriptor: { id: 'example-source' }, qualification: { candidateSha256: 'candidate-hash', cacheSha256: 'cache-hash' },
            qualificationSha256: 'qualification-hash', initialQualificationReview }];
        const refused = [{ code: '102', name: 'Refused City', reason: 'cache evidence is invalid' }];
        const outcomes = new Map([['101', { outcome: 'qualified' }], ['102', { outcome: 'qualified' }],
            ['103', { outcome: 'qualified' }], ['104', { outcome: 'failed' }]]);
        const summary = buildAdmissionPlanSummary(plan, refused, ['101', '102', '103', '104', '105'], outcomes,
            new Set(['103']), '2026-10-19-test', '2026-10-19T12:00:00.000Z');

        expect(summary).toMatchObject({ schemaVersion: 1, release: '2026-10-19-test', plannedAtUtc: '2026-10-19T12:00:00.000Z',
            requestedCodes: ['101', '102', '103', '104', '105'], refused: [{ code: '102', name: 'Refused City', reason: 'cache evidence is invalid' }],
            skipped: [
                { cityCode: '103', reason: 'city is already live or previously admitted' },
                { cityCode: '104', reason: 'latest qualification outcome is failed' },
                { cityCode: '105', reason: 'no qualification outcome is recorded in the selected outcomes' }
            ] });
        expect(summary.accepted[0]).toMatchObject({ cityCode: '101', appCityId: 'example_city', cityName: 'Example City',
            countryCode: 'EX', sourceId: 'example-source', candidateSha256: 'candidate-hash', cacheSha256: 'cache-hash',
            qualificationSha256: 'qualification-hash', initialQualificationReview: { policy: 'parcel-availability-v1', evidencePath: 'review.json' } });
        expect(JSON.stringify(summary)).not.toContain(reviewPath);
    });

    it('keeps the requested code field null when no code filter was supplied', () => {
        expect(buildAdmissionPlanSummary([], [], null, new Map(), new Set(), '2026-10-19-test', 'now').requestedCodes).toBeNull();
    });
});

describe('live city detection', () => {
    it('uses configured WUP codes and bound coverage rows, ignoring stale app IDs', () => {
        const live = collectLiveCityCodes([{ wupCityCode: '101' }, { wupCityCode: undefined }], new Set(['configured_city']), {
            cities: [
                { wupCityCode: 102, appCityIds: ['configured_city'] },
                { wupCityCode: 103, appCityIds: ['stale_city'] },
            ]
        });
        expect(live).toEqual(new Set(['101', '102']));
    });
});

describe('initial parcel availability admission policy', () => {
    it('accepts schema-1 parcel evidence with core checks and records missing alignment and metric quality follow-up', () => {
        const fixture = evidenceFixture();
        const result = verifyAdmissionEvidence(fixture.evidence, fixture.source);
        expect(typeof result).toBe('object');
        expect(result.initialQualificationReview).toMatchObject({ policy: 'parcel-availability-v1', status: 'follow-up-required' });
        expect(result.initialQualificationReview.requiredChecks).toEqual(['classification', 'exactIds', 'stableGeometry']);
        expect(result.initialQualificationReview.followUp.map(item => item.check)).toContain('alignment');
        expect(result.initialQualificationReview.followUp.map(item => item.check)).toContain('metric');
        expect(result.checks.alignment.passed).toBe(false);
        expect(result.checks.metric.passed).toBe(false);
    });

    it('rejects non-parcel classification and a failed exact-ID read', () => {
        const nonParcel = evidenceFixture({ candidate: { sourceClassification: { isParcel: false, evidence: ['Map index only.'] } } });
        expect(verifyAdmissionEvidence(nonParcel.evidence, nonParcel.source)).toMatch(/positive parcel classification/);
        const failedRead = evidenceFixture({ checks: { exactIds: { passed: false, reason: 'Known ID was not returned.' } } });
        expect(verifyAdmissionEvidence(failedRead.evidence, failedRead.source)).toMatch(/core check failed/);
    });

    it('rejects a cache whose bytes no longer match the qualification hash', () => {
        const fixture = evidenceFixture();
        fs.appendFileSync(fixture.evidence.cache, ' ');
        expect(verifyAdmissionEvidence(fixture.evidence, fixture.source)).toMatch(/cache bytes differ/);
    });

    it('does not claim alignment passed when its artifact bundle is incomplete', () => {
        const fixture = evidenceFixture();
        fixture.evidence.alignment = path.join(fixture.directory, 'alignment-report.json');
        fs.writeFileSync(fixture.evidence.alignment, JSON.stringify({ passed: true }));
        const result = verifyAdmissionEvidence(fixture.evidence, fixture.source);
        expect(result.checks.alignment.passed).toBe(false);
        expect(result.alignment).toBeNull();
        expect(result.initialQualificationReview.followUp.some(item => item.check === 'alignment')).toBe(true);
    });

    it('imports hash-bound producer follow-up and independently restores missing alignment warnings', () => {
        const fixture = evidenceFixture({ checks: { explicitAbsence: { passed: true } } });
        const qualificationBytes = fs.readFileSync(fixture.evidence.qualification);
        const review = { policy: 'parcel-availability-v1', passed: true, followUp: [{ check: 'explicitAbsence', reason: 'Producer marked this for the second pass.' },
            { check: 'sourceCurrentness', reason: 'Saved source snapshot needs a second-pass freshness check.' }],
            candidateSha256: sha256(fs.readFileSync(fixture.evidence.candidate)),
            qualificationSha256: sha256(qualificationBytes), cacheSha256: fixture.qualification.cacheSha256 };
        fixture.evidence.initialReview = path.join(fixture.directory, 'initial-review.json');
        fs.writeFileSync(fixture.evidence.initialReview, JSON.stringify(review));

        const result = verifyAdmissionEvidence(fixture.evidence, fixture.source);
        expect(result.producerInitialReview).toEqual(review);
        expect(result.initialQualificationReview.followUp).toContainEqual({ check: 'explicitAbsence', reason: 'Producer marked this for the second pass.' });
        expect(result.initialQualificationReview.followUp).toContainEqual({ check: 'sourceCurrentness', reason: 'Saved source snapshot needs a second-pass freshness check.' });
        expect(result.initialQualificationReview.followUp.some(item => item.check === 'alignment')).toBe(true);

        review.candidateSha256 = 'stale';
        fs.writeFileSync(fixture.evidence.initialReview, JSON.stringify(review));
        const stale = verifyAdmissionEvidence(fixture.evidence, fixture.source);
        expect(stale.producerInitialReview).toBeNull();
        expect(stale.initialQualificationReview.followUp.some(item => item.check === 'alignment')).toBe(true);
    });
});
