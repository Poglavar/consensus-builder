// Route tests for the root discovery documents: x402 manifest, security.txt, llms.txt, OpenAPI,
// the /agents.json alias of /docs/agents.json, and robots.txt.

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setupWellKnownRoutes, SECURITY_CONTACT } from '../routes/well-known.js';
import { setupDocsRoute } from '../routes/docs.js';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';

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
    // The paid proposal route went with the server's proposal writes (plan-design-agreement.md M2):
    // oracle facts are the one paid resource, whatever the proposal price is still set to.
    it('lists the paid oracle-fact resource in x402scan shape', async () => {
        const res = await request(appFor()).get('/.well-known/x402');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            version: 1,
            x402Version: 2,
            resources: ['https://api.example.test/agent/oracle/facts']
        });
        expect(res.body.endpoints).toEqual([
            expect.objectContaining({ url: 'https://api.example.test/agent/oracle/facts', method: 'GET', price: '$0.01', network: 'solana:devnet' })
        ]);
        expect(JSON.stringify(res.body)).not.toContain('/agent/proposals');
    });

    it('omits a resource whose x402 config is incomplete', async () => {
        const partial = { ...env, X402_PRICE_ORACLE_FACT: '' };
        const res = await request(appFor({ env: partial })).get('/.well-known/x402');
        expect(res.body.resources).toEqual([]);
        expect(res.body.endpoints).toEqual([]);
    });

    it('never leaks CDP credentials', async () => {
        const cdp = { ...env, X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402', CDP_API_KEY_ID: 'kid', CDP_API_KEY_SECRET: 'sekret' };
        const res = await request(appFor({ env: cdp })).get('/.well-known/x402');
        expect(res.body.resources).toHaveLength(1);
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
        expect(res.text).toContain('[GET https://api.example.test/agent/oracle/facts]');
        expect(res.text).not.toContain('/agent/proposals');
        expect(res.text).toContain('https://api.example.test/agent/lenses/members');
        // It describes designs and agreements, not proposals (plan-design-agreement.md M3).
        expect(res.text).toContain('design/v1 and agreement/v1 JSON Schemas');
        expect(res.text).toContain("pick an agreement's lens");
        expect(res.text).toContain("fact about an agreement account's terminal state");
        expect(res.text).not.toMatch(/proposal/i);
    });
});

describe('GET /openapi.json', () => {
    it('documents private feedback submission with receipts and safe retries', async () => {
        const { body } = await request(appFor()).get('/openapi.json');
        const feedback = body.paths['/feedback'];
        expect(feedback.get).toBeUndefined();
        expect(feedback.post.requestBody.content['application/json'].schema).toMatchObject({ required: ['kind', 'message'], properties: { message: { maxLength: 8000 }, reportId: { format: 'uuid' } } });
        expect(feedback.post.responses[201].description).toContain('private');
    });

    it('lists the lens directory and schema endpoints, and none of the removed publication routes', async () => {
        const res = await request(appFor()).get('/openapi.json');
        for (const path of ['/lenses/members', '/agent/lenses/members', '/lenses/schemas']) {
            expect(res.body.paths[path]?.get, path).toBeDefined();
        }
        const members = res.body.paths['/lenses/members'].get.responses[200].content['application/json'].schema;
        const item = members.properties.members.items;
        expect(Object.keys(item.properties.coverage.properties)).toEqual(['ownership', 'parcels', 'executed']);
        expect(item.required).toContain('serviceUrl');
        expect(item.properties.serviceUrl.type).toEqual(['string', 'null']);
        expect(item.properties.kind.enum).toEqual(['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle', null]);
        expect(res.body.paths['/agent/oracle/facts']?.get).toBeDefined();
        for (const path of ['/agent/proposals', '/agent/binding', '/proposals/{id}/binding-drift', '/proposals/{id}']) {
            expect(res.body.paths[path], path).toBeUndefined();
        }
    });

    it('lists the design and agreement publish routes, the onchain record and the market recipe', async () => {
        const { body } = await request(appFor()).get('/openapi.json');
        for (const [path, method] of [
            ['/designs/binding', 'post'], ['/pins', 'post'], ['/designs', 'get'], ['/designs', 'post'], ['/designs/{cid}', 'get'],
            ['/agreements', 'get'], ['/agreements', 'post'], ['/agreements/{cid}', 'get'], ['/agreements/{cid}/decisions', 'post'],
            ['/agreements/{cid}/onchain', 'post'], ['/oracle/recipes/agreement-execution-v1', 'get']
        ]) {
            expect(body.paths[path]?.[method], `${method} ${path}`).toBeDefined();
        }
        const onchain = body.paths['/agreements/{cid}/onchain'].post;
        expect(onchain.requestBody.content['application/json'].schema).toMatchObject({
            required: ['chain', 'cluster', 'account'],
            properties: { chain: { enum: ['solana'] }, cluster: { enum: ['devnet'] } }
        });
        expect(Object.keys(onchain.responses).sort()).toEqual(['200', '201', '400', '404', '409', '422']);
        expect(onchain.responses[422].description).toMatch(/not-binding/);
        expect(onchain.responses[422].description).toMatch(/no-sponsor/);
        const recipe = body.paths['/oracle/recipes/agreement-execution-v1'].get;
        expect(recipe.parameters.map(parameter => [parameter.name, parameter.required])).toEqual([['agreement', true], ['market', false]]);
        expect(body.paths['/oracle/events'].get.parameters.find(parameter => parameter.name === 'type').schema.enum)
            .toEqual(['agreement_lifecycle', 'agreement_executed']);
        expect(body.paths['/agent/discovery'].get.parameters[0].schema.enum).toEqual(['oracle-facts']);
    });
});

describe('GET /agents.json', () => {
    it('returns exactly what /docs/agents.json returns', async () => {
        const app = appFor();
        const alias = await request(app).get('/agents.json');
        const canonical = await request(app).get('/docs/agents.json');
        expect(alias.status).toBe(200);
        expect(alias.body.schema.$defs.design.properties).toHaveProperty('site');
        expect(alias.body).toEqual(canonical.body);
    });

    it('names the program an agent mints its agreement with, and the route that records the account', async () => {
        const res = await request(appFor()).get('/agents.json');
        expect(res.body.agreementProgram).toMatchObject({
            programId: AGREEMENT_PROGRAM_ID,
            cluster: 'devnet',
            instructions: { create: { args: expect.arrayContaining(['cid: string', 'lens: pubkey']) } }
        });
        expect(res.body.endpoints.agreementOnchain).toBe('https://api.example.test/agreements/{cid}/onchain');
        expect(res.body).not.toHaveProperty('proposalAccount');
        expect(res.body).not.toHaveProperty('parcelAccount');
    });
});

describe('documents with live payment terms', () => {
    it('are never cached, so a stale copy cannot advertise an old price', async () => {
        const app = appFor();
        for (const path of ['/.well-known/x402', '/openapi.json', '/agents.json', '/llms.txt']) {
            const res = await request(app).get(path);
            expect(res.status, path).toBe(200);
            expect(res.headers['cache-control'], path).toBe('no-store');
        }
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
