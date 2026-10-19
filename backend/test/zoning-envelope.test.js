// Synthetic reviews exercise the evidence gate; they do not verify the real
// properties sharing these BBLs. Network requests are replaced in these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { computeEnvelope } from '../zoning/envelope.js';
import { getDistrictRules, RULE_VERSION } from '../zoning/districts.js';
import { screenPluto, validateReview, inputFingerprint, REVIEW_REQUIREMENTS } from '../zoning/eligibility.js';
import { calculateR6aEnvelope } from '../zoning/r6a-geometry.js';
import { fetchPluto, normalizePlutoRow, toPlutoBbl, __clearCache } from '../zoning/pluto.js';
import { setupParcelNycRoute } from '../routes/parcel-nyc.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

const AS_OF = '2026-10-19';
const rawRow = (overrides = {}) => ({
    bbl: '3016010012.00000000', address: 'SYNTHETIC TEST LOT', borough: 'BK', cd: '303', version: '26v2',
    zonedist1: 'R6A', residfar: '3', affresfar: '3.9',
    lotarea: '2000', lotfront: '20', lotdepth: '100', lottype: '5', irrlotcode: false,
    bldgarea: '4320', numfloors: '3', splitzone: false, ...overrides,
});
const plutoRow = (overrides = {}) => ({ ...normalizePlutoRow(rawRow()), ...overrides });
const reviewFor = row => ({
    bbl: row.bbl, ruleVersion: RULE_VERSION, inputFingerprint: inputFingerprint(row),
    checkedOn: '2026-10-19', validThrough: '2026-10-31',
    site: { widthFt: 20, depthFt: 100, streetWidthFt: 60 },
    checks: Object.fromEntries(Object.keys(REVIEW_REQUIREMENTS).map(key => [key, {
        status: 'verified', note: 'Synthetic test evidence only.', sources: [`https://example.org/synthetic/${key}`],
    }])),
});
const response = rows => ({ ok: true, json: async () => rows });

describe('R6A rule path', () => {
    it('uses current standard rules and restricts supported districts', () => {
        expect(getDistrictRules(' r6a ')).toMatchObject({ residentialFar: 3, maxBaseHeightFt: 65, maxBuildingHeightFt: 75, maxLotCoverage: 0.8 });
        expect(getDistrictRules('R6B')).toBeNull();
        expect(getDistrictRules('R8')).toBeNull();
    });
    it('constructs two volumes and a separate FAR budget', () => {
        const result = calculateR6aEnvelope({ widthFt: 20, depthFt: 100, streetWidthFt: 60 });
        expect(result.floorAreaBudgetSqFt).toBe(6000);
        expect(result.maxLotCoverageAreaSqFt).toBe(1600);
        expect(result.geometry.tiers).toEqual([
            { bottomFt: 0, topFt: 65, footprint: [[0, 0], [20, 0], [20, 70], [0, 70], [0, 0]], footprintAreaSqFt: 1400 },
            { bottomFt: 65, topFt: 75, footprint: [[0, 15], [20, 15], [20, 70], [0, 70], [0, 15]], footprintAreaSqFt: 1100 },
        ]);
        expect(result).not.toHaveProperty('unusedFloorArea');
        expect(result).not.toHaveProperty('approxMaxFloors');
    });
    it('switches setback at the legal wide-street boundary', () => {
        expect(calculateR6aEnvelope({ widthFt: 25, depthFt: 100, streetWidthFt: 74.99 }).upperSetbackFt).toBe(15);
        expect(calculateR6aEnvelope({ widthFt: 25, depthFt: 100, streetWidthFt: 75 }).upperSetbackFt).toBe(10);
    });
    it.each([
        { widthFt: null }, { widthFt: '20' }, { widthFt: 40 }, { widthFt: 17.9 },
        { depthFt: 94.9 }, { depthFt: 110.1 }, { streetWidthFt: NaN }, { streetWidthFt: 0 },
    ])('rejects missing or out-of-tier geometric input %j', override => {
        expect(() => calculateR6aEnvelope({ widthFt: 20, depthFt: 100, streetWidthFt: 60, ...override })).toThrow(RangeError);
    });
});

describe('PLUTO screening and review', () => {
    it('treats a clean record as a candidate, never verified capacity', () => {
        const env = computeEnvelope(plutoRow());
        expect(env.status).toBe('needs-review');
        expect(env.screening.status).toBe('candidate');
        expect(env.result).toBeNull();
        expect(env.review.pending.map(p => p.code)).toContain('zoningLotAndRights');
        expect(env.referenceRules.maxBuildingHeightFt).toBe(75);
        expect(env).not.toHaveProperty('supported');
        expect(env).not.toHaveProperty('maxFloorArea');
    });
    it.each([
        ['zonedist1', 'R6B', 'district'], ['zonedist2', 'R6A', 'multiple-districts'],
        ['zonedist3', 'R5', 'multiple-districts'], ['zonedist4', 'R5', 'multiple-districts'],
        ['splitZone', true, 'split-zone'], ['overlay2', 'C2-4', 'overlay'],
        ['spdist2', 'MX', 'special-district'], ['spdist3', 'J', 'special-district'],
        ['limitedHeight', 'LH-1', 'limited-height'], ['historicDistrict', 'Example historic district', 'historic'],
        ['landmark', 'Individual landmark', 'historic'], ['eDesignation', 'E-123', 'environmental'],
        ['flood2015', true, 'flood'], ['lotType', '3', 'lot-type'], ['irregularLot', true, 'irregular-lot'],
        ['lotFront', 40, 'dimensions-outside-tier'], ['communityDistrict', '308', 'geography'],
    ])('excludes %s=%s even with an otherwise complete review', (field, value, code) => {
        const row = plutoRow({ [field]: value });
        const env = computeEnvelope(row, reviewFor(row), { asOf: AS_OF });
        expect(env.status).toBe('outside-scope');
        expect(env.result).toBeNull();
        expect(env.screening.issues.some(i => i.code === code)).toBe(true);
    });
    it.each([
        ['splitZone', null, 'split-zone'], ['irregularLot', null, 'irregular-lot'],
        ['lotArea', null, 'dimensions-missing'], ['lotFront', NaN, 'dimensions-missing'],
        ['lotArea', 2200, 'dimension-conflict'], ['residFar', 3.9, 'far-conflict'], ['version', null, 'source-version'],
    ])('requires evidence for %s=%s', (field, value, code) => {
        const screened = screenPluto(plutoRow({ [field]: value }));
        expect(screened.status).toBe('needs-data');
        expect(screened.issues.some(i => i.code === code)).toBe(true);
    });
    it('publishes calculation only after all evidence checks pass', () => {
        const row = plutoRow();
        const env = computeEnvelope(row, reviewFor(row), { asOf: AS_OF });
        expect(env.status).toBe('modeled');
        expect(env.review.valid).toBe(true);
        expect(env.review.pending).toEqual([]);
        expect(env.result.floorAreaBudgetSqFt).toBe(6000);
        expect(env.result.maxBuildingHeightFt).toBe(75);
        expect(env.review.checks.zoningLotAndRights.sources).toHaveLength(1);
    });
    it.each(Object.keys(REVIEW_REQUIREMENTS))('cannot bypass %s evidence', key => {
        const row = plutoRow(); const review = reviewFor(row);
        delete review.checks[key];
        const env = computeEnvelope(row, review, { asOf: AS_OF });
        expect(env.status).toBe('needs-review');
        expect(env.result).toBeNull();
        expect(env.review.pending.map(p => p.code)).toContain(key);
    });
    it.each([
        { checkedOn: '2026-10-20' }, { validThrough: '2026-10-18' }, { checkedOn: '2026-02-30' },
        { checkedOn: null }, { validThrough: null }, { bbl: '3016010013' }, { ruleVersion: 'old-rules' },
        { inputFingerprint: 'mismatch' }, { site: { widthFt: 30, depthFt: 100, streetWidthFt: 60 } },
        { site: { widthFt: 20, depthFt: 100, streetWidthFt: null } },
    ])('invalidates stale, mismatched or incomplete review %j', override => {
        const row = plutoRow();
        expect(computeEnvelope(row, { ...reviewFor(row), ...override }, { asOf: AS_OF }).result).toBeNull();
    });
    it('rejects evidence without a source reference or explanatory note', () => {
        const row = plutoRow(); const review = reviewFor(row);
        review.checks.survey.sources = [];
        review.checks.siteActions.note = 1;
        expect(validateReview(row, review, { asOf: AS_OF }).pending).toEqual(['survey', 'siteActions']);
    });
    it('invalidates evidence when the PLUTO snapshot changes', () => {
        const row = plutoRow(); const review = reviewFor(row);
        expect(computeEnvelope({ ...row, version: '26v3' }, review, { asOf: AS_OF }).result).toBeNull();
        expect(inputFingerprint(Object.fromEntries(Object.entries(row).reverse()))).toBe(inputFingerprint(row));
    });
    it('returns null when there is no record', () => expect(computeEnvelope(null)).toBeNull());
});

describe('PLUTO input boundary', () => {
    beforeEach(() => __clearCache());
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    it.each([
        ['3016010012', '3016010012'], ['6201001005527502', '1005527502'],
        ['US-NY-6201001005527502', '1005527502'], ['nonsense', null],
    ])('normalizes BBL %s', (value, expected) => expect(toPlutoBbl(value)).toBe(expected));
    it('keeps missing booleans unknown and rejects partial numeric strings', () => {
        const row = normalizePlutoRow(rawRow({ splitzone: undefined, irrlotcode: undefined, lotarea: '2000oops', lotfront: '', lotdepth: null }));
        expect(row).toMatchObject({ splitZone: null, irregularLot: null, lotArea: null, lotFront: null, lotDepth: null, flood2007: null });
    });
    it.each([false, 'false', 'N', '0', 0])('accepts explicit negative flags %s', value => {
        expect(normalizePlutoRow(rawRow({ splitzone: value })).splitZone).toBe(false);
    });
    it('fetches all screening fields and caches repeated BBL lookups', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response([rawRow()]));
        const row = await fetchPluto('3016010012', { env: {}, fetchImpl });
        expect(row).toMatchObject({ bbl: '3016010012', residFar: 3, splitZone: false, irregularLot: false, version: '26v2' });
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.searchParams.get('$select').split(',')).toEqual(expect.arrayContaining(['spdist3', 'ltdheight', 'histdist', 'irrlotcode', 'version']));
        await fetchPluto('3016010012', { env: {}, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it.each([
        { rows: [rawRow(), rawRow()] }, { rows: [{ ...rawRow(), bbl: '3016010013' }] }, { rows: { error: 'failed' } },
    ])('rejects ambiguous or malformed responses', async ({ rows }) => {
        await expect(fetchPluto('3016010012', { env: {}, fetchImpl: async () => response(rows) })).rejects.toThrow();
    });
    it('does not cache a failed request as missing', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response([rawRow()]));
        await expect(fetchPluto('3016010012', { env: {}, fetchImpl })).rejects.toThrow('503');
        expect(await fetchPluto('3016010012', { env: {}, fetchImpl })).not.toBeNull();
    });
});

describe('GET /parcel-nyc/:parcelId/envelope', () => {
    let app;
    beforeEach(() => { __clearCache(); app = createRouteApp(setupParcelNycRoute, createMockPool()); });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    const stubFetch = rows => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(rows)));
    it('returns requirements and does not let a request assert verification', async () => {
        stubFetch([rawRow()]);
        const res = await request(app).get('/parcel-nyc/3016010012/envelope?verified=true&supported=true');
        expect(res.status).toBe(200);
        expect(res.body.bbl).toBe('3016010012');
        expect(res.body.envelope).toMatchObject({ schemaVersion: 2, status: 'needs-review', result: null });
        expect(res.body.envelope.review.pending.map(p => p.code)).toContain('survey');
    });
    it('404s when PLUTO has no record', async () => {
        stubFetch([]);
        expect((await request(app).get('/parcel-nyc/1005527502/envelope')).status).toBe(404);
    });
    it('400s on an invalid parcel id', async () => {
        expect((await request(app).get('/parcel-nyc/%20%20/envelope')).status).toBe(400);
    });
});
