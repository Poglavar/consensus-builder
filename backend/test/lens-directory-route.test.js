// Route tests for the lens attester directory and schema endpoints, with a stubbed pool. Members list
// themselves through a verified registration (lens-registration.test.js); the directory serves them.

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupLensesRoute } from '../routes/lenses.js';

const KEY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';

function appWith(pool) {
    const app = express();
    setupLensesRoute(app, pool);
    return app;
}

describe('GET /lenses/members', () => {
    const pool = {
        query: vi.fn(async () => ({
            rows: [
                { key: KEY, kind: 'owner-consent', name: 'notary-01', description: 'Devnet reference member', service_url: 'https://attester.example.test/requests', coverage: { ownership: 3, parcels: '2', executed: 1 }, metadata_uri: 'ignored' },
                { key: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg', kind: null, name: null, description: null, coverage: {} }
            ]
        }))
    };

    it.each(['/lenses/members', '/agent/lenses/members'])('%s returns the frozen shape, uncached', async (path) => {
        const res = await request(appWith(pool)).get(path);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({
            members: [
                { key: KEY, kind: 'owner-consent', name: 'notary-01', description: 'Devnet reference member', serviceUrl: 'https://attester.example.test/requests', registeredAt: null, coverage: { ownership: 3, parcels: 2, executed: 1 } },
                { key: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg', kind: null, name: null, description: null, serviceUrl: null, registeredAt: null, coverage: { ownership: 0, parcels: 0, executed: 0 } }
            ]
        });
        expect(pool.query.mock.calls.at(-1)[0]).toContain('FROM consensus.lens_member');
        expect(pool.query.mock.calls.at(-1)[0]).toContain('service_url');
    });

    it('answers 500 when the table cannot be read', async () => {
        const broken = { query: vi.fn(async () => { throw new Error('relation does not exist'); }) };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(appWith(broken)).get('/lenses/members');
        spy.mockRestore();
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/lens members/);
    });
});

describe('GET /lenses/schemas', () => {
    it('lists the schema definitions with layouts and fields', async () => {
        const res = await request(appWith({ query: vi.fn() })).get('/lenses/schemas');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.sasProgram).toBe('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
        expect(res.body.schemas.map(s => [s.id, s.name, s.version])).toEqual([
            ['ParcelOwnership-v1', 'ParcelOwnership', 1],
            ['AgreementDecision-v1', 'AgreementDecision', 1],
            ['MarketEvidence-v1', 'MarketEvidence', 1]
        ]);
        expect(res.body.schemas[0].fields).toContainEqual({ name: 'ownerCount', type: 'uint8' });
        // The agreement program's attest reads exactly this layout (programs/agreement/README.md).
        expect(res.body.schemas[1]).toMatchObject({
            kind: 'decision',
            layout: 'string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt',
            sasLayout: [12, 12, 12, 12, 8]
        });
    });
});
