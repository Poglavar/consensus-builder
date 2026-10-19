// Reference lens member (backend/lens/): the owner-consent flow end to end over HTTP with a fake SAS
// issuer, an in-memory store and real ed25519 wallet signatures, plus the refusals that must happen
// before anything is issued or paid for.

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PublicKey } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { decodeLensAttestation, sha256Hex } from '../oracle/lens-schemas.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createCertiliaIdentity } from '../lens/identity/certilia.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore, createPgStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';

const NOW = 1790000000; // 2026-09-21
const clock = { nowSeconds: () => NOW };
const AUTHORITY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const TOKEN = 'operator-secret';

function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    return {
        address: new PublicKey(raw).toBase58(),
        sign: message => getBase58Decoder().decode(sign(null, Buffer.from(message, 'utf8'), privateKey))
    };
}

const alice = wallet();
const bob = wallet();
const carol = wallet();

function registryRows() {
    return [
        { parcelUid: 'HR-335550-1/1', owner: alice.address, ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' },
        // co-owned: both rows count 2; the owner set exists since the later of the two times
        { parcelUid: 'HR-335550-2/1', owner: alice.address, ownerCount: 2, establishedAt: '2026-05-01T00:00:00Z' },
        { parcelUid: 'HR-335550-2/1', owner: bob.address, ownerCount: 2, establishedAt: '2026-07-01T00:00:00Z' },
        { parcelUid: 'HR-335550-3/1', owner: carol.address, ownerCount: 1, establishedAt: null }
    ];
}

function setup({ dryRun = true, pricing, operatorToken = TOKEN } = {}) {
    const store = createMemoryStore();
    const issuer = createFakeIssuer({ authority: AUTHORITY, clock });
    const identity = createDevnetRegistryIdentity({ rows: registryRows(), clock, authority: AUTHORITY });
    const member = createLensMember({ authority: AUTHORITY, issuer, store, identity, clock, dryRun });
    const app = createLensMemberApp({ member, pricing: pricing ?? createLensPricing({ dryRun }), operatorToken });
    return { app, member, store, issuer };
}

async function challengeAndSign(app, who, parcelUid) {
    const res = await request(app).post('/lens/challenge').send({ parcelUid, owner: who.address });
    expect(res.status).toBe(201);
    return { parcelUid, owner: who.address, challenge: res.body.challenge, signature: who.sign(res.body.message) };
}

describe('reference lens member', () => {
    it('reports the kind it was created with and refuses an unknown one', async () => {
        const issuer = createFakeIssuer({ authority: AUTHORITY, clock });
        const identity = createDevnetRegistryIdentity({ rows: registryRows(), clock, authority: AUTHORITY });
        const member = createLensMember({ authority: AUTHORITY, kind: 'lifecycle', issuer, store: createMemoryStore(), identity, clock, dryRun: true });
        expect((await member.status()).kind).toBe('lifecycle');
        expect(() => createLensMember({ authority: AUTHORITY, kind: 'oracle', issuer, store: createMemoryStore(), identity, clock }))
            .toThrow(/unknown kind "oracle"/);
    });

    it('reports key, kind, credential, schemas, counts and that dry-run pricing is off', async () => {
        const { app, member } = setup();
        const res = await request(app).get('/lens/status');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            key: AUTHORITY,
            kind: 'owner-consent',
            credential: member.credential,
            schemas: { ownership: member.schemas.ownership, verdict: member.schemas.verdict },
            identity: 'devnet-registry',
            dryRun: true,
            counts: { ownership: 0, verdict: 0, parcels: 0 },
            pricing: { ownership: { mode: 'dry-run', enabled: false } }
        });
        expect(res.body.pricing.ownership.reason).toMatch(/dry run/);
        // Same PDA the register script prints for this authority and the default credential name.
        expect(member.credential).toBe('8xXFCwX7ktNopNTi2LxNrNwAUhnpCjzU76V8KetnFAMJ');
    });

    it('issues ParcelOwnership-v1 after a signed challenge, with bytes that parse back', async () => {
        const { app, issuer } = setup();
        const body = await challengeAndSign(app, alice, 'HR-335550-1/1');
        const res = await request(app).post('/lens/ownership').send(body);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            kind: 'ownership',
            parcelUid: 'HR-335550-1/1',
            owner: alice.address,
            authority: AUTHORITY,
            payload: { parcelUid: 'HR-335550-1/1', owner: alice.address, ownerCount: 1, sourceObservedAt: Date.parse('2026-06-01T00:00:00Z') / 1000 },
            issuedAt: new Date(NOW * 1000).toISOString(),
            reused: false,
            pricing: { mode: 'dry-run', enabled: false }
        });
        expect(res.body.payload.evidenceRef).toMatch(/^sha256:[0-9a-f]{64}$/);
        const bytes = issuer.accounts.get(res.body.address);
        expect(res.body.accountHash).toBe(sha256Hex(bytes));
        const parsed = decodeLensAttestation('ownership', bytes, { nowSeconds: NOW });
        expect(parsed.authority).toBe(AUTHORITY);
        expect(parsed.fields).toEqual(res.body.payload);

        // The challenge is spent; asking again with it is refused.
        const replay = await request(app).post('/lens/ownership').send(body);
        expect(replay.status).toBe(401);
        expect(replay.body.error).toBe('challenge_unknown');
        // A fresh challenge for the same fact returns the stored attestation, not a twin.
        const again = await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-1/1'));
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ address: res.body.address, reused: true });
        expect(issuer.accounts.size).toBe(1);
    });

    it('rejects a signature from another wallet and issues nothing', async () => {
        const { app, issuer } = setup();
        const body = await challengeAndSign(app, alice, 'HR-335550-1/1');
        const challenge = await request(app).post('/lens/challenge').send({ parcelUid: 'HR-335550-1/1', owner: alice.address });
        const res = await request(app).post('/lens/ownership').send({ ...body, challenge: challenge.body.challenge, signature: bob.sign(challenge.body.message) });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('bad_signature');
        // A valid signature over a different challenge text is refused too.
        const crossed = await request(app).post('/lens/ownership').send({ ...body, challenge: challenge.body.challenge });
        expect(crossed.body.error).toBe('bad_signature');
        expect(issuer.accounts.size).toBe(0);
    });

    it('refuses an unknown parcel and a wallet that is not a recorded owner', async () => {
        const { app } = setup();
        const unknown = await request(app).post('/lens/challenge').send({ parcelUid: 'HR-999999-9/9', owner: alice.address });
        expect(unknown.status).toBe(404);
        expect(unknown.body.error).toBe('unknown_parcel');
        const stranger = await request(app).post('/lens/challenge').send({ parcelUid: 'HR-335550-1/1', owner: bob.address });
        expect(stranger.status).toBe(403);
        expect(stranger.body.error).toBe('owner_not_recorded');
    });

    it('refuses to attest when the registry has no established_at (no invented time)', async () => {
        const { app, issuer } = setup();
        const body = await challengeAndSign(app, carol, 'HR-335550-3/1');
        const res = await request(app).post('/lens/ownership').send(body);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('source_time_missing');
        expect(issuer.accounts.size).toBe(0);
    });

    it('gives each owner of a co-owned parcel its own attestation, both with ownerCount 2', async () => {
        const { app } = setup();
        const a = await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-2/1'));
        const b = await request(app).post('/lens/ownership').send(await challengeAndSign(app, bob, 'HR-335550-2/1'));
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(a.body.address).not.toBe(b.body.address);
        const july = Date.parse('2026-07-01T00:00:00Z') / 1000;
        expect(a.body.payload).toMatchObject({ owner: alice.address, ownerCount: 2, sourceObservedAt: july });
        expect(b.body.payload).toMatchObject({ owner: bob.address, ownerCount: 2, sourceObservedAt: july });
        expect(a.body.payload.evidenceRef).toBe(b.body.payload.evidenceRef);
    });

    it('issues verdicts only with the operator token', async () => {
        const { app } = setup();
        const verdict = { proposalAccount: PROPOSAL, verdict: 'expired', evidenceRef: 'case-17', sourceObservedAt: '2026-09-20T00:00:00Z' };
        const anonymous = await request(app).post('/lens/verdict').send(verdict);
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.error).toBe('operator_only');
        const wrong = await request(app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, 'guess').send(verdict);
        expect(wrong.status).toBe(401);
        const ok = await request(app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, TOKEN).send(verdict);
        expect(ok.status).toBe(201);
        expect(ok.body).toMatchObject({
            kind: 'verdict',
            proposalAccount: PROPOSAL,
            payload: { proposalAccount: PROPOSAL, verdict: 'expired', evidenceRef: 'case-17', sourceObservedAt: Date.parse('2026-09-20T00:00:00Z') / 1000 }
        });
        const bad = await request(app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, TOKEN).send({ ...verdict, verdict: 'maybe' });
        expect(bad.status).toBe(422);
        const future = await request(app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, TOKEN).send({ ...verdict, sourceObservedAt: NOW + 3600 });
        expect(future.status).toBe(422);

        const unset = setup({ operatorToken: null });
        const off = await request(unset.app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, TOKEN).send(verdict);
        expect(off.status).toBe(503);
    });

    it('lists issued attestations by parcel and kind', async () => {
        const { app } = setup();
        await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-1/1'));
        await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-2/1'));
        await request(app).post('/lens/verdict').set(OPERATOR_TOKEN_HEADER, TOKEN)
            .send({ proposalAccount: PROPOSAL, verdict: 'executed', evidenceRef: '', sourceObservedAt: NOW - 60 });

        const one = await request(app).get('/lens/attestations').query({ parcelUid: 'HR-335550-2/1' });
        expect(one.status).toBe(200);
        expect(one.body.attestations).toHaveLength(1);
        expect(one.body.attestations[0]).toMatchObject({ parcelUid: 'HR-335550-2/1', owner: alice.address });
        const verdicts = await request(app).get('/lens/attestations').query({ kind: 'verdict' });
        expect(verdicts.body.attestations.map(a => a.proposalAccount)).toEqual([PROPOSAL]);
        const all = await request(app).get('/lens/attestations');
        expect(all.body.attestations).toHaveLength(3);
        const status = await request(app).get('/lens/status');
        expect(status.body.counts).toMatchObject({ ownership: 2, verdict: 1, parcels: 2, proposals: 1 });
    });

    it('refuses to issue for free when a live member has no x402 config', async () => {
        const { app, issuer } = setup({ dryRun: false, pricing: createLensPricing({ dryRun: false, env: {} }) });
        const res = await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-1/1'));
        expect(res.status).toBe(503);
        expect(res.body.missing).toEqual(['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO']);
        expect(issuer.accounts.size).toBe(0);
    });

    it('certilia adapter is a stub that says it is not configured', async () => {
        const identity = createCertiliaIdentity();
        expect(() => identity.assertReady()).toThrow('certilia identity adapter is not configured');
        await expect(identity.ownerSet('HR-1')).rejects.toThrow('not configured');
    });

    it('postgres store reads the owner set and writes issued_at from the issuer, not now()', async () => {
        const queries = [];
        const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
        const store = createPgStore(pool);
        await store.record({
            address: PROPOSAL, kind: 'verdict', credential: AUTHORITY, schema: AUTHORITY, authority: AUTHORITY,
            parcelUid: null, proposalAccount: PROPOSAL, owner: null, payload: { verdict: 'expired' },
            accountHash: 'ab', expiry: NOW + 10, transactionSignature: 'sig', payment: null, issuedAt: '2026-09-21T00:00:00.000Z'
        });
        expect(queries[0].sql).toContain('INSERT INTO consensus.lens_attestation');
        expect(queries[0].sql).not.toMatch(/now\(\)/i);
        expect(queries[0].params.at(-1)).toBe('2026-09-21T00:00:00.000Z');

        const identity = createDevnetRegistryIdentity({ pool, clock, authority: AUTHORITY });
        await identity.ownerSet('HR-335550-1/1');
        expect(queries[1].sql).toContain('FROM consensus.lens_devnet_owner');
        expect(queries[1].params).toEqual(['HR-335550-1/1']);
    });
});

describe('lens member CORS', () => {
    it('answers browser preflights and exposes response headers without credentials', async () => {
        const { app } = setup();
        const preflight = await request(app).options('/lens/challenge')
            .set('Origin', 'https://urbangametheory.xyz')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type,x-lens-operator-token');
        expect(preflight.status).toBeLessThan(300);
        expect(preflight.headers['access-control-allow-origin']).toBe('*');
        expect(preflight.headers['access-control-allow-headers']).toMatch(/x-lens-operator-token/i);
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
        const status = await request(app).get('/lens/status').set('Origin', 'https://example.test');
        expect(status.headers['access-control-allow-origin']).toBe('*');
        expect(status.headers['access-control-expose-headers']).toBe('*');
    });
});
