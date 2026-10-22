// Reference lens member (backend/lens/): the owner-consent flow end to end over HTTP with a fake SAS
// issuer, an in-memory store and real ed25519 wallet signatures, plus the refusals that must happen
// before anything is issued or paid for.

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PublicKey } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { decodeLensAttestation, sha256Hex } from '../oracle/lens-schemas.js';
import { cidOfObject } from '../cid.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createCertiliaIdentity } from '../lens/identity/certilia.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore, createPgStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const NOW = 1790000000; // 2026-09-21
const clock = { nowSeconds: () => NOW };
const AUTHORITY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const SPONSOR = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const AGREEMENT_CID = cidOfObject({ schema: 'agreement/v1', title: 'lens member service' });
const TOKEN = 'operator-secret';
// An AgreementDecision-v1 as the member issues it once the agreement's rule is met (lens-agreement-decision.test.js).
const DECISION = { agreementCid: AGREEMENT_CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'cd'.repeat(32)}`, sourceObservedAt: NOW - 60 };

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
            schemas: { ownership: member.schemas.ownership, decision: member.schemas.decision, evidence: member.schemas.evidence },
            identity: 'devnet-registry',
            dryRun: true,
            counts: { ownership: 0, decision: 0, evidence: 0, parcels: 0, agreements: 0 },
            pricing: { ownership: { mode: 'dry-run', enabled: false } },
            // No approval registry and no agreement index in this setup: those routes answer 503.
            approval: null,
            decisions: { operatorToken: true, agreementIndex: false }
        });
        expect(Object.keys(res.body.schemas)).toEqual(['ownership', 'decision', 'evidence']);
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

    it('lists issued attestations by parcel, kind and agreement', async () => {
        const { app, member } = setup();
        await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-1/1'));
        await request(app).post('/lens/ownership').send(await challengeAndSign(app, alice, 'HR-335550-2/1'));
        await member.attestDecision(DECISION);

        const one = await request(app).get('/lens/attestations').query({ parcelUid: 'HR-335550-2/1' });
        expect(one.status).toBe(200);
        expect(one.body.attestations).toHaveLength(1);
        expect(one.body.attestations[0]).toMatchObject({ parcelUid: 'HR-335550-2/1', owner: alice.address });
        const decisions = await request(app).get('/lens/attestations').query({ kind: 'decision' });
        expect(decisions.body.attestations.map(a => a.payload)).toEqual([DECISION]);
        const byAgreement = await request(app).get('/lens/attestations').query({ agreementCid: AGREEMENT_CID });
        expect(byAgreement.body.attestations.map(a => a.kind)).toEqual(['decision']);
        const otherAgreement = await request(app).get('/lens/attestations').query({ agreementCid: cidOfObject({ schema: 'agreement/v1', title: 'another' }) });
        expect(otherAgreement.body.attestations).toEqual([]);
        const all = await request(app).get('/lens/attestations');
        expect(all.body.attestations).toHaveLength(3);
        const unknownKind = await request(app).get('/lens/attestations').query({ kind: 'verdict' });
        expect([unknownKind.status, unknownKind.body.error]).toEqual([400, 'bad_request']);
        const status = await request(app).get('/lens/status');
        expect(status.body.counts).toMatchObject({ ownership: 2, decision: 1, evidence: 0, parcels: 2, agreements: 1 });
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
            address: SPONSOR, kind: 'decision', credential: AUTHORITY, schema: AUTHORITY, authority: AUTHORITY,
            parcelUid: null, owner: null, payload: DECISION,
            accountHash: 'ab', expiry: NOW + 10, transactionSignature: 'sig', payment: null, issuedAt: '2026-09-21T00:00:00.000Z'
        });
        expect(queries[0].sql).toContain('INSERT INTO consensus.lens_attestation');
        expect(queries[0].sql).not.toMatch(/now\(\)/i);
        // A decision names its agreement in the payload; the table has no per-proposal column.
        expect(queries[0].sql).not.toMatch(/proposal_account/);
        expect(queries[0].params).toHaveLength(13);
        expect(JSON.parse(queries[0].params[7])).toEqual(DECISION);
        expect(queries[0].params.at(-1)).toBe('2026-09-21T00:00:00.000Z');

        await store.list({ agreementCid: AGREEMENT_CID, kind: 'decision' });
        expect(queries[1].sql).toMatch(/payload->>'agreementCid' = \$2/);
        expect(queries[1].params).toEqual([null, AGREEMENT_CID, null, 'decision', null, 200]);

        const identity = createDevnetRegistryIdentity({ pool, clock, authority: AUTHORITY });
        await identity.ownerSet('HR-335550-1/1');
        expect(queries[2].sql).toContain('FROM consensus.lens_devnet_owner');
        expect(queries[2].params).toEqual(['HR-335550-1/1']);
        // The approval registry's batch read (approval.js devnetOwnerRegistry): one statement for every parcel.
        const sets = await identity.ownerSets(['HR-335550-2/1', 'HR-335550-1/1', 'HR-335550-2/1']);
        expect(queries[3].sql).toMatch(/WHERE parcel_uid = ANY\(\$1::text\[\]\)/);
        expect(queries[3].params).toEqual([['HR-335550-2/1', 'HR-335550-1/1']]);
        expect([...sets.entries()]).toEqual([['HR-335550-2/1', []], ['HR-335550-1/1', []]]);
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
