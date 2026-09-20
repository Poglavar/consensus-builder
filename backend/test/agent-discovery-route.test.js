// Route tests for the public hosted-Bazaar proof, including exact endpoint matching and caching.

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupAgentDiscoveryRoute } from '../routes/agent-discovery.js';

const env = {
    PUBLIC_API_BASE_URL: 'https://api.example.test',
    X402_NETWORK: 'solana:devnet',
    X402_FACILITATOR_URL: 'https://facilitator.example.test',
    X402_PAY_TO: 'Treasury111111111111111111111111111111111',
    X402_PRICE_PROPOSAL: '$0.05'
};

function appFor(options) {
    const app = express();
    setupAgentDiscoveryRoute(app, options);
    return app;
}

describe('GET /agent/discovery', () => {
    it('returns the exact hosted listing without exposing credentials', async () => {
        const lookup = vi.fn().mockResolvedValue({
            state: 'listed', total: 1, listing: { resource: 'https://api.example.test/agent/proposals' }
        });
        const res = await request(appFor({ env, lookup, now: () => Date.parse('2026-09-20T10:00:00Z') }))
            .get('/agent/discovery');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            state: 'listed', endpoint: 'https://api.example.test/agent/proposals',
            verifiedAt: '2026-09-20T10:00:00.000Z', cached: false
        });
        expect(JSON.stringify(res.body)).not.toContain('API_KEY');
        expect(lookup).toHaveBeenCalledWith(expect.objectContaining({
            submitUrl: 'https://api.example.test/agent/proposals', network: 'solana:devnet'
        }));
    });

    it('caches the catalog proof for the bounded TTL', async () => {
        let clock = 1000;
        const lookup = vi.fn().mockResolvedValue({ state: 'listed', listing: { resource: 'x' } });
        const app = appFor({ env, lookup, now: () => clock, cacheMs: 500 });
        expect((await request(app).get('/agent/discovery')).body.cached).toBe(false);
        clock = 1200;
        expect((await request(app).get('/agent/discovery')).body.cached).toBe(true);
        expect(lookup).toHaveBeenCalledOnce();
    });

    it('reports missing server configuration without attempting discovery', async () => {
        const lookup = vi.fn();
        const res = await request(appFor({ env: {}, lookup })).get('/agent/discovery');
        expect(res.body.state).toBe('unconfigured');
        expect(res.body.missing).toContain('X402_NETWORK');
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
