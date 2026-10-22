// Route tests for the public hosted-Bazaar proof of the one paid resource (the verified oracle facts,
// GET /agent/oracle/facts), including exact endpoint matching, caching and the catalog lookup itself.

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { findBazaarListing, setupAgentDiscoveryRoute } from '../routes/agent-discovery.js';

const env = {
    PUBLIC_API_BASE_URL: 'https://api.example.test',
    X402_NETWORK: 'solana:devnet',
    X402_FACILITATOR_URL: 'https://facilitator.example.test',
    X402_PAY_TO: 'Treasury111111111111111111111111111111111',
    X402_PRICE_ORACLE_FACT: '$0.01'
};
const FACTS = 'https://api.example.test/agent/oracle/facts';

function appFor(options) {
    const app = express();
    setupAgentDiscoveryRoute(app, options);
    return app;
}

describe('GET /agent/discovery', () => {
    it('returns the exact hosted listing of the oracle-facts resource without exposing credentials', async () => {
        const lookup = vi.fn().mockResolvedValue({ state: 'listed', total: 1, listing: { resource: FACTS } });
        const res = await request(appFor({ env, lookup, now: () => Date.parse('2026-09-20T10:00:00Z') }))
            .get('/agent/discovery');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            state: 'listed', resource: 'oracle-facts', endpoint: FACTS,
            verifiedAt: '2026-09-20T10:00:00.000Z', cached: false,
            facilitatorUrl: 'https://facilitator.example.test', network: 'solana:devnet', payTo: env.X402_PAY_TO,
            listing: { resource: FACTS }, totalMatches: 1, partialResults: false, error: null
        });
        expect(JSON.stringify(res.body)).not.toContain('API_KEY');
        expect(lookup).toHaveBeenCalledWith(expect.objectContaining({
            facilitatorUrl: 'https://facilitator.example.test', resourceUrl: FACTS, payTo: env.X402_PAY_TO, network: 'solana:devnet'
        }));
    });

    it('answers the same proof when the resource is named, and refuses the removed proposals resource', async () => {
        const lookup = vi.fn().mockResolvedValue({ state: 'listed', listing: { resource: FACTS } });
        const named = await request(appFor({ env, lookup })).get('/agent/discovery?resource=oracle-facts');
        expect(named.body).toMatchObject({ state: 'listed', resource: 'oracle-facts', endpoint: FACTS });
        // The paid proposal route went with the server's proposal writes (plan-design-agreement.md M2).
        for (const resource of ['proposals', 'unknown']) {
            const res = await request(appFor({ env, lookup })).get(`/agent/discovery?resource=${resource}`);
            expect(res.status, resource).toBe(400);
            expect(res.body.error).toBe('resource must be oracle-facts');
        }
        expect(lookup).toHaveBeenCalledOnce();
    });

    it('caches the catalog proof for the bounded TTL', async () => {
        let clock = 1000;
        const lookup = vi.fn().mockResolvedValue({ state: 'listed', listing: { resource: 'x' } });
        const app = appFor({ env, lookup, now: () => clock, cacheMs: 500 });
        expect((await request(app).get('/agent/discovery')).body.cached).toBe(false);
        clock = 1200;
        expect((await request(app).get('/agent/discovery')).body.cached).toBe(true);
        expect(lookup).toHaveBeenCalledOnce();
        clock = 1600;
        expect((await request(app).get('/agent/discovery')).body.cached).toBe(false);
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('reports missing server configuration without attempting discovery', async () => {
        const lookup = vi.fn();
        const res = await request(appFor({ env: {}, lookup })).get('/agent/discovery');
        expect(res.body).toMatchObject({ state: 'unconfigured', resource: 'oracle-facts', verifiedAt: null });
        expect(res.body.missing).toEqual(expect.arrayContaining(['X402_NETWORK', 'X402_PRICE_ORACLE_FACT']));
        expect(lookup).not.toHaveBeenCalled();
    });

    it('reports facilitator client failures without exposing credential details', async () => {
        const cdpEnv = {
            ...env,
            X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
            CDP_API_KEY_ID: 'organizations/example/apiKeys/example',
            CDP_API_KEY_SECRET: 'secret-that-must-not-leak'
        };
        const res = await request(appFor({
            env: cdpEnv,
            lookup: vi.fn().mockRejectedValue(new Error(`bad secret ${cdpEnv.CDP_API_KEY_SECRET}`))
        })).get('/agent/discovery');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            state: 'unavailable',
            error: 'Hosted facilitator discovery lookup failed.'
        });
        expect(JSON.stringify(res.body)).not.toContain(cdpEnv.CDP_API_KEY_SECRET);
    });
});

describe('findBazaarListing', () => {
    const bazaarClient = bazaar => ({ extensions: { bazaar } });

    it('searches for the exact resource URL and keeps only an exact match', async () => {
        const search = vi.fn().mockResolvedValue({
            resources: [{ resource: `${FACTS}-old` }, { resource: 'https://api.example.test/agent/other' }, { resource: `${FACTS}/` }],
            partialResults: true
        });
        const result = await findBazaarListing({
            facilitatorUrl: 'https://facilitator.test', resourceUrl: FACTS, payTo: 'Treasury111', network: 'solana:devnet',
            bazaarClient: bazaarClient({ search })
        });
        // A trailing slash is the same resource; a longer path is not.
        expect(result).toMatchObject({ state: 'listed', listing: { resource: `${FACTS}/` }, total: 3, partialResults: true });
        expect(search).toHaveBeenCalledWith({
            query: FACTS, type: 'http', payTo: 'Treasury111', network: 'solana:devnet', extensions: 'bazaar', limit: 20
        });
    });

    it('compares the path without query or fragment, and is not-listed when no entry has that path', async () => {
        const search = vi.fn().mockResolvedValue({ resources: [{ resource: 'not a url' }, { resource: `${FACTS}?subject=x#top` }] });
        const result = await findBazaarListing({ facilitatorUrl: 'https://facilitator.test', resourceUrl: FACTS, bazaarClient: bazaarClient({ search }) });
        expect(result).toMatchObject({ state: 'listed', listing: { resource: `${FACTS}?subject=x#top` } });
        const elsewhere = vi.fn().mockResolvedValue({ resources: [{ resource: 'https://api.example.test/agent/oracle' }, { resource: 'not a url' }] });
        expect(await findBazaarListing({ facilitatorUrl: 'https://facilitator.test', resourceUrl: FACTS, bazaarClient: bazaarClient({ search: elsewhere }) }))
            .toMatchObject({ state: 'not-listed', listing: null, total: 2 });
    });

    it('falls back to listing for facilitators without Bazaar search', async () => {
        const listResources = vi.fn().mockResolvedValue({ items: [{ resource: FACTS }], pagination: { total: 1 } });
        const result = await findBazaarListing({ facilitatorUrl: 'https://facilitator.test', resourceUrl: FACTS, bazaarClient: bazaarClient({ listResources }) });
        expect(result).toEqual({ state: 'listed', listing: { resource: FACTS }, total: 1 });
        expect(listResources).toHaveBeenCalledWith(expect.objectContaining({ type: 'http', extensions: 'bazaar', limit: 100, offset: 0 }));
    });

    it('is unconfigured without a facilitator and unavailable when the catalog fails', async () => {
        const search = vi.fn();
        expect(await findBazaarListing({ facilitatorUrl: '  ', resourceUrl: FACTS, bazaarClient: bazaarClient({ search }) }))
            .toEqual({ state: 'unconfigured', listing: null });
        expect(search).not.toHaveBeenCalled();
        const failing = vi.fn().mockRejectedValue(new Error('catalog down'));
        expect(await findBazaarListing({ facilitatorUrl: 'https://facilitator.test', resourceUrl: FACTS, bazaarClient: bazaarClient({ search: failing }) }))
            .toEqual({ state: 'unavailable', listing: null, error: 'catalog down' });
    });
});
