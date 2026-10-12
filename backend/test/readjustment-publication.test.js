// Publication must reject structurally invalid LR deals and compute the same commitment as review.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { validProposalBody, insertResult, updateResult } from './helpers/fixtures.js';
import { serializeProposalRow } from '../proposals/serializer.js';
import { memberHash } from '../plans/plan-hash.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({ generateAndStoreProposalThumbnail: vi.fn(async () => null) }));
const require = createRequire(import.meta.url);
const deal = require('../../frontend/js/reparcellization-deal.js');
const geometry = { type: 'Polygon', coordinates: [[[1, 1], [1.001, 1], [1.001, 1.001], [1, 1.001], [1, 1]]] };
function proposal() {
    return validProposalBody({
        goal: 'reparcellization', type: 'reparcellization', offer: 12.34, offerCurrency: 'EUR',
        reparcellization: { poolGeometry: geometry, poolUnitValue: 10,
            polygons: [{ geometry, percent: 100, owners: [{ ownerKey: 'a', share: 0.6 }, { ownerKey: 'b', share: 0.4 }] }],
            ownerShares: [{ ownerKey: 'a', cashOffer: 12.34 }, { ownerKey: 'b', cashOffer: 0 }] }
    });
}
function appFixture() {
    const pool = createMockPool();
    pool.setResults([insertResult(), updateResult()]);
    return { pool, app: createTestApp(pool) };
}

describe('LR publication commitment', () => {
    it('recomputes a forged uploader hash, ignores approval claims, and survives server normalization and GET', async () => {
        const { pool, app } = appFixture();
        const body = proposal();
        body.decayEnabled = true;
        body.decayDurationMs = 86400000;
        const expected = deal.fingerprint(body);
        body.effectHash = 'lr1-sha256:forged';
        body.acceptedParcelIds = body.cadastreParcelIds;
        const res = await request(app).post('/proposals').send(body);
        expect(res.status).toBe(201);
        const params = pool.getCalls()[0].params;
        const stored = JSON.parse(params[32]);
        expect(stored.effectHash).toBe(expected);
        expect(stored).not.toHaveProperty('acceptedParcelIds');
        expect(stored.reparcellization.source).toBe('server');
        const row = {
            id: 1, proposal_id: body.proposalId, type: 'reparcellization', goal: body.goal,
            cadastre_parcel_ids: body.cadastreParcelIds, reparcellization: stored.reparcellization,
            offer: '12.34000000', offer_currency: 'EUR', proposal_data: stored,
            decay_duration_ms: '86400000'
        };
        expect(deal.fingerprint(serializeProposalRow(row))).toBe(expected);
        expect(memberHash(row)).toBe(expected);
    });

    it('accepts the browser upload, which carries the full-length prefixed fingerprint', async () => {
        const { app } = appFixture();
        const body = proposal();
        body.effectHash = deal.fingerprint(body);
        expect(body.effectHash.length).toBeGreaterThan(64);
        const res = await request(app).post('/proposals').send(body);
        expect(res.status).toBe(201);
    });

    it.each([
        ['invalid owner shares', body => { body.reparcellization.polygons[0].owners[0].share = 0.1; }],
        ['missing owner', body => { delete body.reparcellization.polygons[0].owners; }],
        ['offer/ledger mismatch', body => { body.offer += 1; }],
        ['duplicate cash recipient', body => { body.reparcellization.ownerShares.push({ ownerKey: 'a', cashOffer: 0 }); }],
        ['missing output', body => { body.reparcellization.polygons = []; }],
        ['unsupported currency alias', body => { delete body.offerCurrency; body.offer_currency = 'USD'; }]
    ])('rejects %s before writing a row', async (_label, mutate) => {
        const { pool, app } = appFixture();
        const body = proposal();
        mutate(body);
        const res = await request(app).post('/proposals').send(body);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid-readjustment-deal');
        expect(pool.getCalls()).toEqual([]);
    });

    it('rejects geometry outside the declared take before writing a publication row', async () => {
        const { pool, app } = appFixture();
        const body = proposal();
        body.reparcellization.poolGeometry = {
            type: 'Polygon', coordinates: [[[1, 1], [1.0005, 1], [1.0005, 1.001], [1, 1.001], [1, 1]]]
        };

        const res = await request(app).post('/proposals').send(body);

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid-readjustment-deal');
        expect(pool.getCalls()).toEqual([]);
    });

    it('uses normalized EUR aliases and expiry consistently in the stored commitment', async () => {
        const { pool, app } = appFixture();
        const body = proposal();
        delete body.offerCurrency;
        body.offer_currency = 'EUR';
        body.expiresAt = '2035-01-01T12:00:00+02:00';
        const res = await request(app).post('/proposals').send(body);
        expect(res.status).toBe(201);
        const stored = JSON.parse(pool.getCalls()[0].params[32]);
        expect(stored.offerCurrency).toBe('EUR');
        expect(stored.effectHash).toBe(deal.fingerprint({ ...body, offerCurrency: 'EUR' }));
    });
});
