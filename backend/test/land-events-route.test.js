// API contract of the public oracle reads (routes/land-events.js): the recipe schema, the land_event DDL,
// the court recipes and their external-market addresses, GET /oracle/events over the agreement lifecycle
// oracle's events (agreement_lifecycle by default, agreement_executed; ?subject=, ?agreement=,
// ?parcelUid=, ?limit=) and the privacy-preserving public-record summary.
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupLandEventsRoute } from '../routes/land-events.js';
import { COURT_SCHEMA_V2 } from '../oracle/court-parcel-operation.js';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { cidOf } from './helpers/content-fixtures.js';

const ACCOUNT = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const CID = cidOf({ schema: 'agreement/v1', title: 'Corner lot' });

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
        expect(res.body.properties.verification.properties.evidencePolicy.properties).toMatchObject({
            threshold: { type: 'integer', minimum: 1 },
            challengeWindowSeconds: { type: 'integer', minimum: 0 }
        });
    });

    it('ships an idempotent, source-timestamped event table owned by geo_user, one terminal event per agreement account', () => {
        const ddl = fs.readFileSync(new URL('../routes/land-events-ddl.sql', import.meta.url), 'utf8');
        expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS consensus\.land_event/);
        expect(ddl).toMatch(/source_observed_at\s+timestamptz NOT NULL/i);
        expect(ddl).toMatch(/source_hash\s+text NOT NULL/i);
        expect(ddl).toMatch(/event_id\s+text PRIMARY KEY/);
        expect(ddl).toMatch(/ALTER TABLE consensus\.land_event OWNER TO geo_user/);
        expect(ddl).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS land_event_agreement_lifecycle_uidx\s+ON consensus\.land_event \(subject_id\)\s+WHERE event_type = 'agreement_lifecycle'/);
        // The proposal rows written before stay; their index is kept and nothing writes them.
        expect(ddl).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS land_event_lifecycle_outcome_uidx[\s\S]*WHERE event_type = 'proposal_lifecycle'/);
    });

    it('serves no proposal-lifecycle recipe any more', async () => {
        const app = appFor({ query: vi.fn() });
        for (const id of ['proposal-lifecycle-v1', 'proposal-lifecycle-v2']) {
            expect((await request(app).get(`/oracle/recipes/${id}?proposal=${ACCOUNT}`)).status).toBe(404);
        }
    });

    it('returns a court recipe and deterministic external-market address', async () => {
        const query = { parcelUid: 'HR-335347-1208/3', yesOperation: 'transfer', noOperation: 'no_event', closesAt: '1790000000' };
        const res = await request(appFor({ query: vi.fn() })).get('/oracle/recipes/court-parcel-operation-v1').query(query);
        expect(res.status).toBe(200);
        expect(res.body.recipe).toMatchObject({
            id: 'court-parcel-operation-v1',
            subject: { parcelUid: 'HR-335347-1208/3' },
            outcomes: { transfer: 'YES', no_event: 'NO' },
            verification: { kind: 'sas_court_parcel_operation_v1', permissionless: true }
        });
        expect(res.body.recipe.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(res.body.marketAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        const again = await request(appFor({ query: vi.fn() })).get('/oracle/recipes/court-parcel-operation-v1').query(query);
        expect(again.body).toEqual(res.body);
    });

    it('rejects incomplete or ambiguous court recipes', async () => {
        const missing = await request(appFor({ query: vi.fn() })).get('/oracle/recipes/court-parcel-operation-v1');
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/parcelUid/);
        const ambiguous = await request(appFor({ query: vi.fn() }))
            .get('/oracle/recipes/court-parcel-operation-v1')
            .query({ parcelUid: 'HR-x', yesOperation: 'same', noOperation: 'same', closesAt: '1790000000' });
        expect(ambiguous.status).toBe(400);
        expect(ambiguous.body.error).toMatch(/must differ/);
    });

    it('declares a V2 court recipe with an on-chain source-time policy', async () => {
        const res = await request(appFor({ query: vi.fn() }))
            .get('/oracle/recipes/court-parcel-operation-v2')
            .query({ parcelUid: 'HR-335347-1208/3', yesOperation: 'transfer', noOperation: 'no_event', closesAt: '1790000000' });
        expect(res.status).toBe(200);
        expect(res.body.recipe).toMatchObject({
            id: 'court-parcel-operation-v2',
            version: 2,
            verification: {
                schema: COURT_SCHEMA_V2,
                kind: 'sas_court_parcel_operation_v2',
                temporalIntegrity: { minimum: 'market_closes_at', maximum: 'resolution_time', enforcedBy: 'proposal_market' }
            }
        });
        expect(res.body.marketAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it('exposes privacy-preserving public-record oracle health and the public SAS schema', async () => {
        const pool = { query: vi.fn().mockResolvedValue({ rows: [{
            attestations: 62, parcels: 60, decisions: 29,
            schema_id: 'schema-account', latest_attestation_at: '2026-09-21T20:40:00Z',
            schemas: [{ schemaId: 'G747jAqNr6ZwBiNAdeW1Bc4PWQH7arfvq5cjDXDcSoMG', attestations: 5 }]
        }] }) };
        const res = await request(appFor(pool)).get('/oracle/public-records/summary');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            source: 'Croatian judiciary e-Oglasna archive',
            chain: 'solana:devnet', schemaId: 'schema-account',
            attestations: 62, parcels: 60, decisions: 29,
            v2: { status: 'live_devnet', attestations: 5, sourceTimestamped: true },
            marketIntegration: expect.stringContaining('live on devnet')
        });
        expect(res.body.schemaUrl).toContain('/address/schema-account?cluster=devnet');
        expect(res.body).not.toHaveProperty('events');
        expect(pool.query.mock.calls[0][0]).toMatch(/FROM court\.attestation/);
    });
});

describe('GET /oracle/events', () => {
    const lifecycleRow = {
        event_id: `solana:devnet:agreement_lifecycle:${ACCOUNT}:executed`, event_type: 'agreement_lifecycle', subject_type: 'agreement',
        subject_id: ACCOUNT, outcome: 'executed', source_url: `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`,
        source_hash: `sha256:${'ab'.repeat(32)}`, source_observed_at: '2026-10-22T07:30:00.000Z',
        attester: AGREEMENT_PROGRAM_ID, transaction_signature: 'exec-tx',
        evidence: { source: { chain: 'solana:devnet', transactionUrl: 'https://explorer.solana.com/tx/exec-tx?cluster=devnet', slot: 880 }, agreementCid: CID, account: ACCOUNT },
        created_at: '2026-10-22T07:35:00.000Z'
    };
    const recording = (rows = [lifecycleRow]) => ({ query: vi.fn().mockResolvedValue({ rows }) });

    it('reads the agreement lifecycle events by default, newest first, bounded, with the source\'s own time and hash', async () => {
        const pool = recording();
        const res = await request(appFor(pool)).get(`/oracle/events?subject=${ACCOUNT}&limit=500`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            eventType: 'agreement_lifecycle', count: 1,
            events: [{
                id: lifecycleRow.event_id, eventType: 'agreement_lifecycle', subject: { type: 'agreement', id: ACCOUNT },
                outcome: 'executed', observedAt: '2026-10-22T07:30:00.000Z', recordedAt: '2026-10-22T07:35:00.000Z',
                attester: { kind: 'solana_program', address: AGREEMENT_PROGRAM_ID },
                source: { url: lifecycleRow.source_url, hash: lifecycleRow.source_hash, transaction: 'exec-tx', ...lifecycleRow.evidence.source },
                evidence: lifecycleRow.evidence
            }]
        });
        const [sql, params] = pool.query.mock.calls[0];
        expect(params).toEqual(['agreement_lifecycle', ACCOUNT, 100]);
        expect(sql).toMatch(/WHERE event_type = \$1 AND subject_id = \$2\s+ORDER BY source_observed_at DESC\s+LIMIT \$3/);
    });

    it('serves the per-parcel execution entries and refuses any other type, the proposal ones included', async () => {
        const pool = recording([]);
        const res = await request(appFor(pool)).get('/oracle/events?type=agreement_executed');
        expect([res.status, res.body.eventType]).toEqual([200, 'agreement_executed']);
        expect(pool.query.mock.calls[0][1]).toEqual(['agreement_executed', 25]);
        for (const type of ['proposal_lifecycle', 'proposal_acceptance', 'anything']) {
            expect((await request(appFor(pool)).get(`/oracle/events?type=${type}`)).status, type).toBe(400);
        }
        expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('narrows to one agreement by its CID, and refuses what is not one before querying', async () => {
        const pool = recording();
        const res = await request(appFor(pool)).get(`/oracle/events?agreement=${CID}`);
        expect(res.body.agreement).toBe(CID);
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/event_type = \$1 AND evidence->>'agreementCid' = \$2/);
        expect(params).toEqual(['agreement_lifecycle', CID, 25]);
        for (const query of ['?agreement=ag-1', '?agreement=', `?subject=not-a-key`, '?parcelUid=']) {
            expect((await request(appFor(pool)).get(`/oracle/events${query}`)).status, query).toBe(400);
        }
        expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('filters to a parcel through the agreement program\'s events only, numbering every parameter', async () => {
        const pool = recording([]);
        const res = await request(appFor(pool)).get(`/oracle/events?type=agreement_executed&subject=${ACCOUNT}&agreement=${CID}&parcelUid=${encodeURIComponent('HR-1/1')}&limit=7`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ count: 0, eventType: 'agreement_executed', agreement: CID, parcelUid: 'HR-1/1' });
        const [sql, params] = pool.query.mock.calls[0];
        expect(params).toEqual(['agreement_executed', ACCOUNT, CID, 'HR-1/1', 7]);
        expect(sql).toContain(`attester = '${AGREEMENT_PROGRAM_ID}'`);
        expect(sql).toMatch(/THEN subject_type = 'parcel' AND subject_id = \$4::text\s+ELSE evidence->'inputParcelIds' @> jsonb_build_array\(\$4::text\)/);
        expect(sql).toMatch(/LIMIT \$5/);
    });
});
