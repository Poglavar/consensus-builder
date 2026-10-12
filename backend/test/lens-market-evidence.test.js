// MarketEvidence-v1: payload bytes against sas-lib, the payload budget against a real create_attestation
// transaction, validation, the schema PDA, and the reference lens member issuing it through the fake
// issuer, as a library and over HTTP with the operator token, once per (recipe, value, event time).

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import * as kit from '@solana/kit';
import * as sas from 'sas-lib';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
    LENS_SCHEMAS,
    MARKET_EVIDENCE_MAX_PAYLOAD_BYTES,
    buildSasAttestationAccount,
    decodeLensAttestation,
    decodeLensPayload,
    deriveLensSchemaPdas,
    describeLensSchemas,
    encodeLensPayload,
    marketEvidencePayloadBytes,
    sha256Hex,
    validateMarketEvidence
} from '../oracle/lens-schemas.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore, createPgStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';

const NOW = 1798848000; // 2027-01-02T00:00:00Z
const clock = { nowSeconds: () => NOW };
const AUTHORITY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const TOKEN = 'operator-secret';
const RECIPE_HASH = `sha256:${'ab'.repeat(32)}`;
const EVIDENCE = Object.freeze({
    recipeHash: RECIPE_HASH,
    subject: 'US-CA-SF|5000002',
    value: 'permit 202603026735 issued on or before 2026-12-31T23:59:59-08:00',
    eventTime: 1798704000, // 2026-12-31 00:00 Pacific, DBI's issued_date
    sourceObservedAt: 1798750000,
    sourceRef: 'https://data.sf.gov/resource/i98e-djp9.json?permit_number=202603026735'
});
// Produced by sas-lib 1.0.10 serializeAttestationData for EVIDENCE under the MarketEvidence layout.
const SAS_LIB_HEX = '470000007368613235363a616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261621000000055532d43412d53467c35303030303032410000007065726d69742032303236303330323637333520697373756564206f6e206f72206265666f726520323032362d31322d33315432333a35393a35392d30383a3030800b366b0000000030bf366b000000004600000068747470733a2f2f646174612e73662e676f762f7265736f757263652f693938652d646a70392e6a736f6e3f7065726d69745f6e756d6265723d323032363033303236373335';

// The schema as SAS stores it on chain (joined field names, layout bytes), for sas-lib's codec.
function onChainSchema(kind) {
    const fieldNames = Buffer.concat(LENS_SCHEMAS[kind].fields.map(({ name }) => {
        const bytes = Buffer.from(name, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32LE(bytes.length);
        return Buffer.concat([length, bytes]);
    }));
    return { fieldNames: [...fieldNames], layout: [...LENS_SCHEMAS[kind].sasLayout] };
}

const recipeOf = fields => ({ recipeHash: fields.recipeHash, subject: fields.subject });
const factOf = ({ value, eventTime, sourceObservedAt, sourceRef }) => ({ value, eventTime, sourceObservedAt, sourceRef });

function setup({ operatorToken = TOKEN } = {}) {
    const store = createMemoryStore();
    const issuer = createFakeIssuer({ authority: AUTHORITY, clock });
    const identity = createDevnetRegistryIdentity({ rows: [], clock, authority: AUTHORITY });
    const member = createLensMember({ authority: AUTHORITY, kind: 'permit', issuer, store, identity, clock, dryRun: true });
    const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), operatorToken });
    return { app, member, store, issuer };
}

describe('MarketEvidence-v1 schema', () => {
    it('has the layout of lmsr-market.md, in that order', () => {
        expect(LENS_SCHEMAS.evidence).toMatchObject({ kind: 'evidence', id: 'MarketEvidence-v1', name: 'MarketEvidence', version: 1 });
        expect(LENS_SCHEMAS.evidence.layout).toBe('string recipeHash, string subject, string value, int64 eventTime, int64 sourceObservedAt, string sourceRef');
        expect(LENS_SCHEMAS.evidence.sasLayout).toEqual([12, 12, 12, 8, 8, 12]);
        expect(describeLensSchemas().find(schema => schema.kind === 'evidence')).toMatchObject({ id: 'MarketEvidence-v1', layout: LENS_SCHEMAS.evidence.layout });
    });

    it('encodes to the sas-lib bytes and decodes back', () => {
        const bytes = encodeLensPayload('evidence', EVIDENCE);
        expect(bytes.toString('hex')).toBe(SAS_LIB_HEX);
        expect(decodeLensPayload('evidence', bytes)).toEqual(EVIDENCE);
        const schema = onChainSchema('evidence');
        const values = { ...EVIDENCE, eventTime: BigInt(EVIDENCE.eventTime), sourceObservedAt: BigInt(EVIDENCE.sourceObservedAt) };
        expect(Buffer.from(sas.serializeAttestationData(schema, values)).equals(bytes)).toBe(true);
        expect(sas.deserializeAttestationData(schema, Uint8Array.from(bytes))).toEqual(values);
        expect(marketEvidencePayloadBytes(EVIDENCE)).toBe(bytes.length);
    });

    it('rejects truncated and trailing bytes, and parses from a SAS account', () => {
        const bytes = encodeLensPayload('evidence', EVIDENCE);
        expect(() => decodeLensPayload('evidence', bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
        expect(() => decodeLensPayload('evidence', Buffer.concat([bytes, Buffer.from([0])]))).toThrow(/trailing/);
        const key = () => Keypair.generate().publicKey.toBase58();
        const account = buildSasAttestationAccount({ nonce: key(), credential: key(), schema: key(), payload: bytes, authority: AUTHORITY, expiry: NOW + 10 });
        const decoded = decodeLensAttestation('evidence', account, { nowSeconds: NOW });
        expect(decoded).toMatchObject({ kind: 'evidence', authority: AUTHORITY, fields: EVIDENCE, accountHash: sha256Hex(account) });
    });

    it('derives the schema PDA sas-lib derives', async () => {
        const { credential, schemas } = deriveLensSchemaPdas({ authority: AUTHORITY, credentialName: 'LensMember' });
        expect(schemas.evidence).toBe('C9Cyyr5HcjUdbBBjsY84Tm1gvPsCrsprc2SPk2EoVjTD');
        const [libSchema] = await sas.deriveSchemaPda({ credential: kit.address(credential), name: 'MarketEvidence', version: 1 });
        expect(libSchema).toBe(schemas.evidence);
    });
});

describe('validateMarketEvidence', () => {
    it('accepts a well-formed fact', () => {
        expect(validateMarketEvidence({ ...EVIDENCE }, { nowSeconds: NOW })).toEqual(EVIDENCE);
    });

    it.each([
        [{ recipeHash: 'ab'.repeat(32) }, /recipeHash/],
        [{ recipeHash: `sha256:${'AB'.repeat(32)}` }, /recipeHash/],
        [{ recipeHash: 'sha256:abc' }, /recipeHash/],
        [{ subject: '' }, /subject is required/],
        [{ subject: ' US-CA-SF|5000002' }, /subject must not start or end with whitespace/],
        [{ value: '   ' }, /value is required/],
        [{ value: `${EVIDENCE.value}\n` }, /value must not start or end/],
        [{ sourceRef: undefined }, /sourceRef is required/],
        [{ eventTime: 0 }, /eventTime must be a positive/],
        [{ eventTime: 1798704000.5 }, /eventTime must be a positive/],
        [{ eventTime: '1798704000' }, /eventTime must be a positive/],
        [{ sourceObservedAt: EVIDENCE.eventTime - 1 }, /eventTime is after sourceObservedAt/],
        [{ sourceObservedAt: NOW + 1 }, /sourceObservedAt is in the future/]
    ])('rejects %j', (change, message) => {
        expect(() => validateMarketEvidence({ ...EVIDENCE, ...change }, { nowSeconds: NOW })).toThrow(message);
    });

    it('bounds the payload by UTF-8 bytes to what one transaction carries', () => {
        // 883 bytes in all: 103 fixed, value 65, sourceRef 70, so the subject may have 645 bytes ('ž' is 2).
        const fits = { ...EVIDENCE, subject: `${'ž'.repeat(322)}x` };
        expect(marketEvidencePayloadBytes(fits)).toBe(MARKET_EVIDENCE_MAX_PAYLOAD_BYTES);
        expect(() => validateMarketEvidence(fits)).not.toThrow();
        expect(() => validateMarketEvidence({ ...EVIDENCE, subject: 'ž'.repeat(323) }))
            .toThrow(/payload is 884 bytes \(subject 646, value 65, sourceRef 70\); one create_attestation transaction carries at most 883/);
    });
});

describe('the payload budget is a real transaction limit', () => {
    // The live issuer's transaction (lens/issuers.js): one signer paying and signing, one SAS
    // create_attestation instruction, serialized by web3.js, which refuses more than 1232 bytes.
    async function createAttestationTransaction() {
        const payer = Keypair.generate();
        const signer = await kit.createKeyPairSignerFromBytes(payer.secretKey);
        const key = () => kit.address(Keypair.generate().publicKey.toBase58());
        const [credential, schema, attestation, nonce] = [key(), key(), key(), key()];
        return payloadBytes => {
            const instruction = sas.getCreateAttestationInstruction({
                payer: signer, authority: signer, credential, schema, attestation, nonce, data: new Uint8Array(payloadBytes), expiry: 1900000000n
            });
            const transaction = new Transaction().add(new TransactionInstruction({
                programId: new PublicKey(instruction.programAddress),
                keys: instruction.accounts.map(account => ({ pubkey: new PublicKey(account.address), isSigner: account.role >= 2, isWritable: (account.role & 1) === 1 })),
                data: Buffer.from(instruction.data)
            }));
            transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
            transaction.feePayer = payer.publicKey;
            transaction.sign(payer);
            return transaction.serialize().length;
        };
    }

    it('fits a payload of the maximum size and refuses one byte more', async () => {
        const size = await createAttestationTransaction();
        expect(size(MARKET_EVIDENCE_MAX_PAYLOAD_BYTES)).toBe(1232);
        expect(() => size(MARKET_EVIDENCE_MAX_PAYLOAD_BYTES + 1)).toThrow(/too large/i);
    });
});

describe('lens member issueMarketEvidence', () => {
    it('issues through the issuer, with bytes that parse back to the fact', async () => {
        const { member, issuer } = setup();
        const record = await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: factOf(EVIDENCE) });
        expect(record).toMatchObject({
            kind: 'evidence', authority: AUTHORITY, credential: member.credential, schema: member.schemas.evidence,
            parcelUid: null, proposalAccount: null, owner: null, payload: EVIDENCE, reused: false,
            issuedAt: new Date(NOW * 1000).toISOString()
        });
        const bytes = issuer.accounts.get(record.address);
        expect(record.accountHash).toBe(sha256Hex(bytes));
        expect(decodeLensAttestation('evidence', bytes, { nowSeconds: NOW }).fields).toEqual(EVIDENCE);
    });

    it('returns the stored attestation on a retry, even one observed later', async () => {
        const { member, issuer } = setup();
        const first = await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: factOf(EVIDENCE) });
        const retry = await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: { ...factOf(EVIDENCE), sourceObservedAt: NOW - 10 } });
        expect(retry).toMatchObject({ address: first.address, reused: true, payload: { sourceObservedAt: EVIDENCE.sourceObservedAt } });
        expect(issuer.accounts.size).toBe(1);
        // A different event time or value is a different fact with its own address.
        const later = await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: { ...factOf(EVIDENCE), eventTime: EVIDENCE.eventTime + 86400, sourceObservedAt: NOW } });
        const no = await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: { ...factOf(EVIDENCE), value: 'no matching record on or before 2026-12-31T23:59:59-08:00' } });
        expect(new Set([first.address, later.address, no.address]).size).toBe(3);
        expect(issuer.accounts.size).toBe(3);
    });

    it('refuses the same key for another subject, and invalid facts, before issuing', async () => {
        const { member, issuer } = setup();
        await member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: factOf(EVIDENCE) });
        await expect(member.issueMarketEvidence({ recipe: { ...recipeOf(EVIDENCE), subject: 'US-CA-SF|5000003' }, fact: factOf(EVIDENCE) }))
            .rejects.toMatchObject({ status: 409, code: 'evidence_conflict' });
        await expect(member.issueMarketEvidence({ recipe: recipeOf(EVIDENCE), fact: { ...factOf(EVIDENCE), eventTime: EVIDENCE.sourceObservedAt + 1 } }))
            .rejects.toMatchObject({ status: 422, code: 'invalid_market_evidence' });
        await expect(member.issueMarketEvidence({ recipe: { recipeHash: 'nope', subject: EVIDENCE.subject }, fact: factOf(EVIDENCE) }))
            .rejects.toMatchObject({ status: 422, code: 'invalid_market_evidence' });
        expect(issuer.accounts.size).toBe(1);
    });
});

describe('POST /lens/market-evidence', () => {
    it('is operator-only, like verdicts', async () => {
        const { app, issuer } = setup();
        const anonymous = await request(app).post('/lens/market-evidence').send(EVIDENCE);
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.error).toBe('operator_only');
        const wrong = await request(app).post('/lens/market-evidence').set(OPERATOR_TOKEN_HEADER, 'guess').send(EVIDENCE);
        expect(wrong.status).toBe(401);
        const off = await request(setup({ operatorToken: null }).app).post('/lens/market-evidence').set(OPERATOR_TOKEN_HEADER, TOKEN).send(EVIDENCE);
        expect(off.status).toBe(503);
        expect(issuer.accounts.size).toBe(0);
    });

    it('issues once, answers a retry with the stored record, and lists it by kind and recipe', async () => {
        const { app } = setup();
        const post = body => request(app).post('/lens/market-evidence').set(OPERATOR_TOKEN_HEADER, TOKEN).send(body);
        const created = await post(EVIDENCE);
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ kind: 'evidence', payload: EVIDENCE, reused: false });
        const again = await post({ ...EVIDENCE, sourceObservedAt: NOW });
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ address: created.body.address, reused: true });

        const listed = await request(app).get('/lens/attestations').query({ kind: 'evidence', recipeHash: RECIPE_HASH });
        expect(listed.body.attestations.map(a => a.address)).toEqual([created.body.address]);
        const otherRecipe = await request(app).get('/lens/attestations').query({ recipeHash: `sha256:${'cd'.repeat(32)}` });
        expect(otherRecipe.body.attestations).toEqual([]);
        expect((await request(app).get('/lens/attestations').query({ kind: 'verdict' })).body.attestations).toEqual([]);
        expect((await request(app).get('/lens/attestations').query({ kind: 'court' })).status).toBe(400);
        const status = await request(app).get('/lens/status');
        expect(status.body).toMatchObject({ kind: 'permit', counts: { evidence: 1, ownership: 0, verdict: 0 } });
        expect(status.body.schemas.evidence).toBe('C9Cyyr5HcjUdbBBjsY84Tm1gvPsCrsprc2SPk2EoVjTD');
    });

    it('takes times as integers only and hashed texts byte for byte', async () => {
        const { app, issuer } = setup();
        const post = body => request(app).post('/lens/market-evidence').set(OPERATOR_TOKEN_HEADER, TOKEN).send(body);
        const iso = await post({ ...EVIDENCE, eventTime: '2026-12-31' });
        expect(iso.status).toBe(400);
        expect(iso.body.message).toMatch(/eventTime must be Unix seconds/);
        const padded = await post({ ...EVIDENCE, value: `${EVIDENCE.value} ` });
        expect(padded.status).toBe(422);
        expect(padded.body.error).toBe('invalid_market_evidence');
        const missing = await post({ ...EVIDENCE, subject: undefined });
        expect(missing.status).toBe(400);
        const conflict = await post(EVIDENCE).then(() => post({ ...EVIDENCE, subject: 'US-CA-SF|5000003' }));
        expect(conflict.status).toBe(409);
        expect(issuer.accounts.size).toBe(1);
    });
});

describe('postgres store', () => {
    it('filters by recipe hash in the payload and counts evidence', async () => {
        const queries = [];
        const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ ownership: 0, verdict: 0, evidence: 2, parcels: 0, proposals: 0 }], rowCount: 0 }; } };
        const store = createPgStore(pool);
        await store.list({ kind: 'evidence', recipeHash: RECIPE_HASH });
        expect(queries[0].sql).toContain("payload->>'recipeHash' = $5");
        expect(queries[0].params).toEqual([null, null, null, 'evidence', RECIPE_HASH, 200]);
        expect(await store.counts()).toMatchObject({ evidence: 2 });
        expect(queries[1].sql).toContain("count(*) FILTER (WHERE kind = 'evidence')::int AS evidence");
    });
});
