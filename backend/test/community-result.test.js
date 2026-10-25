// Focused headless checks for signed community reports and their read-back client.
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const consultation = require('../../frontend/js/community/consultation.js');
const result = require('../../frontend/js/community/result.js');
const didWeb = require('../../frontend/js/community/did-web.js');
const cid = require('../../frontend/js/cid.js');
const lens = require('../../frontend/js/lens-core.js');

const ORGANISER = 'did:web:ngo.example:consultation';
const CLUSTER = 'devnet';
const NOW = Date.parse('2026-10-25T12:00:00.000Z');

function fixture() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const address = lens.base58Encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const wallet = {
        address,
        signMessage: vi.fn(async message => lens.base58Encode(sign(null, Buffer.from(message), privateKey)))
    };
    const didDocument = consultation.setupDocument(ORGANISER, wallet, CLUSTER);
    const resolved = { did: ORGANISER, document: didDocument };
    const agreementCid = cid.cidOfObject({ type: 'community-test-agreement', nonce: 1 });
    return { address, wallet, didDocument, resolved, agreementCid };
}

async function signed(fx, overrides = {}) {
    return result.signReport({
        agreementCid: fx.agreementCid,
        organiser: ORGANISER,
        statement: 'Community consultation supports the proposal.',
        url: 'https://ngo.example/results',
        resolved: fx.resolved,
        wallet: fx.wallet,
        cluster: CLUSTER,
        now: NOW,
        ...overrides
    });
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

describe('community result signatures', () => {
    it('signs and re-verifies against the exact agreement CID, organiser DID and document snapshot', async () => {
        const fx = fixture();
        const report = await signed(fx);
        expect(report.proof.scheme).toBe('ed25519-wallet/v1');
        expect(report.didDocumentSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(await result.verifyReport(report, { agreementCid: fx.agreementCid, organiser: ORGANISER, now: NOW })).toEqual({ ok: true });
        expect((await result.verifyReport(report, { agreementCid: cid.cidOfObject({ other: true }), organiser: ORGANISER, now: NOW })).code).toBe('wrong-consultation');
        expect((await result.verifyReport(report, { agreementCid: fx.agreementCid, organiser: 'did:web:elsewhere.example', now: NOW })).code).toBe('wrong-consultation');
    });

    it('rejects changes to signed statement, time, URL, signer, or DID snapshot', async () => {
        const fx = fixture();
        const report = await signed(fx);
        for (const [field, value] of [
            ['statement', 'A changed statement.'],
            ['postedAt', new Date(NOW + 1000).toISOString()],
            ['url', 'https://ngo.example/changed'],
            ['signer', report.signer.replace(fx.address, '11111111111111111111111111111111')],
            ['didDocument', { ...report.didDocument, id: 'did:web:tampered.example' }]
        ]) {
            const changed = clone(report);
            changed[field] = value;
            expect((await result.verifyReport(changed, { agreementCid: fx.agreementCid, organiser: ORGANISER, now: NOW })).ok).toBe(false);
        }
        const badHash = clone(report);
        badHash.didDocumentSha256 = 'sha256:' + '0'.repeat(64);
        expect((await result.verifyReport(badHash, { agreementCid: fx.agreementCid, organiser: ORGANISER, now: NOW })).code).toBe('document-hash-mismatch');
    });

    it('enforces statement length, future timestamps, supported networks and wallet listing before signing', async () => {
        const fx = fixture();
        await expect(signed(fx, { statement: 'x'.repeat(result.MAX_STATEMENT + 1) })).rejects.toMatchObject({ code: 'invalid-community-report' });
        await expect(signed(fx, { cluster: 'localnet' })).rejects.toMatchObject({ code: 'wallet-required' });
        const future = await signed(fx, { now: NOW + 60 * 60 * 1000 });
        expect((await result.verifyReport(future, { agreementCid: fx.agreementCid, organiser: ORGANISER, now: NOW })).code).toBe('future-report');
        const unlisted = { ...fx.resolved, document: { ...fx.didDocument, assertionMethod: [] } };
        const signMessage = vi.fn();
        await expect(signed(fx, { resolved: unlisted, wallet: { address: fx.address, signMessage } })).rejects.toMatchObject({ code: 'wallet-not-listed' });
        expect(signMessage).not.toHaveBeenCalled();
    });

    it('accepts an old valid report without applying a deadline', async () => {
        const fx = fixture();
        const old = await signed(fx, { now: Date.parse('2020-01-01T00:00:00.000Z') });
        expect(await result.verifyReport(old, { agreementCid: fx.agreementCid, organiser: ORGANISER, now: NOW })).toEqual({ ok: true });
    });
});

describe('community result history', () => {
    it('escapes statements and shows a neutral attribution when the website cannot authorize a wallet', async () => {
        const fx = fixture();
        const content = await signed(fx, { statement: '<script>alert("claim")</script>' });
        const row = { cid: cid.cidOfObject(content), content, websiteStatus: 'unlisted' };
        const html = consultation.reportHtml(row);
        expect(html).toContain('&lt;script&gt;alert(&quot;claim&quot;)&lt;/script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('cb-badge--success');
        expect(html).toContain('website attribution unverified');
        expect(consultation.picturesHtml({ screenshotUrl: 'https://ngo.example/after.png' })).toBe('');
        expect(consultation.picturesHtml({ screenshotPairUrl: 'javascript:alert(1)' })).toBe('');
        expect(consultation.picturesHtml({ screenshotPairUrl: 'https://ngo.example/pair.png' })).toContain('Before / after');
    });
    it('marks current website authorization, retains unavailable and unlisted status, and sorts newest first deterministically', async () => {
        const fx = fixture();
        const newest = await signed(fx, { statement: 'Newest.', now: NOW });
        const tied = await signed(fx, { statement: 'Tied timestamp.', now: NOW });
        const old = await signed(fx, { statement: 'Earlier.', now: NOW - 1000 });
        const row = content => ({ cid: cid.cidOfObject(content), content });
        const rows = [row(old), row(tied), row(newest)];
        const listed = await result.inspectReports(rows, { agreementCid: fx.agreementCid, organiser: ORGANISER, resolved: fx.resolved, now: NOW });
        expect(listed.map(item => item.cid)).toEqual(rows.map(item => item.cid).sort((a, b) => {
            const left = rows.find(item => item.cid === a).content.postedAt;
            const right = rows.find(item => item.cid === b).content.postedAt;
            return right.localeCompare(left) || b.localeCompare(a);
        }));
        expect(listed.every(item => item.websiteStatus === 'listed')).toBe(true);
        const unlistedDocument = { ...fx.didDocument, assertionMethod: [] };
        const unlisted = await result.inspectReports(rows, { agreementCid: fx.agreementCid, organiser: ORGANISER, resolved: { did: ORGANISER, document: unlistedDocument }, now: NOW });
        expect(unlisted.every(item => item.websiteStatus === 'unlisted')).toBe(true);
        const unavailable = await result.inspectReports(rows, { agreementCid: fx.agreementCid, organiser: ORGANISER, resolved: null, now: NOW });
        expect(unavailable.every(item => item.websiteStatus === 'unavailable')).toBe(true);
    });

    it('refuses a report row whose content does not match its CID', async () => {
        const fx = fixture();
        const report = await signed(fx);
        const tampered = clone(report);
        tampered.statement = 'Altered under the old CID.';
        await expect(result.inspectReports([{ cid: cid.cidOfObject(report), content: tampered }], {
            agreementCid: fx.agreementCid, organiser: ORGANISER, resolved: fx.resolved, now: NOW
        })).rejects.toMatchObject({ code: 'invalid-community-report' });
    });
});

describe('community report client', () => {
    function fakeWindow(handler) {
        return {
            resolveBackendBaseUrl: () => 'https://api.example.test',
            fetch: vi.fn(handler)
        };
    }

    it('requires matching publish confirmation and a correct GET read-back before succeeding', async () => {
        const fx = fixture();
        const report = await signed(fx);
        const reportCid = cid.cidOfObject(report);
        const missing = fakeWindow(async (_url, init) => init.method === 'POST'
            ? { ok: true, json: async () => ({ cid: reportCid, stored: true }) }
            : { ok: true, json: async () => ({ agreementCid: fx.agreementCid, reports: [] }) });
        await expect(consultation.createClient(missing).publish(report)).rejects.toMatchObject({ code: 'report-not-observed' });
        expect(missing.fetch).toHaveBeenCalledTimes(2);

        const changedContent = clone(report);
        changedContent.statement = 'Altered after publication.';
        const wrongReadBack = fakeWindow(async (_url, init) => init.method === 'POST'
            ? { ok: true, json: async () => ({ cid: reportCid, stored: true }) }
            : { ok: true, json: async () => ({ agreementCid: fx.agreementCid, reports: [{ cid: reportCid, content: changedContent }] }) });
        await expect(consultation.createClient(wrongReadBack).publish(report)).rejects.toMatchObject({ code: 'report-not-observed' });

        const mismatched = fakeWindow(async (_url, init) => init.method === 'POST'
            ? { ok: true, json: async () => ({ cid: 'wrong', stored: true }) }
            : { ok: true, json: async () => ({ agreementCid: fx.agreementCid, reports: [] }) });
        await expect(consultation.createClient(mismatched).publish(report)).rejects.toMatchObject({ code: 'report-not-stored' });
        expect(mismatched.fetch).toHaveBeenCalledTimes(1);

        const correct = fakeWindow(async (_url, init) => init.method === 'POST'
            ? { ok: true, json: async () => ({ cid: reportCid, stored: true }) }
            : { ok: true, json: async () => ({ agreementCid: fx.agreementCid, reports: [{ cid: reportCid, content: report }] }) });
        await expect(consultation.createClient(correct).publish(report)).resolves.toMatchObject({ cid: reportCid });
        expect(correct.fetch).toHaveBeenCalledTimes(2);
        expect(correct.fetch.mock.calls[0][0]).toContain(encodeURIComponent(fx.agreementCid));
    });
});
