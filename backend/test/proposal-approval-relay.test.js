// Receipt relay for owner decisions on an agreement: the server admits a decision only after
// re-verifying its signatures under the browser's own rules, stores it append-only, and a second
// browser that reads it back verifies it again before counting it. Every decision signs the
// agreement's CID (agreement-decision/v1), so it counts for that agreement and no other, not even a
// counter-agreement over the same land. Four owners across three parcels, C co-owned.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import { createAgreementDecisionHandlers, createMemoryAgreementDecisionStore, decisionSubject } from '../agreements/decisions.js';
import { serializeAgreementRow } from '../routes/agreements.js';
import {
    AGREEMENT_CID, COUNTER_AGREEMENT_CID, DESIGN_CID, PARCEL_IDS, agreement, agreementContent, approvalConfig, at, attesterFor,
    decision, evidenceFor, outsider, wallets
} from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');

const admit = (stored, receipt, item = agreement()) => relay.admit(item, stored, receipt, { now: Date.now() });
const counted = (item, approvals) => approval.validOwnerIds({ ...item, ownerApprovals: approvals }, relay.verifyLensReceipt).sort();

// The agreement's row in consensus.agreement, as routes/agreements.js loadAgreement reads it.
const agreementDbRow = (overrides = {}) => ({
    cid: AGREEMENT_CID, city: 'test-city', title: 'Block readjustment', author: 'Test author',
    design_cids: [DESIGN_CID], input_parcel_ids: PARCEL_IDS, parcel_source_id: null, deadline: null, status: 'active',
    content: agreementContent(), onchain: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
    created_at: new Date('2026-10-21T10:00:00.000Z'), ...overrides
});

describe('admitting a relayed owner decision', () => {
    it('stores only decisions whose three signatures verify for this agreement, owner and signer', async () => {
        const good = await decision(wallets.c, 'owner-c');
        expect(admit([], good)).toEqual({ ok: true });

        // The signature covers every field of the statement: another time or decision is unsigned.
        expect(admit([], { ...good, decidedAt: at(1) })).toMatchObject({ ok: false, status: 401, code: 'bad_signature' });
        expect(admit([], { ...good, decision: 'withdraw' })).toMatchObject({ status: 401, code: 'bad_signature' });
        const forged = { ...good, decisionProof: { ...good.decisionProof, signature: wallets.d.signText('anything') } };
        expect(admit([], forged)).toMatchObject({ status: 401, code: 'bad_signature' });
        // C's wallet signs a decision for D with C's evidence: the evidence names another owner.
        expect(admit([], await decision(wallets.c, 'owner-d', { evidence: good.evidence }))).toMatchObject({ status: 403, code: 'not_authorized' });
        // A member outside the agreement's lens attests (for a copy that lists it): not this agreement's authority.
        const copy = agreement({ lens: [outsider.publicKey.toBase58()] });
        expect(admit([], await decision(wallets.c, 'owner-c', { evidence: await evidenceFor(wallets.c, 'owner-c', copy, attesterFor(outsider)) })))
            .toMatchObject({ status: 403, code: 'not_authorized' });
        expect(admit([], { ...good, ownerId: 'owner-z' })).toMatchObject({ status: 404, code: 'unknown_owner' });
        expect(admit([], good, agreement({ approvalConfig: { ...approvalConfig, rights: null } }))).toMatchObject({ status: 409, code: 'ownership_unresolved' });
        // A closed agreement takes no decision; an executed one takes no new acceptance.
        for (const lifecycleStatus of ['Expired', 'Cancelled', 'Executed']) {
            expect(admit([], good, agreement({ lifecycleStatus }))).toMatchObject({ status: 409, code: 'agreement_closed' });
        }
        // The decision signs this agreement's CID: a counter-agreement over the same land and rule
        // (another CID) does not count it.
        expect(admit([], good, agreement({ agreementCid: COUNTER_AGREEMENT_CID }))).toMatchObject({ status: 401, code: 'bad_signature' });
        expect(admit([], await decision(wallets.c, 'owner-c', { offset: 3600 }))).toMatchObject({ status: 422, code: 'future_decision' });
        expect(admit([], { ...good, decision: 'maybe' })).toMatchObject({ status: 400, code: 'bad_request' });
        expect(admit([], { ...good, decidedAt: '2026-10-21' })).toMatchObject({ status: 400, code: 'bad_request' });
        expect(admit([], { ...good, providerId: 'test-lens-signer' })).toMatchObject({ status: 422, code: 'unsupported_provider' });
        expect(admit([], { ...good, padding: 'x'.repeat(relay.MAX_RECEIPT_BYTES) })).toMatchObject({ status: 413, code: 'too_large' });
        expect(admit([], null)).toMatchObject({ status: 400 });
    });

    it('keeps each owner’s decisions in signing order and applies the local withdrawal rules', async () => {
        const accepted = await decision(wallets.c, 'owner-c', { offset: 10 });
        expect(admit([accepted], accepted)).toEqual({ ok: true, duplicate: true });
        expect(admit([accepted], await decision(wallets.c, 'owner-c', { offset: 20 }))).toMatchObject({ status: 409, code: 'already_accepted' });
        expect(admit([accepted], await decision(wallets.c, 'owner-c', { offset: 5 }))).toMatchObject({ status: 409, code: 'stale_decision' });
        expect(admit([accepted], await decision(wallets.c2, 'owner-c', { decision: 'withdraw', offset: 30 }))).toMatchObject({ status: 403, code: 'not_your_acceptance' });
        expect(admit([], await decision(wallets.d, 'owner-d', { decision: 'withdraw', offset: 30 }))).toMatchObject({ status: 409, code: 'nothing_to_withdraw' });
        const withdrawn = await decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 30 });
        expect(admit([accepted], withdrawn)).toEqual({ ok: true });
        // Accepting again after the withdrawal, by the other signer for C, is a new decision.
        expect(admit([accepted, withdrawn], await decision(wallets.c2, 'owner-c', { offset: 40 }))).toEqual({ ok: true });
        // Another owner's history does not make this one stale.
        expect(admit([withdrawn, accepted], await decision(wallets.a, 'owner-a', { offset: 1 }))).toEqual({ ok: true });
    });

    it('folds decisions in any order to the same current acceptances, dropping what does not verify or apply', async () => {
        const rows = [
            await decision(wallets.a, 'owner-a', { offset: 1 }),
            await decision(wallets.c, 'owner-c', { offset: 2 }),
            await decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 3 }),
            await decision(wallets.c, 'owner-c', { offset: 4 }),
            await decision(wallets.d, 'owner-d', { offset: 5 }),
            await decision(wallets.c2, 'owner-c', { decision: 'withdraw', offset: 6 }), // another signer cannot withdraw C's acceptance
            { ...(await decision(wallets.b, 'owner-b', { offset: 7 })), decidedAt: at(8) }, // restamped after signing
            await decision(wallets.b, 'owner-b', { offset: 9, item: agreement({ agreementCid: COUNTER_AGREEMENT_CID }) }) // the counter-agreement's
        ];
        const forward = relay.fold(agreement(), rows);
        const backward = relay.fold(agreement(), [...rows].reverse().concat(rows));
        expect(Object.keys(forward.ownerApprovals).sort()).toEqual(['owner-a', 'owner-c', 'owner-d']);
        expect(forward.ownerApprovals['owner-c'].decidedAt).toBe(at(4));
        expect(backward).toEqual(forward);
        expect(forward.ownerApprovalHistory.map(row => `${row.decision}@${row.decidedAt}`)).toEqual([`approve@${at(2)}`, `withdraw@${at(3)}`]);
        // Parcel C counts once both co-owners' receipts verify; B never signed this one, so it is not unanimous.
        const tally = approval.tally(agreement(), counted(agreement(), forward.ownerApprovals));
        expect(tally).toMatchObject({ acceptedOwners: 3, acceptedParcelIds: ['parcel-a', 'parcel-c'], passed: false });
        // The counter-agreement folds only the decision taken on it; a draft without a CID folds none.
        expect(Object.keys(relay.fold(agreement({ agreementCid: COUNTER_AGREEMENT_CID }), rows).ownerApprovals)).toEqual(['owner-b']);
        expect(relay.fold(agreement({ agreementCid: undefined }), rows).ownerApprovals).toEqual({});
    });
});

// The relay as an HTTP route, over the in-memory store with the database store's contract.
function relayApp(store = createMemoryAgreementDecisionStore(), row = agreementDbRow()) {
    const app = express();
    app.use(express.json());
    const indexed = serializeAgreementRow(row);
    const handlers = createAgreementDecisionHandlers({ store, loadAgreement: async cid => (cid === indexed.cid ? indexed : null) });
    app.get('/agreements/:cid/decisions', handlers.get);
    app.post('/agreements/:cid/decisions', handlers.post);
    return app;
}

// The route itself (storing once, refusing forgeries, expiry, one decision at a time, the database
// store and the bundle route) is covered by agreement-decisions.test.js; here only the contract
// between the index and the browser.
describe('owner decision relay route', () => {
    it('decides on the agreement the index holds exactly as the browser decides on it', () => {
        const indexed = serializeAgreementRow(agreementDbRow());
        expect(decisionSubject(indexed)).toEqual({ ...agreement(), onchain: null });
        expect(approval.contextHash(decisionSubject(indexed))).toBe(approval.contextHash(agreement()));
        // The index computes expiry from the deadline, and executed or cancelled from the minted account
        // (routes/agreements.js); the relay then refuses decisions, as the browser's own rules do.
        expect(decisionSubject(serializeAgreementRow(agreementDbRow({ status: 'expired' })))).toMatchObject({ lifecycleStatus: 'Expired' });
        expect(decisionSubject(serializeAgreementRow(agreementDbRow({ status: 'cancelled' })))).toMatchObject({ lifecycleStatus: 'Cancelled' });
        expect(decisionSubject(serializeAgreementRow(agreementDbRow({ status: 'executed' })))).toMatchObject({ lifecycleStatus: 'Executed' });
    });
});

describe('two browsers through the relay', () => {
    const servers = [];
    afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
    function listen(app) {
        const server = app.listen(0);
        servers.push(server);
        return new Promise(resolve => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    }

    it('shares one browser’s acceptances and withdrawal with another, which re-verifies them', async () => {
        const base = await listen(relayApp());
        const transport = { base, fetchImpl: fetch };
        const first = agreement();
        const second = agreement();
        // Browser 1 holds A's and C's acceptances locally (recorded before it was online) and syncs.
        first.ownerApprovals = { 'owner-a': await decision(wallets.a, 'owner-a', { offset: 1 }), 'owner-c': await decision(wallets.c, 'owner-c', { offset: 2 }) };
        expect(await relay.sync(first, transport)).toEqual({ synced: true, changed: false, sent: 2 });
        // Browser 2 sees both and counts them only because they verify.
        expect(await relay.sync(second, transport)).toMatchObject({ synced: true, changed: true, sent: 0 });
        expect(counted(second, second.ownerApprovals)).toEqual(['owner-a', 'owner-c']);
        // Browser 2 records D's acceptance and C withdraws there; browser 1 catches up.
        second.ownerApprovals['owner-d'] = await decision(wallets.d, 'owner-d', { offset: 3 });
        const withdrawal = await decision(wallets.c, 'owner-c', { decision: 'withdraw', offset: 4 });
        delete second.ownerApprovals['owner-c'];
        second.ownerApprovalHistory = [...(second.ownerApprovalHistory || []), first.ownerApprovals['owner-c'], withdrawal];
        expect(await relay.sync(second, transport)).toMatchObject({ synced: true, sent: 2 });
        expect(await relay.sync(first, transport)).toMatchObject({ synced: true, changed: true });
        expect(counted(first, first.ownerApprovals)).toEqual(['owner-a', 'owner-d']);
        expect(first.ownerApprovalHistory.map(row => row.decision)).toEqual(['approve', 'withdraw']);
        // A draft agreement (no CID yet) has no relay address and stays local.
        expect(await relay.push(agreement({ agreementCid: undefined }), withdrawal, transport)).toEqual({ shared: false, code: 'not_published' });
        expect(await relay.pull(agreement({ agreementCid: undefined }), transport)).toBeNull();
    });

    it('ignores a relay that serves forged or foreign decisions', async () => {
        const genuine = await decision(wallets.a, 'owner-a', { offset: 1 });
        const forged = { ...(await decision(wallets.b, 'owner-b', { offset: 2 })), decidedAt: at(3) };
        const foreign = await decision(wallets.d, 'owner-d', { offset: 3, item: agreement({ agreementCid: COUNTER_AGREEMENT_CID }) });
        const app = express();
        app.get('/agreements/:cid/decisions', (req, res) => res.json({ decisions: [genuine, forged, foreign] }));
        app.post('/agreements/:cid/decisions', (req, res) => res.status(201).json({ stored: true }));
        const base = await listen(app);
        const local = agreement();
        await relay.sync(local, { base, fetchImpl: fetch });
        expect(Object.keys(local.ownerApprovals)).toEqual(['owner-a']);
        expect(counted(local, local.ownerApprovals)).toEqual(['owner-a']);
    });
});
