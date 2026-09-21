// API contract tests for public oracle event reads and per-market recipe declarations.

import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupLandEventsRoute } from '../routes/land-events.js';

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const MARKET = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';

function appFor(pool) {
    const app = express();
    setupLandEventsRoute(app, pool);
    return app;
}

describe('land-event routes', () => {
    it('serves the machine-readable recipe contract', async () => {
        const res = await request(appFor({ query: vi.fn() })).get('/oracle/recipe.schema.json');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            title: 'Urban Game Theory resolution recipe',
            required: expect.arrayContaining(['trustedAttesters', 'verification', 'hash'])
        });
        expect(res.body.properties.hash.pattern).toBe('^sha256:[a-f0-9]{64}$');
    });

    it('ships an idempotent, source-timestamped event table owned by geo_user', () => {
        const ddl = fs.readFileSync(new URL('../routes/land-events-ddl.sql', import.meta.url), 'utf8');
        expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS consensus\.land_event/);
        expect(ddl).toMatch(/source_observed_at\s+timestamptz NOT NULL/i);
        expect(ddl).toMatch(/source_hash\s+text NOT NULL/i);
        expect(ddl).toMatch(/ALTER TABLE consensus\.land_event OWNER TO geo_user/);
        expect(ddl).toMatch(/UNIQUE \(event_type, subject_id, outcome\)/);
    });

    it('returns a subject-specific immutable recipe', async () => {
        const res = await request(appFor({ query: vi.fn() }))
            .get(`/oracle/recipes/proposal-lifecycle-v1?proposal=${PROPOSAL}&market=${MARKET}`);
        expect(res.status).toBe(200);
        expect(res.body.recipe).toMatchObject({
            id: 'proposal-lifecycle-v1', eventType: 'proposal_lifecycle',
            subject: { proposalAccount: PROPOSAL, marketAccount: MARKET },
            outcomes: { executed: 'YES', cancelled: 'NO' }
        });
        expect(res.body.recipe.hash).toMatch(/^sha256:/);
    });

    it('returns a court recipe and deterministic external-market address', async () => {
        const res = await request(appFor({ query: vi.fn() }))
            .get('/oracle/recipes/court-parcel-operation-v1')
            .query({
                parcelUid: 'HR-335347-1208/3',
                yesOperation: 'transfer',
                noOperation: 'no_event',
                closesAt: '1790000000'
            });
        expect(res.status).toBe(200);
        expect(res.body.recipe).toMatchObject({
            id: 'court-parcel-operation-v1',
            subject: { parcelUid: 'HR-335347-1208/3' },
            outcomes: { transfer: 'YES', no_event: 'NO' },
            verification: { kind: 'sas_court_parcel_operation_v1', permissionless: true }
        });
        expect(res.body.recipe.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(res.body.marketAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it('rejects incomplete or ambiguous court recipes', async () => {
        const missing = await request(appFor({ query: vi.fn() }))
            .get('/oracle/recipes/court-parcel-operation-v1');
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/parcelUid/);

        const ambiguous = await request(appFor({ query: vi.fn() }))
            .get('/oracle/recipes/court-parcel-operation-v1')
            .query({ parcelUid: 'HR-x', yesOperation: 'same', noOperation: 'same', closesAt: '1790000000' });
        expect(ambiguous.status).toBe(400);
        expect(ambiguous.body.error).toMatch(/must differ/);
    });

    it('reads bounded events and preserves source timestamps and hashes', async () => {
        const pool = { query: vi.fn().mockResolvedValue({ rows: [{
            event_id: 'event-1', event_type: 'proposal_lifecycle', subject_type: 'proposal',
            subject_id: PROPOSAL, outcome: 'cancelled', source_url: 'https://explorer/address',
            source_hash: 'sha256:abc', source_observed_at: '2026-09-20T01:00:00Z',
            attester: 'program-1', transaction_signature: 'tx-1',
            evidence: { source: { transactionUrl: 'https://explorer/tx' }, proposalStatusByte: 2 },
            created_at: '2026-09-20T01:01:00Z'
        }] }) };
        const res = await request(appFor(pool)).get(`/oracle/events?subject=${PROPOSAL}&limit=500`);
        expect(res.status).toBe(200);
        expect(res.body.events[0]).toMatchObject({
            outcome: 'cancelled', observedAt: '2026-09-20T01:00:00Z',
            source: { hash: 'sha256:abc', transaction: 'tx-1', transactionUrl: 'https://explorer/tx' }
        });
        expect(pool.query.mock.calls[0][1]).toEqual(['proposal_lifecycle', PROPOSAL, 100]);
    });

    it('rejects malformed public keys before querying', async () => {
        const pool = { query: vi.fn() };
        const res = await request(appFor(pool)).get('/oracle/events?subject=not-a-key');
        expect(res.status).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('exposes privacy-preserving public-record oracle health and the public SAS schema', async () => {
        const pool = { query: vi.fn().mockResolvedValue({ rows: [{
            attestations: 57, parcels: 55, decisions: 28,
            schema_id: 'schema-account', latest_attestation_at: '2026-05-12T13:30:13Z'
        }] }) };
        const res = await request(appFor(pool)).get('/oracle/public-records/summary');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            source: 'Croatian judiciary e-Oglasna archive',
            chain: 'solana:devnet', schemaId: 'schema-account',
            attestations: 57, parcels: 55, decisions: 28,
            marketIntegration: expect.stringContaining('live on devnet')
        });
        expect(res.body.schemaUrl).toContain('/address/schema-account?cluster=devnet');
        expect(res.body).not.toHaveProperty('events');
        expect(res.body).not.toHaveProperty('decisionUuid');
        expect(pool.query.mock.calls[0][0]).toMatch(/FROM court\.attestation/);
    });
});
