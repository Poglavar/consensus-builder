// The server side of owner decisions on a published agreement (agreements/decisions.js,
// plan-design-agreement.md M2): the subject it builds from the indexed agreement, the relay routes at
// /agreements/:cid/decisions over its stores (re-verified with the browser's own rules, stored
// append-only, under a per-agreement lock), and the bundle pinned under the CID of its bytes. The
// relay rules themselves (admit, fold, two browsers) are covered in proposal-approval-relay.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import * as web3 from '@solana/web3.js';
import {
    AGREEMENT_DECISION_LOCK_NAMESPACE, createAgreementDecisionHandlers, createMemoryAgreementDecisionStore, decisionSubject
} from '../agreements/decisions.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { agreementRow } from './helpers/content-fixtures.js';
import { serializeAgreementRow } from '../routes/agreements.js';
import {
    AGREEMENT_CID, COUNTER_AGREEMENT_CID, agreement, agreementContent, attesterFor, decision, evidenceFor, outsider, wallets
} from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const anchors = require('../../frontend/js/proposals/approval-anchor.js');

const OTHER_CID = COUNTER_AGREEMENT_CID;
const ACCOUNT = web3.Keypair.generate().publicKey.toBase58();
// The index's `onchain` once the agreement is minted (agreements/onchain.js onchainFromAccount).
const ONCHAIN = { chain: 'solana', cluster: 'devnet', account: ACCOUNT, status: 'active', decision: 'pending' };
const decisionsPath = (cid = AGREEMENT_CID) => `/agreements/${cid}/decisions`;
// The agreement as GET /agreements/:cid serves it, and its row in consensus.agreement.
const ownerDealContent = agreementContent;
const indexedAgreement = (content = agreementContent(), overrides = {}) => serializeAgreementRow(agreementRow(content, overrides));

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('the subject of a decision', () => {
    it('is the indexed agreement\'s CID, input parcels and rule, with the lifecycle of its index status', () => {
        expect(decisionSubject(indexedAgreement())).toEqual({ ...agreement(), onchain: null });
        // The index status is the chain's once minted, else expired after the deadline (routes/agreements.js).
        for (const [status, lifecycle] of [['active', 'Active'], ['expired', 'Expired'], ['executed', 'Executed'], ['cancelled', 'Cancelled']]) {
            expect(decisionSubject(indexedAgreement(undefined, { status })).lifecycleStatus).toBe(lifecycle);
        }
        expect(decisionSubject(indexedAgreement(undefined, { onchain: ONCHAIN })).onchain).toEqual(ONCHAIN);
        const community = indexedAgreement(ownerDealContent({ rule: { electorate: 'community', binding: false, lens: [] } }));
        expect(decisionSubject(community)).toMatchObject({ approvalConfig: null, lens: [] });
    });

    it('signs agreement-decision/v1 naming the agreement\'s CID, with no terms hash', async () => {
        const receipt = await decision(wallets.c, 'owner-c');
        expect(approval.decisionContent(agreement(), receipt)).toEqual({
            schema: 'agreement-decision/v1', agreementCid: AGREEMENT_CID, ownerId: 'owner-c', actorId: wallets.c.address,
            contextHash: approval.contextHash(agreement()), decision: 'approve', decidedAt: receipt.decidedAt
        });
        expect(() => approval.decisionContent(agreement({ agreementCid: 'local-draft-1' }), receipt)).toThrow(/agreementCid is not a CID/);
    });
});

// The relay as the content routes register it, over the in-memory store and a pool that holds the
// indexed agreements.
function relayApp({ rows = [agreementRow(ownerDealContent())], store = createMemoryAgreementDecisionStore(), ...overrides } = {}) {
    const pool = createMockPool();
    pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, (sql, params) => ({ rows: rows.filter(row => row.cid === params[0]) }));
    return { app: createContentApp(pool, { decisionStore: store, thumbnailQueue: { enqueue: vi.fn() }, ...overrides }), pool, store };
}

describe('POST and GET /agreements/:cid/decisions', () => {
    it('stores a verified decision once, serves it, and refuses forgeries without storing them', async () => {
        const { app } = relayApp();
        const receipt = await decision(wallets.c, 'owner-c');
        const first = await request(app).post(decisionsPath()).send({ receipt: { ...receipt, note: 'not signed' } });
        expect(first.status).toBe(201);
        expect(first.body).toEqual({ stored: true, duplicate: false });
        const again = await request(app).post(decisionsPath()).send({ receipt });
        expect(again.status).toBe(200);
        expect(again.body.duplicate).toBe(true);
        const forged = await request(app).post(decisionsPath()).send({ receipt: { ...receipt, ownerId: 'owner-d' } });
        expect([forged.status, forged.body.code]).toEqual([403, 'not_authorized']);
        const missing = await request(app).post(decisionsPath(OTHER_CID)).send({ receipt });
        expect([missing.status, missing.body.code]).toEqual([404, 'agreement_not_found']);
        const invalid = await request(app).post('/agreements/41/decisions').send({ receipt });
        expect([invalid.status, invalid.body.code]).toEqual([400, 'invalid_cid']);

        const listed = await request(app).get(decisionsPath());
        expect(listed.status).toBe(200);
        expect(listed.headers['cache-control']).toBe('no-store');
        expect(listed.body.agreementCid).toBe(AGREEMENT_CID);
        expect(listed.body.decisions).toEqual([receipt]);
        expect(listed.body.decisions[0]).not.toHaveProperty('note');
        expect((await request(app).get(decisionsPath(OTHER_CID))).status).toBe(404);
    });

    it('takes no decision on an agreement that expired, was cancelled, or executed', async () => {
        const receipt = await decision(wallets.c, 'owner-c');
        for (const status of ['expired', 'cancelled', 'executed']) {
            const { app, store } = relayApp({ rows: [agreementRow(ownerDealContent(), { status })] });
            const res = await request(app).post(decisionsPath()).send({ receipt });
            expect([status, res.status, res.body.code]).toEqual([status, 409, 'agreement_closed']);
            expect(await store.list(AGREEMENT_CID)).toEqual([]);
        }
    });

    it('admits concurrent decisions for one owner one at a time', async () => {
        const { app } = relayApp();
        const signed = await Promise.all([1, 2, 3].map(offset => decision(wallets.a, 'owner-a', { offset })));
        const answers = await Promise.all([...signed].reverse().map(receipt => request(app).post(decisionsPath()).send({ receipt })));
        // The newest arrives first; the two older ones are then stale.
        expect(answers.map(answer => answer.status)).toEqual([201, 409, 409]);
        expect(answers.slice(1).map(answer => answer.body.code)).toEqual(['stale_decision', 'stale_decision']);
    });

    it('locks, reads, inserts and commits through the database store, keyed by the agreement\'s CID', async () => {
        const pool = createMockPool();
        pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, { rows: [agreementRow(ownerDealContent())] });
        const app = createContentApp(pool, { thumbnailQueue: { enqueue: vi.fn() } });
        const receipt = await decision(wallets.c, 'owner-c');
        const response = await request(app).post(decisionsPath()).send({ receipt });
        expect(response.status).toBe(201);
        const calls = pool.getCalls().slice(1);
        expect(calls.map(call => call.sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
            'BEGIN', 'SELECT pg_advisory_xact_lock($1,', 'SELECT receipt', 'INSERT INTO', 'COMMIT'
        ]);
        expect(calls[1].params).toEqual([AGREEMENT_DECISION_LOCK_NAMESPACE, AGREEMENT_CID]);
        expect(calls[2].sql).toMatch(/FROM consensus\.agreement_decision WHERE agreement_cid = \$1 ORDER BY decided_at, signature/);
        expect(calls[2].params).toEqual([AGREEMENT_CID]);
        expect(calls[3].sql).toMatch(/INSERT INTO consensus\.agreement_decision/);
        // decided_at is the signed time, never the time of receipt.
        expect(calls[3].params.slice(0, 7)).toEqual([AGREEMENT_CID, 'owner-c', wallets.c.address, 'approve',
            approval.contextHash(agreement()), receipt.decidedAt, receipt.decisionProof.signature]);
        expect(JSON.parse(calls[3].params[7])).toEqual(receipt);
    });

    it('rolls back a refused or failed decision and stores nothing', async () => {
        const pool = createMockPool();
        pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, { rows: [agreementRow(ownerDealContent())] });
        pool.answer(/INSERT INTO consensus\.agreement_decision/, () => { throw new Error('disk full'); });
        const app = createContentApp(pool, { thumbnailQueue: { enqueue: vi.fn() } });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await request(app).post(decisionsPath()).send({ receipt: await decision(wallets.c, 'owner-c') });
        expect(error).toHaveBeenCalled();
        expect(failed.status).toBe(500);
        expect(pool.getCalls().map(call => call.sql.trim().split(/\s+/)[0]).at(-1)).toBe('ROLLBACK');

        pool.reset();
        pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, { rows: [agreementRow(ownerDealContent())] });
        const refused = await request(app).post(decisionsPath()).send({ receipt: { ...(await decision(wallets.c, 'owner-c')), ownerId: 'owner-z' } });
        expect(refused.status).toBe(404);
        expect(pool.getCalls().some(call => /INSERT INTO/.test(call.sql))).toBe(false);
        expect(pool.getCalls().map(call => call.sql.trim().split(/\s+/)[0]).at(-1)).toBe('COMMIT');
    });
});

describe('POST /agreements/:cid/decisions/bundle', () => {
    const mintedRows = () => [agreementRow(ownerDealContent(), { onchain: ONCHAIN })];
    const pinner = () => vi.fn(async ({ cid }) => ({ cid, pinnedAt: '2026-10-21T10:00:00.000Z' }));

    it('pins the applying decisions of a minted agreement once, under the CID of the bundle\'s bytes', async () => {
        const pinBytes = pinner();
        const { app } = relayApp({ rows: mintedRows(), pinBytes });
        const bundlePath = `${decisionsPath()}/bundle`;
        expect((await request(app).post(bundlePath)).body.code).toBe('nothing_to_anchor');
        for (const receipt of [await decision(wallets.a, 'owner-a', { offset: 1 }), await decision(wallets.c, 'owner-c', { offset: 2 })]) {
            expect((await request(app).post(decisionsPath()).send({ receipt })).status).toBe(201);
        }
        const first = await request(app).post(bundlePath);
        expect(first.status).toBe(200);
        expect(pinBytes).toHaveBeenCalledTimes(1);
        const [{ bytes, cid, name }] = pinBytes.mock.calls[0];
        const bundle = JSON.parse(Buffer.from(bytes).toString('utf8'));
        expect(bundle).toMatchObject({ schema: anchors.BUNDLE_SCHEMA, subject: AGREEMENT_CID, contextHash: approval.contextHash(agreement()) });
        expect(bundle.decisions.map(row => row.ownerId)).toEqual(['owner-a', 'owner-c']);
        expect(Buffer.from(bytes).equals(canonicalBytes(bundle))).toBe(true);
        expect(cid).toBe(cidOf(bytes));
        expect(name).toBe(`agreement-decisions-${cid}`);
        // The anchor hash is the digest the CID carries: the same bytes, hashed once.
        expect(first.body).toEqual({ uri: `ipfs://${cid}`, cid, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            subject: AGREEMENT_CID, count: 2 });
        expect(first.body.hash).toBe(anchors.hashOf(bundle));

        const again = await request(app).post(bundlePath);
        expect(again.body).toEqual(first.body);
        expect(pinBytes).toHaveBeenCalledTimes(1);
    });

    it('refuses an agreement that is not minted, and reports pinning failures', async () => {
        const unminted = relayApp({ pinBytes: pinner() });
        const notMinted = await request(unminted.app).post(`${decisionsPath()}/bundle`);
        expect([notMinted.status, notMinted.body.code]).toEqual([409, 'not_minted']);
        expect((await request(unminted.app).post(`${decisionsPath(OTHER_CID)}/bundle`)).status).toBe(404);

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const [thrown, status, code] of [
            [Object.assign(new Error('unconfigured'), { code: 'pinning-unconfigured', status: 503 }), 503, 'pinning_unconfigured'],
            [Object.assign(new Error('pinata down'), { code: 'pin-failed', status: 502 }), 502, 'pin_failed']
        ]) {
            const store = createMemoryAgreementDecisionStore();
            const { app } = relayApp({ rows: mintedRows(), store, pinBytes: vi.fn(async () => { throw thrown; }) });
            expect((await request(app).post(decisionsPath()).send({ receipt: await decision(wallets.a, 'owner-a') })).status).toBe(201);
            const res = await request(app).post(`${decisionsPath()}/bundle`);
            expect([res.status, res.body.code]).toEqual([status, code]);
        }
        expect(error).toHaveBeenCalled();
    });

    it('is behind the per-client upload limiter', async () => {
        const pinBytes = pinner();
        const { app } = relayApp({ rows: mintedRows(), pinBytes, uploadRateLimiter: (req, res) => res.status(429).json({ error: 'Too many uploads' }) });
        expect((await request(app).post(`${decisionsPath()}/bundle`)).status).toBe(429);
        // Decisions themselves are not uploads.
        expect((await request(app).post(decisionsPath()).send({ receipt: await decision(wallets.a, 'owner-a') })).status).toBe(201);
    });
});

describe('createAgreementDecisionHandlers', () => {
    it('re-verifies against the agreement it loads, never the one a client describes', async () => {
        const store = createMemoryAgreementDecisionStore();
        const handlers = createAgreementDecisionHandlers({
            store, loadAgreement: async cid => (cid === AGREEMENT_CID ? indexedAgreement() : null)
        });
        const app = express();
        app.use(express.json());
        app.post('/agreements/:cid/decisions', handlers.post);
        // A client claiming another lens in the body changes nothing: the receipt must verify for the indexed rule.
        const copy = agreement({ lens: [outsider.publicKey.toBase58()] });
        const receipt = await decision(wallets.c, 'owner-c', { evidence: await evidenceFor(wallets.c, 'owner-c', copy, attesterFor(outsider)), item: copy });
        const res = await request(app).post(decisionsPath()).send({ receipt, agreement: copy });
        expect([res.status, res.body.code]).toEqual([403, 'not_authorized']);
        expect(await store.list(AGREEMENT_CID)).toEqual([]);
    });
});
