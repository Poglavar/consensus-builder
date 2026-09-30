// Tests for the permanent per-parcel log: GET /parcels/:parcelUid/history (merge order, per-type
// shapes, unknown parcel, no invented time) and the ?parcelUid= filter of GET /oracle/events.

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { setupParcelHistoryRoute } from '../routes/parcel-history.js';
import { setupLandEventsRoute } from '../routes/land-events.js';
import { deriveParcelAnchor, loadParcelHistory, PARCEL_PROGRAM_ID, sortHistory } from '../oracle/parcel-history.js';

const PARCEL = 'HR-335347-1208/3';
const PROPOSAL_ACCOUNT = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const NOTARY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const OWNER = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const MINT_TX = 'mintSig111';
const ATTESTATION = '12VxrWBkHfabA1jdV9HfniPNSj95Tp16uhXprpXzPgWk';

function proposalRow(overrides = {}) {
    return {
        proposal_id: 'agent-01-2026-09-16-1',
        title: 'Densify the corner',
        name: null,
        created_at: new Date('2026-09-16T10:00:00Z'),
        onchain_data: { proposalId: PROPOSAL_ACCOUNT, transactionHash: MINT_TX, lens: [NOTARY] },
        proposal_account: PROPOSAL_ACCOUNT,
        mint_block_time: String(Date.parse('2026-09-16T10:05:00Z') / 1000),
        ...overrides
    };
}

const attestationRow = {
    address: ATTESTATION, authority: NOTARY, owner: OWNER, owner_count: '2',
    account_hash: 'ab'.repeat(32), transaction_signature: 'attestSig', issued_at: new Date('2026-09-20T08:00:00Z'),
    payload: { evidenceRef: 'case-4711-secret' }
};

const acceptanceRow = {
    event_id: 'solana:devnet:proposal_acceptance:rec1', event_type: 'proposal_acceptance', subject_id: PROPOSAL_ACCOUNT,
    outcome: 'accepted', source_url: 'https://explorer.solana.com/address/rec1?cluster=devnet', source_hash: 'sha256:' + 'cd'.repeat(32),
    source_observed_at: new Date('2026-09-21T09:00:00Z'), transaction_signature: 'acceptSig',
    evidence: {
        source: { transactionUrl: 'https://explorer.solana.com/tx/acceptSig?cluster=devnet' },
        acceptanceRecord: 'rec1', parcelUid: PARCEL, owner: OWNER, member: NOTARY, ownershipAttestation: ATTESTATION
    }
};

const lifecycleRow = {
    event_id: 'solana:devnet:proposal_lifecycle:x:executed', event_type: 'proposal_lifecycle', subject_id: PROPOSAL_ACCOUNT,
    outcome: 'executed', source_url: `https://explorer.solana.com/address/${PROPOSAL_ACCOUNT}?cluster=devnet`, source_hash: 'sha256:' + 'ef'.repeat(32),
    // Same chain time as the acceptance that executed it: the acceptance must sort first.
    source_observed_at: new Date('2026-09-21T09:00:00Z'), transaction_signature: 'acceptSig',
    evidence: { source: { transactionUrl: 'https://explorer.solana.com/tx/acceptSig?cluster=devnet' }, proposalStatusByte: 1 }
};

// Answers each query by what it reads; records every call.
function stubPool({ proposals = [], attestations = [], landEvents = [], anchorTx = { transactions: 0, first_block_time: null } } = {}) {
    const calls = [];
    return {
        calls,
        query: vi.fn(async (sql, params) => {
            calls.push({ sql, params });
            if (/FROM consensus\.solana_transaction\s+WHERE touched_addresses/.test(sql)) return { rows: [anchorTx] };
            if (/FROM proposal p/.test(sql)) return { rows: proposals };
            if (/FROM consensus\.lens_attestation/.test(sql)) return { rows: attestations };
            if (/FROM consensus\.land_event/.test(sql)) return { rows: landEvents };
            throw new Error(`unexpected query: ${sql}`);
        })
    };
}

function appFor(pool, readAnchorAccount = async () => true) {
    const app = express();
    setupParcelHistoryRoute(app, pool, { readAnchorAccount });
    setupLandEventsRoute(app, pool, { readProposalAccount: async () => null });
    return app;
}

afterEach(() => vi.useRealTimers());

describe('GET /parcels/:parcelUid/history', () => {
    it('merges proposals, attestations and land events in source-time order with per-type shapes', async () => {
        const pool = stubPool({
            proposals: [proposalRow()],
            attestations: [attestationRow],
            landEvents: [lifecycleRow, acceptanceRow],
            anchorTx: { transactions: 1, first_block_time: String(Date.parse('2026-09-16T10:04:00Z') / 1000) }
        });
        const res = await request(appFor(pool)).get(`/parcels/${encodeURIComponent(PARCEL)}/history`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.parcelUid).toBe(PARCEL);
        expect(res.body.anchor).toEqual({
            account: deriveParcelAnchor(PARCEL), exists: true, mintedAt: '2026-09-16T10:04:00.000Z', source: 'chain'
        });
        expect(res.body.events.map(e => e.type)).toEqual([
            'proposal_created', 'proposal_published', 'parcel_ownership', 'proposal_acceptance', 'proposal_lifecycle'
        ]);
        const [created, published, ownership, acceptance, lifecycle] = res.body.events;
        expect(created).toEqual({
            type: 'proposal_created', at: '2026-09-16T10:00:00.000Z', proposalId: 'agent-01-2026-09-16-1',
            proposalAccount: PROPOSAL_ACCOUNT, title: 'Densify the corner', link: '/proposals/agent-01-2026-09-16-1'
        });
        expect(published).toEqual({
            type: 'proposal_published', at: '2026-09-16T10:05:00.000Z', proposalId: 'agent-01-2026-09-16-1',
            proposalAccount: PROPOSAL_ACCOUNT, lens: [NOTARY], transaction: MINT_TX,
            link: `https://explorer.solana.com/tx/${MINT_TX}?cluster=devnet`
        });
        expect(ownership).toEqual({
            type: 'parcel_ownership', at: '2026-09-20T08:00:00.000Z', attestation: ATTESTATION, member: NOTARY,
            owner: OWNER, ownerCount: 2, hash: `sha256:${'ab'.repeat(32)}`, transaction: 'attestSig',
            link: `https://explorer.solana.com/address/${ATTESTATION}?cluster=devnet`
        });
        expect(JSON.stringify(res.body)).not.toContain('case-4711-secret');
        expect(acceptance).toMatchObject({
            type: 'proposal_acceptance', at: '2026-09-21T09:00:00.000Z', outcome: 'accepted',
            proposalId: 'agent-01-2026-09-16-1', proposalAccount: PROPOSAL_ACCOUNT, parcelUid: PARCEL,
            member: NOTARY, owner: OWNER, attestation: ATTESTATION, record: 'rec1', transaction: 'acceptSig',
            hash: `sha256:${'cd'.repeat(32)}`, link: 'https://explorer.solana.com/tx/acceptSig?cluster=devnet'
        });
        expect(lifecycle).toMatchObject({ type: 'proposal_lifecycle', outcome: 'executed', proposalAccount: PROPOSAL_ACCOUNT, transaction: 'acceptSig' });
        expect(lifecycle.member).toBeUndefined();
    });

    it('never reads the attestation payload beyond ownerCount and binds the parcel to every query', async () => {
        const pool = stubPool();
        await request(appFor(pool)).get(`/parcels/${encodeURIComponent(PARCEL)}/history`);
        const attestationSql = pool.calls.find(c => /lens_attestation/.test(c.sql)).sql;
        expect(attestationSql).toMatch(/payload->>'ownerCount'/);
        expect(attestationSql).not.toMatch(/SELECT[^;]*\bpayload\s*,/);
        expect(attestationSql).not.toMatch(/evidenceRef/);
        const landSql = pool.calls.find(c => /FROM consensus\.land_event/.test(c.sql));
        expect(landSql.sql).toMatch(/evidence->>'parcelUid' = \$1/);
        expect(landSql.sql).toMatch(/cadastre_parcel_ids @> jsonb_build_array\(\$1::text\)/);
        expect(landSql.params).toEqual([PARCEL, ['proposal_acceptance', 'proposal_lifecycle', 'proposal_verdict']]);
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
        expect(reader).toHaveBeenCalledWith(deriveParcelAnchor('HR-000000-1'));
    });

    it('falls back to the transaction store when the chain read fails', async () => {
        const pool = stubPool({ anchorTx: { transactions: 0, first_block_time: null } });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const history = await loadParcelHistory(pool, 'HR-1-2', { readAnchorAccount: async () => { throw new Error('rpc down'); } });
        expect(history.anchor).toEqual({ account: deriveParcelAnchor('HR-1-2'), exists: false, source: 'transaction-store' });
        warn.mockRestore();
    });

    it('invents no time: untimed sources keep at null and sort last', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
        const pool = stubPool({
            proposals: [proposalRow({ mint_block_time: null })],
            attestations: [{ ...attestationRow, issued_at: null }]
        });
        const history = await loadParcelHistory(pool, PARCEL);
        expect(history.events.map(e => [e.type, e.at])).toEqual([
            ['proposal_created', '2026-09-16T10:00:00.000Z'],
            ['proposal_published', null],
            ['parcel_ownership', null]
        ]);
        expect(JSON.stringify(history)).not.toContain('2030');
    });

    it('derives the anchor exactly like parcel_nft, and none for ids longer than a seed', () => {
        const expected = PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(PARCEL)], new PublicKey(PARCEL_PROGRAM_ID))[0].toBase58();
        expect(deriveParcelAnchor(PARCEL)).toBe(expected);
        expect(deriveParcelAnchor('x'.repeat(33))).toBeNull();
    });

    it('orders by time, then causal type', () => {
        const at = '2026-01-01T00:00:00.000Z';
        const sorted = sortHistory([
            { type: 'proposal_lifecycle', at }, { type: 'x', at: null }, { type: 'proposal_acceptance', at },
            { type: 'proposal_created', at: '2025-12-31T00:00:00.000Z' }
        ]);
        expect(sorted.map(e => e.type)).toEqual(['proposal_created', 'proposal_acceptance', 'proposal_lifecycle', 'x']);
    });

    it('rejects an unprintable parcel id', async () => {
        const res = await request(appFor(stubPool())).get('/parcels/%01bad/history');
        expect(res.status).toBe(400);
    });
});

describe('GET /oracle/events?parcelUid=', () => {
    it('filters land events to the parcel', async () => {
        const pool = stubPool({ landEvents: [acceptanceRow] });
        const res = await request(appFor(pool)).get(`/oracle/events?type=proposal_acceptance&parcelUid=${encodeURIComponent(PARCEL)}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ count: 1, eventType: 'proposal_acceptance', parcelUid: PARCEL });
        const call = pool.calls[0];
        expect(call.params).toEqual(['proposal_acceptance', PARCEL, 25]);
        expect(call.sql).toMatch(/evidence->>'parcelUid' = \$2::text/);
        expect(call.sql).toMatch(/cadastre_parcel_ids @> jsonb_build_array\(\$2::text\)/);
    });

    it('rejects an empty parcelUid and leaves unfiltered reads unchanged', async () => {
        const pool = stubPool();
        expect((await request(appFor(pool)).get('/oracle/events?parcelUid=')).status).toBe(400);
        const res = await request(appFor(pool)).get('/oracle/events');
        expect(res.status).toBe(200);
        expect(res.body.parcelUid).toBeUndefined();
        expect(pool.calls.at(-1).sql).not.toMatch(/parcelUid/);
    });
});
