// Route tests for the root discovery documents: x402 manifest, security.txt, llms.txt, OpenAPI,
// the /agents.json alias of /docs/agents.json, and robots.txt.

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setupWellKnownRoutes, SECURITY_CONTACT } from '../routes/well-known.js';
import { setupDocsRoute } from '../routes/docs.js';

const env = {
    PUBLIC_API_BASE_URL: 'https://api.example.test/',
    X402_NETWORK: 'solana:devnet',
    X402_FACILITATOR_URL: 'https://facilitator.example.test',
    X402_PAY_TO: 'Treasury111111111111111111111111111111111',
    X402_PRICE_PROPOSAL: '$0.05',
    X402_PRICE_ORACLE_FACT: '$0.01'
};

function appFor(options = {}) {
    const app = express();
    setupWellKnownRoutes(app, { env, ...options });
    setupDocsRoute(app, null, { env: options.env || env });
    return app;
}

describe('GET /.well-known/x402', () => {
    it('lists both paid resources in x402scan shape', async () => {
        const res = await request(appFor()).get('/.well-known/x402');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            version: 1,
            x402Version: 2,
            resources: ['https://api.example.test/agent/proposals', 'https://api.example.test/agent/oracle/facts']
        });
        expect(res.body.endpoints).toEqual([
            expect.objectContaining({ url: 'https://api.example.test/agent/proposals', method: 'POST', price: '$0.05', network: 'solana:devnet' }),
            expect.objectContaining({ url: 'https://api.example.test/agent/oracle/facts', method: 'GET', price: '$0.01' })
        ]);
    });

    it('omits a resource whose x402 config is incomplete', async () => {
        const partial = { ...env, X402_PRICE_ORACLE_FACT: '' };
        const res = await request(appFor({ env: partial })).get('/.well-known/x402');
        expect(res.body.resources).toEqual(['https://api.example.test/agent/proposals']);
    });

    it('never leaks CDP credentials', async () => {
        const cdp = { ...env, X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402', CDP_API_KEY_ID: 'kid', CDP_API_KEY_SECRET: 'sekret' };
        const res = await request(appFor({ env: cdp })).get('/.well-known/x402');
        expect(res.body.resources).toHaveLength(2);
        expect(JSON.stringify(res.body)).not.toContain('sekret');
    });
});

describe('GET /.well-known/security.txt', () => {
    it('serves RFC 9116 fields with an expiry under a year out', async () => {
        const res = await request(appFor({ now: () => new Date('2026-09-24T12:00:00Z') })).get('/.well-known/security.txt');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/plain/);
        expect(res.text).toContain(`Contact: ${SECURITY_CONTACT}`);
        expect(res.text).toContain('Expires: 2027-03-23T00:00:00.000Z');
        expect(res.text).toContain('Canonical: https://api.example.test/.well-known/security.txt');
    });
});

describe('GET /llms.txt', () => {
    it('is markdown pointing at the agent docs and the paid routes', async () => {
        const res = await request(appFor()).get('/llms.txt');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/markdown/);
        expect(res.text.startsWith('# Urban Game Theory API\n')).toBe(true);
        expect(res.text).toContain('(https://api.example.test/docs/agents)');
        expect(res.text).toContain('POST https://api.example.test/agent/proposals');
    });
});

describe('GET /openapi.json', () => {
    it('is OpenAPI 3.1 with the recipe schema as the paid request body', async () => {
        const res = await request(appFor()).get('/openapi.json');
        expect(res.status).toBe(200);
        expect(res.body.openapi).toBe('3.1.0');
        expect(res.body.servers).toEqual([{ url: 'https://api.example.test' }]);
        const post = res.body.paths['/agent/proposals'].post;
        const schema = post.requestBody.content['application/json'].schema;
        expect(schema.required).toContain('cadastreParcelIds');
        expect(schema.$schema).toBeUndefined();
        expect(post['x-x402']).toEqual({ price: '$0.05', network: 'solana:devnet', payTo: env.X402_PAY_TO });
        expect(post.responses[402]).toBeDefined();
    });
});

describe('GET /agents.json', () => {
    it('returns exactly what /docs/agents.json returns', async () => {
        const app = appFor();
        const alias = await request(app).get('/agents.json');
        const canonical = await request(app).get('/docs/agents.json');
        expect(alias.status).toBe(200);
        expect(alias.body.schema.required).toContain('cadastreParcelIds');
        expect(alias.body).toEqual(canonical.body);
    });
});

describe('GET /robots.txt', () => {
    it('allows crawling and points agents at llms.txt', async () => {
        const res = await request(appFor()).get('/robots.txt');
        expect(res.status).toBe(200);
        expect(res.text).toContain('User-agent: *\nAllow: /');
        expect(res.text).toContain('/llms.txt');
    });
});
