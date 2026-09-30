// frontend/js/lens-service-client.js against the real reference lens member (backend/lens/) served
// on an ephemeral port: the browser owner flow (challenge -> checked message -> signature ->
// ownership), the x402 stop with the advertised price, coverage collection and operator verdicts.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const require = createRequire(import.meta.url);
const client = require('../../frontend/js/lens-service-client.js');

const NOW = 1790000000;
const clock = { nowSeconds: () => NOW };
const AUTHORITY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const OTHER_MEMBER = new PublicKey(Uint8Array.from({ length: 32 }, () => 5)).toBase58();
const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const TOKEN = 'operator-secret';

function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        address: new PublicKey(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).toBase58(),
        // what a browser wallet's signMessage returns
        signMessage: async bytes => ({ signature: new Uint8Array(sign(null, Buffer.from(bytes), privateKey)) })
    };
}
const alice = wallet();
const mallory = wallet();

const servers = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function serve({ pricing } = {}) {
    const member = createLensMember({
        authority: AUTHORITY,
        issuer: createFakeIssuer({ authority: AUTHORITY, clock }),
        store: createMemoryStore(),
        identity: createDevnetRegistryIdentity({
            rows: [{ parcelUid: 'HR-335550-1/1', owner: alice.address, ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' }],
            clock,
            authority: AUTHORITY
        }),
        clock,
        dryRun: !pricing
    });
    const app = createLensMemberApp({ member, pricing: pricing ?? createLensPricing({ dryRun: true }), operatorToken: TOKEN });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}

const flow = (serviceUrl, who, extra = {}) => client.runOwnershipFlow({
    serviceUrl, parcelUid: 'HR-335550-1/1', owner: who.address, memberKey: AUTHORITY, sign: who.signMessage, nowMs: NOW * 1000, ...extra
});

describe('owner flow against the reference member', () => {
    it('signs the checked challenge and returns the issued attestation, then the stored one', async () => {
        const serviceUrl = await serve();
        const first = await flow(serviceUrl, alice);
        expect(first.step).toBe('done');
        expect(first.body).toMatchObject({ kind: 'ownership', parcelUid: 'HR-335550-1/1', owner: alice.address, authority: AUTHORITY, reused: false });
        expect(first.body.accountHash).toMatch(/^[0-9a-f]{64}$/);

        const second = await flow(serviceUrl, alice);
        expect(second).toMatchObject({ step: 'done', body: { address: first.body.address, reused: true } });

        const listed = await client.fetchAttestations({ serviceUrl, filter: { parcelUid: 'HR-335550-1/1', kind: 'ownership' } });
        expect(listed.attestations.map(att => att.address)).toEqual([first.body.address]);
    });

    it('stops at the challenge for a wallet the member does not know, with the member reason', async () => {
        const serviceUrl = await serve();
        const result = await flow(serviceUrl, mallory);
        expect(result).toMatchObject({ step: 'challenge', outcome: { kind: 'refused', status: 403, code: 'owner_not_recorded' } });
    });

    it('never signs a challenge that names another member', async () => {
        const serviceUrl = await serve();
        let signed = false;
        const result = await flow(serviceUrl, alice, { memberKey: OTHER_MEMBER, sign: async () => { signed = true; return new Uint8Array(64); } });
        expect(result).toMatchObject({ step: 'check', outcome: { code: 'wrong_member' } });
        expect(signed).toBe(false);
    });

    it('stops at an x402 402 and reports the price the member advertises', async () => {
        const pricing = {
            mode: 'x402', enabled: true, price: '$0.01', priceUsdc: '0.01', network: 'solana-devnet', payTo: OTHER_MEMBER,
            gate: (_req, res) => res.status(402).json({ error: 'Payment required. Pay the x402 challenge in the PAYMENT-REQUIRED header and retry.' })
        };
        const serviceUrl = await serve({ pricing });
        const result = await flow(serviceUrl, alice);
        expect(result).toMatchObject({ step: 'payment', outcome: { kind: 'payment_required', status: 402 }, price: '0.01 USDC (solana-devnet)' });
    });

    it('reports an unreachable service as a network error, not an exception', async () => {
        const result = await client.fetchStatus({ serviceUrl: 'http://127.0.0.1:9' });
        expect(result.outcome).toMatchObject({ kind: 'error', status: 0, code: 'network' });
    });
});

describe('coverage collection', () => {
    it('asks members with a service URL and records the others as unknown', async () => {
        const serviceUrl = await serve();
        await flow(serviceUrl, alice);
        const coverage = await client.collectParcelCoverage({
            members: [{ key: AUTHORITY, serviceUrl }, { key: OTHER_MEMBER, serviceUrl: null }],
            parcelIds: ['HR-335550-1/1', 'HR-335550-9/9'],
            nowSeconds: NOW
        });
        expect(coverage.available).toBe(true);
        expect(coverage.byParcel['HR-335550-1/1']).toEqual({ covered: [AUTHORITY], unknown: [OTHER_MEMBER] });
        expect(coverage.byParcel['HR-335550-9/9']).toEqual({ covered: [], unknown: [OTHER_MEMBER] });
    });
});

describe('directory and operator verdicts', () => {
    it('normalises GET /lenses/members from a fake backend', async () => {
        const fetchImpl = async url => {
            expect(url).toBe('http://backend.test/lenses/members');
            return { status: 200, json: async () => ({ members: [{ key: AUTHORITY, name: 'Notary 01', coverage: { ownership: 2 } }, { key: 'bad' }] }) };
        };
        const result = await client.fetchDirectory({ base: 'http://backend.test/', fetchImpl });
        expect(result.members).toEqual([{ key: AUTHORITY, kind: null, name: 'Notary 01', description: null, coverage: { ownership: 2, parcels: 0, executed: 0 }, serviceUrl: null }]);
    });

    it('posts a verdict only with the operator token', async () => {
        const serviceUrl = await serve();
        const body = { proposalAccount: PROPOSAL, verdict: 'expired', sourceObservedAt: NOW - 60 };
        const refused = await client.postVerdict({ serviceUrl, token: 'wrong', body });
        expect(refused.outcome).toMatchObject({ kind: 'refused', status: 401, code: 'operator_only' });
        const accepted = await client.postVerdict({ serviceUrl, token: TOKEN, body });
        expect(accepted.outcome.kind).toBe('ok');
        expect(accepted.body).toMatchObject({ kind: 'verdict', proposalAccount: PROPOSAL, reused: false });
    });
});
