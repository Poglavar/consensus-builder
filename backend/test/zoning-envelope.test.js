import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { computeEnvelope } from '../zoning/envelope.js';
import { getDistrictRules, isContextualDistrict } from '../zoning/districts.js';
import { fetchPluto, toPlutoBbl, __clearCache } from '../zoning/pluto.js';
import { setupParcelNycRoute } from '../routes/parcel-nyc.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

// Minimal normalized-PLUTO fixture; override per case.
function plutoRow(overrides = {}) {
    return {
        bbl: '4006260077', address: '30-80 35 STREET',
        zonedist1: 'R6A', zonedist2: null, spdist1: null,
        overlay1: null, overlay2: null,
        residFar: 3, commFar: 0, facilFar: 3, affResFar: 3.9,
        lotArea: 2000, lotFront: 20, lotDepth: 100, lotType: '5',
        numFloors: 3, bldgArea: 4320, builtFar: 2.16, bldgClass: 'C0', landUse: '02',
        yearBuilt: 1931, splitZone: false,
        ...overrides,
    };
}

describe('district rules table', () => {
    it('returns hard height caps for a contextual district', () => {
        expect(getDistrictRules('R6A')).toMatchObject({ maxBuildingHeight: 70, maxBaseHeight: 60 });
        expect(isContextualDistrict('r6a')).toBe(true); // case-insensitive
    });

    it('returns null for non-contextual / unknown districts', () => {
        expect(getDistrictRules('R7-2')).toBeNull();
        expect(getDistrictRules('R8')).toBeNull();
        expect(getDistrictRules('BPC')).toBeNull();
        expect(isContextualDistrict('R7-2')).toBe(false);
    });
});

describe('computeEnvelope', () => {
    it('computes a full envelope for a clean contextual lot', () => {
        const env = computeEnvelope(plutoRow());
        expect(env.supported).toBe(true);
        expect(env.maxFloorArea).toBe(6000);           // FAR 3 * 2000
        expect(env.maxFloorAreaAffordable).toBe(7800); // FAR 3.9 * 2000
        expect(env.maxHeightFt).toBe(70);
        expect(env.approxMaxFloors).toBe(7);           // 70 / 10
        expect(env.bindingConstraint).toBe('FAR');     // 4 FAR-floors < 7 height-floors
        expect(env.unusedFloorArea).toBe(1680);        // 6000 - 4320
        expect(env.caveats).toHaveLength(0);
    });

    it('falls back to FAR-only for non-contextual districts', () => {
        const env = computeEnvelope(plutoRow({ zonedist1: 'R8', residFar: 6.02, affResFar: 7.2, lotArea: 10250, bldgArea: 37960 }));
        expect(env.supported).toBe(false);
        expect(env.maxFloorArea).toBe(61705);
        expect(env.maxHeightFt).toBeNull();            // no fabricated height
        expect(env.approxMaxFloors).toBeNull();
        expect(env.caveats[0]).toMatch(/non-contextual/);
    });

    it('flags split-zone lots as unsupported', () => {
        const env = computeEnvelope(plutoRow({ splitZone: true }));
        expect(env.supported).toBe(false);
        expect(env.caveats.some(c => /split-zone/.test(c))).toBe(true);
    });

    it('flags special-district lots as unsupported', () => {
        const env = computeEnvelope(plutoRow({ spdist1: 'J' }));
        expect(env.supported).toBe(false);
        expect(env.caveats.some(c => /special district J/.test(c))).toBe(true);
    });

    it('never reports negative unused floor area for an overbuilt lot', () => {
        const env = computeEnvelope(plutoRow({ bldgArea: 8094, residFar: 3.44, lotArea: 2144 }));
        expect(env.unusedFloorArea).toBe(0);
    });

    it('returns null for a missing lot', () => {
        expect(computeEnvelope(null)).toBeNull();
    });
});

describe('toPlutoBbl', () => {
    it('builds the 10-digit BBL from a 10-digit sbl', () => {
        expect(toPlutoBbl('1005527502')).toBe('1005527502');
    });
    it('strips the SWIS prefix and the US-NY- prefix', () => {
        expect(toPlutoBbl('6201001005527502')).toBe('1005527502');
        expect(toPlutoBbl('US-NY-6201001005527502')).toBe('1005527502');
    });
    it('returns null for an unparseable id', () => {
        expect(toPlutoBbl('nonsense')).toBeNull();
    });
});

describe('fetchPluto', () => {
    beforeEach(() => __clearCache());
    afterEach(() => vi.restoreAllMocks());

    function socrataResponse(rows) {
        return { ok: true, json: async () => rows, text: async () => '' };
    }

    it('fetches by BBL and normalizes the row', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(socrataResponse([{
            bbl: '4006260077.00000000', address: '30-80 35 STREET', zonedist1: 'R6A',
            residfar: '3.00000000000', affresfar: '3.90000000000', lotarea: '2000',
            splitzone: false, numfloors: '3.0000000',
        }]));
        const row = await fetchPluto('4006260077', { env: {}, fetchImpl });
        expect(row.bbl).toBe('4006260077');
        expect(row.residFar).toBe(3);
        expect(row.affResFar).toBe(3.9);
        expect(row.splitZone).toBe(false);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toContain('bbl=4006260077');
    });

    it('caches so a repeat lookup does not re-hit Socrata', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(socrataResponse([{ bbl: '4006260077', zonedist1: 'R6A', lotarea: '2000' }]));
        await fetchPluto('4006260077', { env: {}, fetchImpl });
        await fetchPluto('4006260077', { env: {}, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('returns null when PLUTO has no such lot', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(socrataResponse([]));
        expect(await fetchPluto('1005527502', { env: {}, fetchImpl })).toBeNull();
    });
});

describe('GET /parcel-nyc/:parcelId/envelope', () => {
    let app;
    beforeEach(() => { __clearCache(); app = createRouteApp(setupParcelNycRoute, createMockPool()); });
    afterEach(() => vi.restoreAllMocks());

    function stubFetch(rows) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows, text: async () => '' }));
    }

    it('returns an envelope for a valid parcel id', async () => {
        stubFetch([{ bbl: '4006260077', address: '30-80 35 STREET', zonedist1: 'R6A', residfar: '3', affresfar: '3.9', lotarea: '2000', bldgarea: '4320', numfloors: '3', splitzone: false }]);
        const res = await request(app).get('/parcel-nyc/US-NY-6224004006260077/envelope'); // US-NY- + 16-digit swis_sbl_id
        expect(res.status).toBe(200);
        expect(res.body.bbl).toBe('4006260077');
        expect(res.body.envelope.supported).toBe(true);
        expect(res.body.envelope.maxFloorArea).toBe(6000);
        expect(res.body.envelope.maxHeightFt).toBe(70);
        expect(res.body.envelope.disclaimer).toMatch(/As-of-right/);
    });

    it('404s when PLUTO has no record', async () => {
        stubFetch([]);
        const res = await request(app).get('/parcel-nyc/1005527502/envelope');
        expect(res.status).toBe(404);
    });

    it('400s on an invalid parcel id', async () => {
        const res = await request(app).get('/parcel-nyc/%20%20/envelope');
        expect(res.status).toBe(400);
    });
});
