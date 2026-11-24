import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupMarketRecipesRoute } from '../routes/market-recipes.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recipes = require('../../frontend/js/bets/external-recipe.js');
const A = '11111111111111111111111111111111';
const B = 'SysvarRent111111111111111111111111111111111';
const C = 'Vote111111111111111111111111111111111111111';
const D = 'Stake11111111111111111111111111111111111111';
const tuple = (overrides = {}) => ({ milestone: 'adopted', rule: 'operation', deadline: '2027-12-31T23:59:59Z',
    subject: { jurisdiction: 'US-CA-SF', authority: 'San Francisco', label: 'Harbour plan', parcelIds: ['P-2', 'P-1'] }, evidence: { source: 'sf-legislation-v1', operation: 'Harbour plan approval' }, ...overrides });
const built = (overrides = {}) => recipes.build({ proposal: A, trustedAttester: B, external: { credential: C, schema: D, tuple: tuple(overrides) } });
const appFor = opts => { const app = express(); app.use(express.json()); setupMarketRecipesRoute(app, opts); return app; };

describe('market recipe publication and verification', () => {
    it('publishes canonical user terms and retrieves the exact CID', async () => {
        const prepared = built(); const pin = vi.fn(async ({ bytes, cid }) => ({ cid, bytes }));
        const response = await request(appFor({ pin })).post('/markets/recipes').send({ proposal: A, trustedAttester: B, external: { credential: C, schema: D, tuple: tuple() } });
        expect(response.status).toBe(200); expect(response.body.cid).toBe(prepared.cid);
        expect(pin).toHaveBeenCalledWith(expect.objectContaining({ cid: prepared.cid, bytes: canonicalBytes(prepared.body) }));
        const fetched = await request(appFor({ gateway: cid => `https://gateway/${cid}`, fetchContent: async () => ({ ok: true, body: (async function* () { yield Buffer.from(canonicalBytes(prepared.body)); })() }) })).get(`/markets/recipes/${prepared.cid}`);
        expect(fetched.status).toBe(200); expect(fetched.body).toEqual(prepared.body);
    });

    it('rejects tampered source, side commitments and verifier bindings', () => {
        const prepared = built(); const market = { recipeHash: prepared.commitments.recipeHash, proposal: A, trustedAttester: B, schema: D, credential: C, closesAt: prepared.closesAt, subjectHash: prepared.commitments.subjectHash, yesValueHash: prepared.commitments.yesValueHash, noValueHash: prepared.commitments.noValueHash };
        for (const tamper of [body => ({ ...body, subject: { ...body.subject, label: 'Tampered' } }), body => ({ ...body, outcomes: { ...body.outcomes, yes: 'different' } }), body => ({ ...body, trustedAttesters: [{ kind: 'lens-member', address: C }] }), body => ({ ...body, verification: { ...body.verification, schema: C } })]) {
            expect(() => recipes.verify(tamper(prepared.body), market)).toThrow(/does not match/);
        }
    });

    it('rejects invalid and foreign CIDs and incorrect gateway bytes', async () => {
        const bad = await request(appFor()).get('/markets/recipes/not-a-cid'); expect(bad.status).toBe(400);
        const prepared = built(); const foreign = built({ evidence: { source: 'sf-legislation-v1', operation: 'Different operation' } });
        const app = appFor({ gateway: cid => `https://gateway/${cid}`, fetchContent: async () => ({ ok: true, body: (async function* () { yield Buffer.from(canonicalBytes(foreign.body)); })() }) });
        expect((await request(app).get(`/markets/recipes/${prepared.cid}`)).status).toBe(502);
        const missing = appFor({ gateway: () => '', fetchContent: async () => ({ ok: false, status: 404 }) });
        expect((await request(missing).get(`/markets/recipes/${prepared.cid}`)).status).toBe(404);
    });
});
