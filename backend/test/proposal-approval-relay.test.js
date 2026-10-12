// Receipt relay for abstract owner decisions: the server admits a decision only after re-verifying
// its signatures under the browser's own rules, stores it append-only, and a second browser that
// reads it back verifies it again before counting it. Four owners across three parcels, C co-owned.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { createMemoryOwnerDecisionStore, createOwnerDecisionHandlers, OWNER_DECISION_LOCK_NAMESPACE } from '../proposals/owner-decisions.js';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { proposalDbRow } from './helpers/fixtures.js';
import { approvalConfig, at, attesterFor, decision, evidenceFor, MEMBER, outsider, proposal, TERMS, wallets } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');

const admit = (stored, receipt, item = proposal()) => relay.admit(item, stored, receipt, { now: Date.now() });
const counted = (item, approvals) => approval.validOwnerIds({ ...item, ownerApprovals: approvals }, TERMS,
    (p, r) => relay.verifyLensReceipt(p, r)).sort();

describe('admitting a relayed owner decision', () => {
    it('stores only decisions whose three signatures verify for this proposal, owner and signer', () => {
        const good = decision(wallets.c, 'owner-c');
        expect(admit([], good)).toEqual({ ok: true });

        const tampered = { ...good, effectHash: 'consent1-sha256:other-terms' };
        expect(admit([], tampered)).toMatchObject({ ok: false, status: 401, code: 'bad_signature' });
        const forged = { ...good, decisionProof: { ...good.decisionProof, signature: wallets.d.signText('anything') } };
        expect(admit([], forged)).toMatchObject({ status: 401, code: 'bad_signature' });
        // C's wallet signs a decision for D with C's evidence: the evidence names another owner.
        expect(admit([], decision(wallets.c, 'owner-d', { evidence: good.evidence }))).toMatchObject({ status: 403, code: 'not_authorized' });
        // A member outside the proposal's lens attests (for a copy that lists it): not this proposal's authority.
        const copy = proposal({ lens: [outsider.publicKey.toBase58()] });
        expect(admit([], decision(wallets.c, 'owner-c', { evidence: evidenceFor(wallets.c, 'owner-c', copy, attesterFor(outsider)) })))
            .toMatchObject({ status: 403, code: 'not_authorized' });
        expect(admit([], { ...good, ownerId: 'owner-z' })).toMatchObject({ status: 404, code: 'unknown_owner' });
        expect(admit([], good, proposal({ approvalConfig: { ...approvalConfig, rights: null } }))).toMatchObject({ status: 409, code: 'ownership_unresolved' });
        expect(admit([], good, proposal({ lifecycleStatus: 'Cancelled' }))).toMatchObject({ status: 409, code: 'proposal_closed' });
        // The decision names another proposal: its signature covers that proposal's id.
        expect(admit([], good, proposal({ proposalId: 'another-proposal' }))).toMatchObject({ status: 401, code: 'bad_signature' });
        expect(admit([], decision(wallets.c, 'owner-c', { offset: 3600 }))).toMatchObject({ status: 422, code: 'future_decision' });
        expect(admit([], { ...good, decision: 'maybe' })).toMatchObject({ status: 400, code: 'bad_request' });
        expect(admit([], { ...good, providerId: 'test-lens-signer' })).toMatchObject({ status: 422, code: 'unsupported_provider' });
        expect(admit([], null)).toMatchObject({ status: 400 });
    });

    it('keeps each owner’s decisions in signing order and applies the local withdrawal rules', () => {
        const accepted = decision(wallets.c, 'owner-c', { offset: 10 });
        expect(admit([accepted], accepted)).toEqual({ ok: true, duplicate: true });
        expect(admit([accepted], decision(wallets.c, 'owner-c', { offset: 20 }))).toMatchObject({ status: 409, code: 'already_accepted' });
        expect(admit([accepted], decision(wallets.c, 'owner-c', { offset: 5, terms: 'consent1-sha256:older' }))).toMatchObject({ status: 409, code: 'stale_decision' });
        expect(admit([accepted], decision(wallets.c2, 'owner-c', { decision: 'withdraw', offset: 30 }))).toMatchObject({ status: 403, code: 'not_your_acceptance' });
        expect(admit([], decision(wallets.d, 'owner-d', { decision: 'withdraw', offset: 30 }))).toMatchObject({ status: 409, code: 'nothing_to_withdraw' });
        const withdrawn = decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 30 });
        expect(admit([accepted], withdrawn)).toEqual({ ok: true });
        // Re-accepting new terms after the withdrawal, by the other signer for C, is a new decision.
        expect(admit([accepted, withdrawn], decision(wallets.c2, 'owner-c', { offset: 40, terms: 'consent1-sha256:terms-2' }))).toEqual({ ok: true });
        // Another owner's history does not make this one stale.
        expect(admit([withdrawn, accepted], decision(wallets.a, 'owner-a', { offset: 1 }))).toEqual({ ok: true });
    });

    it('folds decisions in any order to the same current acceptances, dropping what does not verify or apply', () => {
        const rows = [
            decision(wallets.a, 'owner-a', { offset: 1 }),
            decision(wallets.c, 'owner-c', { offset: 2 }),
            decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 3 }),
            decision(wallets.c, 'owner-c', { offset: 4 }),
            decision(wallets.d, 'owner-d', { offset: 5 }),
            decision(wallets.c2, 'owner-c', { decision: 'withdraw', offset: 6 }), // another signer cannot withdraw C's acceptance
            { ...decision(wallets.b, 'owner-b', { offset: 7 }), effectHash: TERMS + '-tampered' }
        ];
        const forward = relay.fold(proposal(), rows);
        const backward = relay.fold(proposal(), [...rows].reverse().concat(rows));
        expect(Object.keys(forward.ownerApprovals).sort()).toEqual(['owner-a', 'owner-c', 'owner-d']);
        expect(forward.ownerApprovals['owner-c'].acceptedAt).toBe(at(4));
        expect(backward).toEqual(forward);
        expect(forward.ownerApprovalHistory.map(row => `${row.decision}@${row.acceptedAt}`)).toEqual([`approve@${at(2)}`, `withdraw@${at(3)}`]);
        // Parcel C counts once both co-owners' receipts verify; B never signed, so it is not unanimous.
        const tally = approval.tally(proposal(), counted(proposal(), forward.ownerApprovals));
        expect(tally).toMatchObject({ acceptedOwners: 3, acceptedParcelIds: ['parcel-a', 'parcel-c'], passed: false });
    });
});

// The relay as an HTTP route, over the in-memory store with the database store's contract.
function relayApp(store = createMemoryOwnerDecisionStore(), published = proposal()) {
    const app = express();
    app.use(express.json());
    const handlers = createOwnerDecisionHandlers({ store, loadProposal: async id => (id === '41' || id === published.proposalId ? published : null) });
    app.get('/proposals/:id/owner-decisions', handlers.get);
    app.post('/proposals/:id/owner-decisions', handlers.post);
    return app;
}

describe('owner decision relay route', () => {
    it('stores a verified decision once, serves it, and refuses forgeries without storing them', async () => {
        const app = relayApp();
        const receipt = decision(wallets.c, 'owner-c');
        const first = await request(app).post('/proposals/41/owner-decisions').send({ receipt: { ...receipt, note: 'not signed' } });
        expect(first.status).toBe(201);
        expect(first.body).toEqual({ stored: true, duplicate: false });
        const again = await request(app).post('/proposals/41/owner-decisions').send({ receipt });
        expect(again.status).toBe(200);
        expect(again.body.duplicate).toBe(true);
        const forged = await request(app).post('/proposals/41/owner-decisions').send({ receipt: { ...receipt, ownerId: 'owner-d' } });
        expect(forged.status).toBe(403);
        expect((await request(app).post('/proposals/99/owner-decisions').send({ receipt })).status).toBe(404);

        const listed = await request(app).get('/proposals/41/owner-decisions');
        expect(listed.status).toBe(200);
        expect(listed.headers['cache-control']).toBe('no-store');
        expect(listed.body.proposalId).toBe('relay-proposal');
        expect(listed.body.decisions).toEqual([receipt]);
        expect(listed.body.decisions[0]).not.toHaveProperty('note');
    });

    it('admits concurrent decisions for one owner one at a time', async () => {
        const app = relayApp();
        const signed = [1, 2, 3].map(offset => decision(wallets.a, 'owner-a', { offset, terms: `consent1-sha256:terms-${offset}` }));
        const answers = await Promise.all([...signed].reverse().map(receipt => request(app).post('/proposals/41/owner-decisions').send({ receipt })));
        // The newest arrives first; the two older ones are then stale.
        expect(answers.map(answer => answer.status)).toEqual([201, 409, 409]);
    });

    it('locks, reads, inserts and commits through the database store', async () => {
        const pool = createMockPool();
        const receipt = decision(wallets.c, 'owner-c');
        pool.setResults([
            { rows: [proposalDbRow({ id: 41, proposal_id: 'relay-proposal', cadastre_parcel_ids: proposal().cadastreParcelIds, lens: [MEMBER],
                proposal_data: { approvalConfig } })] },
            { rows: [] }, { rows: [] }, { rows: [] }, { rows: [], rowCount: 1 }, { rows: [] }
        ]);
        const response = await request(createTestApp(pool)).post('/proposals/41/owner-decisions').send({ receipt });
        expect(response.status).toBe(201);
        const calls = pool.getCalls();
        expect(calls.slice(1).map(call => call.sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
            'BEGIN', 'SELECT pg_advisory_xact_lock($1,', 'SELECT receipt', 'INSERT INTO', 'COMMIT'
        ]);
        expect(calls[2].params).toEqual([OWNER_DECISION_LOCK_NAMESPACE, 'relay-proposal']);
        const insert = calls[4].params;
        expect(insert.slice(0, 8)).toEqual(['relay-proposal', 'owner-c', wallets.c.address, 'approve', TERMS,
            approval.contextHash(proposal()), receipt.acceptedAt, receipt.decisionProof.signature]);
        expect(JSON.parse(insert[8])).toEqual(receipt);
    });
});

describe('two browsers through the relay', () => {
    const servers = [];
    afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
    function listen(app) {
        const server = app.listen(0, '127.0.0.1');
        servers.push(server);
        return new Promise(resolve => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    }

    it('shares one browser’s acceptances and withdrawal with another, which re-verifies them', async () => {
        const base = await listen(relayApp());
        const transport = { base, fetchImpl: fetch };
        const first = proposal();
        const second = proposal();
        // Browser 1 holds A's and C's acceptances locally (recorded before it was online) and syncs.
        first.ownerApprovals = { 'owner-a': decision(wallets.a, 'owner-a', { offset: 1 }), 'owner-c': decision(wallets.c, 'owner-c', { offset: 2 }) };
        expect(await relay.sync(first, transport)).toEqual({ synced: true, changed: false, sent: 2 });
        // Browser 2 sees both and counts them only because they verify.
        expect(await relay.sync(second, transport)).toMatchObject({ synced: true, changed: true, sent: 0 });
        expect(counted(second, second.ownerApprovals)).toEqual(['owner-a', 'owner-c']);
        // Browser 2 records D's acceptance and C withdraws there; browser 1 catches up.
        second.ownerApprovals['owner-d'] = decision(wallets.d, 'owner-d', { offset: 3 });
        const withdrawal = decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 4 });
        delete second.ownerApprovals['owner-c'];
        second.ownerApprovalHistory = [...(second.ownerApprovalHistory || []), first.ownerApprovals['owner-c'], withdrawal];
        expect(await relay.sync(second, transport)).toMatchObject({ synced: true, sent: 2 });
        expect(await relay.sync(first, transport)).toMatchObject({ synced: true, changed: true });
        expect(counted(first, first.ownerApprovals)).toEqual(['owner-a', 'owner-d']);
        expect(first.ownerApprovalHistory.map(row => row.decision)).toEqual(['approve', 'withdraw']);
        // An unpublished proposal has no relay address and stays local.
        expect(await relay.push(proposal({ serverProposalId: undefined }), withdrawal, transport)).toEqual({ shared: false, code: 'not_published' });
    });

    it('ignores a relay that serves forged or foreign decisions', async () => {
        const genuine = decision(wallets.a, 'owner-a', { offset: 1 });
        const forged = { ...decision(wallets.b, 'owner-b', { offset: 2 }), effectHash: TERMS + 'x' };
        const foreign = decision(wallets.d, 'owner-d', { offset: 3, item: proposal({ proposalId: 'another-proposal' }) });
        const app = express();
        app.get('/proposals/:id/owner-decisions', (req, res) => res.json({ decisions: [genuine, forged, foreign] }));
        app.post('/proposals/:id/owner-decisions', (req, res) => res.status(201).json({ stored: true }));
        const base = await listen(app);
        const local = proposal();
        await relay.sync(local, { base, fetchImpl: fetch });
        expect(Object.keys(local.ownerApprovals)).toEqual(['owner-a']);
        expect(counted(local, local.ownerApprovals)).toEqual(['owner-a']);
    });
});
