// The permanent per-parcel log (oracle/parcel-history.js, GET /parcels/:parcelUid/history): the published
// agreements that take the parcel, lens members' ownership attestations and the parcel's agreement_executed
// entries, merged by each source's own time (ties in causal order, untimed last, no time invented), the
// parcel anchor observation, and the ?parcelUid= filter of GET /oracle/events.
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { setupParcelHistoryRoute } from '../routes/parcel-history.js';
import { setupLandEventsRoute } from '../routes/land-events.js';
import {
    AGREEMENT_PUBLISHED_EVENT_TYPE, OWNERSHIP_EVENT_TYPE, PARCEL_PROGRAM_ID,
    agreementEvent, deriveParcelAnchor, landEventHistoryEvent, loadParcelHistory, sortHistory
} from '../oracle/parcel-history.js';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { cidOf } from './helpers/content-fixtures.js';

const PARCEL = 'HR-335347-1208/3';
const CID = cidOf({ schema: 'agreement/v1', title: 'Densify the corner' });
const COUNTER_CID = cidOf({ schema: 'agreement/v1', title: 'Keep the corner' });
const ACCOUNT = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const NOTARY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const OWNER = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const ATTESTATION = '12VxrWBkHfabA1jdV9HfniPNSj95Tp16uhXprpXzPgWk';
const DECISION = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';

const agreementRow = (overrides = {}) => ({ cid: CID, title: 'Densify the corner', created_at: new Date('2026-09-16T10:00:00Z'), ...overrides });
const attestationRow = {
    address: ATTESTATION, authority: NOTARY, owner: OWNER, owner_count: '2',
    account_hash: 'ab'.repeat(32), transaction_signature: 'attestSig', issued_at: new Date('2026-09-20T08:00:00Z'),
    payload: { evidenceRef: 'case-4711-secret' }
};
// The parcel's execution entry, at the same chain time as a counter-agreement published in that second.
const executedRow = {
    event_id: `solana:devnet:agreement_executed:${ACCOUNT}:${PARCEL}`, event_type: 'agreement_executed', subject_id: PARCEL,
    outcome: 'executed', source_url: `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`, source_hash: `sha256:${'cd'.repeat(32)}`,
    source_observed_at: new Date('2026-09-21T09:00:00Z'), transaction_signature: 'execSig',
    evidence: {
        source: { chain: 'solana:devnet', transactionUrl: 'https://explorer.solana.com/tx/execSig?cluster=devnet' },
        agreementCid: CID, account: ACCOUNT, lens: NOTARY, decision: 'satisfied', attestation: DECISION, attestationHash: `sha256:${'ef'.repeat(32)}`
    }
};

// Answers each query by the table it reads; records every call.
function stubPool({ agreements = [], attestations = [], landEvents = [] } = {}) {
    const calls = [];
    return {
        calls,
        query: vi.fn(async (sql, params) => {
            calls.push({ sql, params });
            if (/FROM consensus\.agreement\b/.test(sql)) return { rows: agreements };
            if (/FROM consensus\.lens_attestation/.test(sql)) return { rows: attestations };
            if (/FROM consensus\.land_event/.test(sql)) return { rows: landEvents };
            throw new Error(`unexpected query: ${sql}`);
        })
    };
}

function appFor(pool, readAnchorAccount = async () => true) {
    const app = express();
    setupParcelHistoryRoute(app, pool, { readAnchorAccount });
    setupLandEventsRoute(app, pool);
    return app;
}

afterEach(() => vi.useRealTimers());

describe('GET /parcels/:parcelUid/history', () => {
    it('merges published agreements, attestations and executions in source-time order with per-type shapes', async () => {
        const pool = stubPool({
            agreements: [agreementRow(), agreementRow({ cid: COUNTER_CID, title: 'Keep the corner', created_at: new Date('2026-09-21T09:00:00Z') })],
            attestations: [attestationRow],
            landEvents: [executedRow]
        });
        const res = await request(appFor(pool)).get(`/parcels/${encodeURIComponent(PARCEL)}/history`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.parcelUid).toBe(PARCEL);
        expect(res.body.anchor).toEqual({ account: deriveParcelAnchor(PARCEL), exists: true, source: 'chain' });
        expect(res.body.events).toEqual([
            { type: 'agreement_published', at: '2026-09-16T10:00:00.000Z', agreementCid: CID, title: 'Densify the corner', link: `/agreements/${CID}` },
            {
                type: 'parcel_ownership', at: '2026-09-20T08:00:00.000Z', attestation: ATTESTATION, member: NOTARY, owner: OWNER, ownerCount: 2,
                hash: `sha256:${'ab'.repeat(32)}`, transaction: 'attestSig', link: `https://explorer.solana.com/address/${ATTESTATION}?cluster=devnet`
            },
            // Published in the same second as the execution: publication sorts first.
            { type: 'agreement_published', at: '2026-09-21T09:00:00.000Z', agreementCid: COUNTER_CID, title: 'Keep the corner', link: `/agreements/${COUNTER_CID}` },
            {
                type: 'agreement_executed', at: '2026-09-21T09:00:00.000Z', outcome: 'executed', agreementCid: CID, account: ACCOUNT, lens: NOTARY,
                attestation: DECISION, transaction: 'execSig', hash: `sha256:${'cd'.repeat(32)}`, link: 'https://explorer.solana.com/tx/execSig?cluster=devnet'
            }
        ]);
        expect(JSON.stringify(res.body)).not.toContain('case-4711-secret');
    });

    it('binds the parcel to every query, reads only ownerCount of a payload and only the agreement program\'s executions', async () => {
        const pool = stubPool();
        await request(appFor(pool)).get(`/parcels/${encodeURIComponent(PARCEL)}/history`);
        const agreementCall = pool.calls.find(call => /FROM consensus\.agreement\b/.test(call.sql));
        expect(agreementCall.sql).toMatch(/WHERE input_parcel_ids @> ARRAY\[\$1::text\]/);
        expect(agreementCall.params).toEqual([PARCEL]);
        const attestationSql = pool.calls.find(call => /lens_attestation/.test(call.sql)).sql;
        expect(attestationSql).toMatch(/payload->>'ownerCount'/);
        expect(attestationSql).not.toMatch(/SELECT[^;]*\bpayload\s*,/);
        expect(attestationSql).not.toMatch(/evidenceRef/);
        const landCall = pool.calls.find(call => /FROM consensus\.land_event/.test(call.sql));
        expect(landCall.params).toEqual([PARCEL, 'agreement_executed']);
        expect(landCall.sql).toMatch(/WHERE event_type = \$2 AND/);
        expect(landCall.sql).toContain(`attester = '${AGREEMENT_PROGRAM_ID}'`);
        expect(landCall.sql).toMatch(/subject_type = 'parcel' AND subject_id = \$1::text/);
        expect(pool.calls).toHaveLength(3);
    });

    it('returns an empty history and a non-existent anchor for an unknown parcel', async () => {
        const reader = vi.fn(async () => false);
        const res = await request(appFor(stubPool(), reader)).get('/parcels/HR-000000-1/history');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            parcelUid: 'HR-000000-1',
            anchor: { account: deriveParcelAnchor('HR-000000-1'), exists: false, source: 'chain' },
            events: []
        });
        expect(reader).toHaveBeenCalledWith(deriveParcelAnchor('HR-000000-1'), 'HR-000000-1');
    });

    it('keeps anchor existence unknown when the chain read fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const history = await loadParcelHistory(stubPool(), 'HR-1-2', { readAnchorAccount: async () => { throw new Error('rpc down'); } });
        expect(history.anchor).toEqual({ account: deriveParcelAnchor('HR-1-2'), exists: null, source: 'unavailable' });
        warn.mockRestore();
    });

    it('preserves unknown when no account reader exists and skips unseedable IDs', async () => {
        const pool = stubPool();
        expect((await loadParcelHistory(pool, PARCEL)).anchor).toEqual({ account: deriveParcelAnchor(PARCEL), exists: null, source: 'unavailable' });
        const reader = vi.fn();
        expect((await loadParcelHistory(pool, 'x'.repeat(33), { readAnchorAccount: reader })).anchor).toEqual({ account: null, exists: false, source: 'unseedable' });
        expect(reader).not.toHaveBeenCalled();
    });

    it.each([null, undefined, 'true', 1])('does not coerce an invalid account observation into existence: %j', async value => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const history = await loadParcelHistory(stubPool(), PARCEL, { readAnchorAccount: async () => value });
        expect(history.anchor).toMatchObject({ exists: null, source: 'unavailable' });
        warn.mockRestore();
    });

    it('invents no time: untimed sources keep at null and sort last', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
        const pool = stubPool({
            agreements: [agreementRow({ created_at: null })],
            attestations: [{ ...attestationRow, issued_at: null }],
            landEvents: [{ ...executedRow, source_observed_at: new Date('2026-09-21T09:00:00Z') }]
        });
        const history = await loadParcelHistory(pool, PARCEL);
        expect(history.events.map(event => [event.type, event.at])).toEqual([
            ['agreement_executed', '2026-09-21T09:00:00.000Z'],
            ['agreement_published', null],
            ['parcel_ownership', null]
        ]);
        expect(JSON.stringify(history)).not.toContain('2030');
    });

    it('shapes an execution without an attestation and an agreement without a title', () => {
        const event = landEventHistoryEvent({ ...executedRow, evidence: { ...executedRow.evidence, attestation: null, source: {} } });
        expect(event).not.toHaveProperty('attestation');
        expect(event.link).toBe(executedRow.source_url);
        expect(agreementEvent(agreementRow({ title: null }))).toEqual({ type: AGREEMENT_PUBLISHED_EVENT_TYPE, at: '2026-09-16T10:00:00.000Z', agreementCid: CID, link: `/agreements/${CID}` });
    });

    it('derives the anchor exactly like parcel_nft, and none for ids longer than a seed', () => {
        const expected = PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(PARCEL)], new PublicKey(PARCEL_PROGRAM_ID))[0].toBase58();
        expect(deriveParcelAnchor(PARCEL)).toBe(expected);
        expect(deriveParcelAnchor('x'.repeat(33))).toBeNull();
    });

    it('orders by time, then publication before ownership before execution, then a stable key', () => {
        const at = '2026-01-01T00:00:00.000Z';
        const sorted = sortHistory([
            { type: 'agreement_executed', at, agreementCid: 'b' }, { type: 'x', at: null }, { type: OWNERSHIP_EVENT_TYPE, at },
            { type: 'agreement_executed', at, agreementCid: 'a' }, { type: AGREEMENT_PUBLISHED_EVENT_TYPE, at },
            { type: 'agreement_executed', at: '2025-12-31T00:00:00.000Z', agreementCid: 'c' }
        ]);
        expect(sorted.map(event => `${event.type}${event.agreementCid ? `:${event.agreementCid}` : ''}`)).toEqual([
            'agreement_executed:c', 'agreement_published', 'parcel_ownership', 'agreement_executed:a', 'agreement_executed:b', 'x'
        ]);
    });

    it('rejects an unprintable parcel id', async () => {
        const res = await request(appFor(stubPool())).get('/parcels/%01bad/history');
        expect(res.status).toBe(400);
    });
});

describe('GET /oracle/events?parcelUid=', () => {
    it('filters execution entries to the parcel', async () => {
        const pool = stubPool({ landEvents: [{ ...executedRow, subject_type: 'parcel', attester: AGREEMENT_PROGRAM_ID, created_at: '2026-09-21T09:01:00Z' }] });
        const res = await request(appFor(pool)).get(`/oracle/events?type=agreement_executed&parcelUid=${encodeURIComponent(PARCEL)}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ count: 1, eventType: 'agreement_executed', parcelUid: PARCEL });
        expect(res.body.events[0]).toMatchObject({ subject: { type: 'parcel', id: PARCEL }, evidence: { agreementCid: CID } });
        expect(pool.calls[0].params).toEqual(['agreement_executed', PARCEL, 25]);
    });

    it('rejects an empty parcelUid and leaves unfiltered reads unfiltered', async () => {
        const pool = stubPool();
        expect((await request(appFor(pool)).get('/oracle/events?parcelUid=')).status).toBe(400);
        const res = await request(appFor(pool)).get('/oracle/events');
        expect(res.status).toBe(200);
        expect(res.body.parcelUid).toBeUndefined();
        expect(pool.calls.at(-1).sql).not.toMatch(/inputParcelIds/);
    });
});
