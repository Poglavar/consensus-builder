// Real signed reports exercise the relay's admission, exact pinning and append-only readback.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { canonicalBytes, cidOf, cidOfObject } from '../cid.js';
import { createCommunityReportStore, createMemoryCommunityReportStore, MAX_COMMUNITY_REPORT_BYTES } from '../agreements/community-reports.js';
import { createContentApp } from './helpers/create-app.js';
import { createMockPool } from './helpers/mock-pool.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { agreementContent as ownerContent } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const result = require('../../frontend/js/community/result.js');
const didWeb = require('../../frontend/js/community/did-web.js');
const lens = require('../../frontend/js/lens-core.js');
const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const DID = 'did:web:community.example';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const address = lens.base58Encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
const signer = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${address}`;
const DESIGN_CID = cidOfObject({ schema: 'design/v1', title: 'Community plan design' });
const PLAN_CID = cidOfObject({ schema: 'plan/v1', title: 'Community consultation plan', designCids: [DESIGN_CID], view: { at: '45.8,15.97,15', mode: '2d' } });
const ownerPlanContent = (overrides = {}) => {
    const content = ownerContent(overrides);
    delete content.designs;
    content.planCid = PLAN_CID;
    return content;
};
const agreementContent = {
    schema: 'agreement/v1', planCid: PLAN_CID, rule: { electorate: 'community', binding: false },
    consultation: { organiser: DID, participationUrl: null }, deadline: '2026-10-01T10:00:00.000Z'
};
const AGREEMENT = cidOfObject(agreementContent);
const MISSING = cidOfObject({ missing: true });
const path = (cid = AGREEMENT) => `/agreements/${cid}/community-reports`;
const document = {
    id: DID, verificationMethod: [{ id: `${DID}#reporter`, controller: DID, type: 'BlockchainVerificationMethod2021', blockchainAccountId: signer }],
    assertionMethod: [`${DID}#reporter`]
};

async function report(overrides = {}) {
    const content = {
        schema: 'community-result/v1', agreementCid: AGREEMENT, attester: DID, signer,
        statement: 'The consultation is complete.', url: 'https://community.example/results',
        postedAt: new Date(NOW).toISOString(), didDocumentSha256: await didWeb.documentHash(document),
        didDocument: document, ...overrides
    };
    content.proof = { scheme: 'ed25519-wallet/v1', signature: lens.base58Encode(sign(null, Buffer.from(result.reportMessage(content)), privateKey)) };
    return { cid: cidOfObject(content), content };
}

function appFor({ agreement = agreementContent, reportStore = createMemoryCommunityReportStore(), reportPinBytes = vi.fn(async () => ({})), ...overrides } = {}) {
    const pool = createMockPool();
    pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, (_sql, params) => ({ rows: params[0] === AGREEMENT && agreement ? [{
        cid: AGREEMENT, content: agreement, status: 'expired', deadline: agreement.deadline,
        design_cids: [DESIGN_CID], input_parcel_ids: []
    }] : [] }));
    return { pool, reportStore, reportPinBytes, app: createContentApp(pool, { reportStore, reportPinBytes, now: () => NOW, ...overrides }) };
}

afterEach(() => vi.restoreAllMocks());

describe('NGO community report relay', () => {
    it('validates canonical consultation metadata and excludes owner finance and allocations', () => {
        const community = ownerPlanContent({ rule: { electorate: 'community', binding: false, lens: [] }, consultation: { organiser: DID, participationUrl: 'https://community.example/participate' } });
        expect(validateAgreementContent(community).ok).toBe(true);
        expect(validateAgreementContent({ ...community, consultation: null }).ok).toBe(true);
        expect(validateAgreementContent({ ...community, consultation: { organiser: null, participationUrl: null } }).ok).toBe(true);
        for (const consultation of [
            { organiser: DID }, { organiser: DID, participationUrl: null, unknown: true },
            { organiser: 'community.example', participationUrl: null },
            { organiser: 'did:web:localhost', participationUrl: null },
            { organiser: DID, participationUrl: 'http://community.example/' },
            { organiser: DID, participationUrl: 'https://community.example' },
            { organiser: null, participationUrl: 'https://community.example/' + 'x'.repeat(2048) },
            { organiser: 42, participationUrl: null }
        ]) expect(validateAgreementContent({ ...community, consultation })).toMatchObject({ ok: false, section: 'consultation' });
        expect(validateAgreementContent(ownerPlanContent({ consultation: community.consultation, rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [] } }))).toMatchObject({ ok: false, section: 'consultation' });
        expect(validateAgreementContent({ ...community, money: { currency: 'EUR', lines: [{ ownerKey: 'owner-a', amountCents: 1 }] } })).toMatchObject({ ok: false, section: 'money' });
        const hash = 'piece1-sha256:' + 'a'.repeat(64);
        const allocated = { ...community, outputs: [{ hash, areaM2: 10, fromParcelIds: [], role: 'plot' }], allocations: [{ output: hash, to: { kind: 'holders' } }] };
        expect(validateAgreementContent(allocated)).toMatchObject({ ok: false, section: 'allocation' });
    });

    it('pins exact canonical bytes, appends after the deadline without a chain account, and reads back unchanged', async () => {
        const { app, reportPinBytes } = appFor();
        const signed = await report();
        const response = await request(app).post(path()).send(signed);
        expect(response.status).toBe(201);
        expect(response.body).toEqual({ stored: true, duplicate: false, cid: signed.cid });
        expect(reportPinBytes).toHaveBeenCalledWith({ bytes: canonicalBytes(signed.content), cid: signed.cid, name: `community-report-${signed.cid}` });
        const read = await request(app).get(path());
        expect(read.status).toBe(200);
        expect(read.headers['cache-control']).toBe('no-store');
        expect(read.body).toEqual({ agreementCid: AGREEMENT, reports: [signed] });
        expect(cidOf(canonicalBytes(read.body.reports[0].content))).toBe(signed.cid);
    });

    it('keeps history and sorts by signed time, then CID independent of insertion order', async () => {
        const { app } = appFor();
        const signed = await Promise.all([
            report({ statement: 'First account.' }), report({ statement: 'Another account.' }),
            report({ postedAt: '2026-10-02T10:00:00.000Z', statement: 'Earlier report.' })
        ]);
        for (const row of signed) expect((await request(app).post(path()).send(row)).status).toBe(201);
        const expected = [...signed].sort((a, b) => a.content.postedAt < b.content.postedAt ? -1 : a.content.postedAt > b.content.postedAt ? 1 : a.cid < b.cid ? -1 : 1);
        expect((await request(app).get(path())).body.reports).toEqual(expected);
    });

    it('is idempotent for concurrent identical posts', async () => {
        const { app } = appFor();
        const signed = await report();
        const responses = await Promise.all([1, 2, 3].map(() => request(app).post(path()).send(signed)));
        expect(responses.map(row => row.status).sort()).toEqual([200, 200, 201]);
        expect((await request(app).get(path())).body.reports).toEqual([signed]);
    });

    it('rejects a forged signature, changed document or extra fields before any database read, pin or write', async () => {
        const signed = await report();
        for (const content of [
            { ...signed.content, statement: 'Forged claim.' },
            { ...signed.content, didDocument: { ...document, id: 'did:web:other.example' } },
            { ...signed.content, unsignedExtra: true }
        ]) {
            const { app, pool, reportPinBytes, reportStore } = appFor();
            const response = await request(app).post(path()).send({ cid: cidOfObject(content), content });
            expect([400, 403]).toContain(response.status);
            expect(pool.getCalls()).toHaveLength(0);
            expect(reportPinBytes).not.toHaveBeenCalled();
            expect(await reportStore.list(AGREEMENT)).toEqual([]);
        }
    });

    it('refuses owner agreements, an unnamed organiser, and another NGO even with a consistent signature', async () => {
        const signed = await report();
        for (const agreement of [
            { ...agreementContent, rule: { electorate: 'owners', binding: false } },
            { ...agreementContent, consultation: null },
            { ...agreementContent, consultation: { organiser: 'did:web:another.example' } }
        ]) {
            const { app, reportPinBytes } = appFor({ agreement });
            expect((await request(app).post(path()).send(signed)).status).toBe(403);
            expect(reportPinBytes).not.toHaveBeenCalled();
        }
    });

    it('refuses mismatched content CIDs and agreements, future timestamps and oversized snapshots', async () => {
        const signed = await report();
        const future = await report({ postedAt: new Date(NOW + 301000).toISOString() });
        const wrongAgreement = await report({ agreementCid: MISSING });
        const oversized = { ...signed.content, didDocument: { ...document, payload: 'x'.repeat(MAX_COMMUNITY_REPORT_BYTES) } };
        const { app, pool, reportPinBytes } = appFor();
        expect((await request(app).post(path()).send({ ...signed, cid: MISSING })).status).toBe(400);
        expect([400, 403]).toContain((await request(app).post(path()).send(wrongAgreement)).status);
        expect([400, 403]).toContain((await request(app).post(path()).send(future)).status);
        expect((await request(app).post(path()).send({ cid: cidOfObject(oversized), content: oversized })).status).toBe(413);
        expect(pool.getCalls()).toHaveLength(0);
        expect(reportPinBytes).not.toHaveBeenCalled();
    });

    it('returns 404 for missing indexed agreements and 400 for malformed paths or bodies', async () => {
        const { app } = appFor({ agreement: null });
        expect((await request(app).get(path())).status).toBe(404);
        expect((await request(app).post(path()).send(await report())).status).toBe(404);
        expect((await request(app).get('/agreements/invalid/community-reports')).status).toBe(400);
        expect((await request(app).post(path()).send({})).status).toBe(400);
    });

    it('never indexes a failed pin and distinguishes unavailable pinning', async () => {
        for (const [code, status] of [['pinning-unconfigured', 503], ['pin-failed', 502]]) {
            const reportPinBytes = vi.fn(async () => { throw Object.assign(new Error('Pin unavailable'), { code }); });
            const { app, reportStore } = appFor({ reportPinBytes });
            expect((await request(app).post(path()).send(await report())).status).toBe(status);
            expect(await reportStore.list(AGREEMENT)).toEqual([]);
        }
    });

    it('uses the upload limiter and performs no outbound website request', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Server must not fetch websites'); });
        const signed = await report();
        const normal = appFor();
        expect((await request(normal.app).post(path()).send(signed)).status).toBe(201);
        expect((await request(normal.app).get(path())).status).toBe(200);
        expect(fetch).not.toHaveBeenCalled();
        const limited = appFor({ uploadRateLimiter: (_req, res) => res.status(429).json({ error: 'Rate limited' }) });
        expect((await request(limited.app).post(path()).send(signed)).status).toBe(429);
        expect(limited.pool.getCalls()).toHaveLength(0);
        expect(limited.reportPinBytes).not.toHaveBeenCalled();
    });

    it('inserts append-only with CID conflict idempotence and lists deterministic source timestamps', async () => {
        const pool = createMockPool();
        const store = createCommunityReportStore(pool);
        const signed = await report();
        pool.setResult({ rows: [{ cid: signed.cid }] });
        expect(await store.append(AGREEMENT, signed.cid, signed.content)).toEqual({ duplicate: false });
        expect(await store.append(AGREEMENT, signed.cid, signed.content)).toEqual({ duplicate: true });
        pool.setResult({ rows: [signed] });
        expect(await store.list(AGREEMENT)).toEqual([signed]);
        const calls = pool.getCalls();
        expect(calls[0].sql).toMatch(/ON CONFLICT \(cid\) DO NOTHING RETURNING cid/);
        expect(calls[0].params).toEqual([AGREEMENT, signed.cid, signed.content.postedAt, JSON.stringify(signed.content)]);
        expect(calls[2].sql).toMatch(/ORDER BY posted_at, cid COLLATE "C"/);
        expect(calls.some(call => /UPDATE|DELETE/.test(call.sql))).toBe(false);
    });
});
