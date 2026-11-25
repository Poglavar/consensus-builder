// Unit tests for the member-issued AgreementDecision-v1 builders in frontend/js/solana/agreement-client.js:
// a lens key held in a person's wallet creates its SAS credential, decision schema and attestation in
// the browser. Each instruction must be byte-identical to sas-lib's (the reference member's issuer and
// register-lens-schemas.mjs use it), the PDAs and nonce identical to backend/lens/member.js and
// backend/oracle/lens-schemas.js, and the payload one the program's reader (readDecisionAttestation) takes back.
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as kit from '@solana/kit';
import * as sas from 'sas-lib';
import { LENS_SCHEMAS, encodeLensPayload, deriveLensSchemaPdas, buildSasAttestationAccount } from '../oracle/lens-schemas.js';
import { factNonce, deriveAttestationPda } from '../lens/member.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/agreement-client.js');

client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const C = client.constants;
const authority = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).publicKey.toBase58();
const payer = authority;
const sponsor = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)).publicKey.toBase58();
const fields = {
    agreementCid: 'bafkreigmrraldkjtmcgcxfkq6gdhx55uyi3k7sbxjjqs27tzyeuakl634m',
    sponsor,
    decision: 'satisfied',
    evidenceRef: 'sha256:' + 'a'.repeat(64),
    sourceObservedAt: 1_764_000_000
};
// A kit signer stand-in: sas-lib only reads `.address` to build account metas.
const signerOf = address => ({ address: kit.address(address), signTransactions: async () => [] });
const metas = ix => ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const kitMetas = ix => ix.accounts.map(a => [a.address, a.role >= 2, (a.role & 1) === 1]);

describe('member-issued AgreementDecision-v1', () => {
    it('restates the backend schema definition', () => {
        const schema = LENS_SCHEMAS.decision;
        expect(C.DECISION_SCHEMA_NAME).toBe(schema.name);
        expect(C.DECISION_SCHEMA_VERSION).toBe(schema.version);
        expect(C.DECISION_SCHEMA_DESCRIPTION).toBe(schema.description);
        expect([...C.DECISION_SCHEMA_FIELDS]).toEqual(schema.fields.map(f => f.name));
        expect([...C.DECISION_SCHEMA_LAYOUT]).toEqual([...schema.sasLayout]);
    });

    it('derives the credential, schema, nonce and attestation as the reference member does', () => {
        const { credential, schemas } = deriveLensSchemaPdas({ authority, credentialName: C.LENS_CREDENTIAL_NAME });
        expect(client.getLensCredentialPda(authority).toBase58()).toBe(credential);
        expect(client.getDecisionSchemaPda(credential)[0].toBase58()).toBe(schemas.decision);
        const nonce = factNonce([LENS_SCHEMAS.decision.id, fields.agreementCid, fields.sponsor, fields.decision, fields.sourceObservedAt]);
        expect(client.decisionNonce(fields).toBase58()).toBe(nonce);
        expect(client.getAttestationPda({ credential, schema: schemas.decision, nonce }).toBase58())
            .toBe(deriveAttestationPda({ credential, schema: schemas.decision, nonce }));
    });

    it('encodes the payload as the backend codec and the program reader do', () => {
        const payload = client.encodeDecisionPayload(fields);
        expect(Buffer.from(payload).equals(encodeLensPayload('decision', fields))).toBe(true);
        const { credential, schemas } = deriveLensSchemaPdas({ authority, credentialName: C.LENS_CREDENTIAL_NAME });
        const account = buildSasAttestationAccount({ nonce: client.decisionNonce(fields).toBase58(), credential, schema: schemas.decision, payload: Buffer.from(payload), authority, expiry: 2_000_000_000 });
        expect(client.readDecisionAttestation(new Uint8Array(account)).fields).toEqual(fields);
        expect(() => client.encodeDecisionPayload({ ...fields, decision: 'refused' })).toThrow(/satisfied/);
        expect(() => client.encodeDecisionPayload({ ...fields, sourceObservedAt: 1.5 })).toThrow(/Unix seconds/);
    });

    it('builds createCredential exactly as sas-lib', () => {
        const ours = client.buildCreateLensCredentialIx({ payer, authority });
        const credential = client.getLensCredentialPda(authority).toBase58();
        const theirs = sas.getCreateCredentialInstruction({ payer: signerOf(payer), credential: kit.address(credential), authority: signerOf(authority), name: C.LENS_CREDENTIAL_NAME, signers: [kit.address(authority)] });
        expect(ours.programId.toBase58()).toBe(theirs.programAddress);
        expect(Buffer.from(ours.data).equals(Buffer.from(theirs.data))).toBe(true);
        expect(metas(ours)).toEqual(kitMetas(theirs));
    });

    it('builds createSchema exactly as sas-lib', () => {
        const credential = client.getLensCredentialPda(authority).toBase58();
        const schema = client.getDecisionSchemaPda(credential)[0].toBase58();
        const ours = client.buildCreateDecisionSchemaIx({ payer, authority, credential });
        const theirs = sas.getCreateSchemaInstruction({ payer: signerOf(payer), authority: signerOf(authority), credential: kit.address(credential), schema: kit.address(schema),
            name: C.DECISION_SCHEMA_NAME, description: C.DECISION_SCHEMA_DESCRIPTION, layout: Uint8Array.from(C.DECISION_SCHEMA_LAYOUT), fieldNames: [...C.DECISION_SCHEMA_FIELDS] });
        expect(Buffer.from(ours.data).equals(Buffer.from(theirs.data))).toBe(true);
        expect(metas(ours)).toEqual(kitMetas(theirs));
    });

    it('builds createAttestation exactly as sas-lib', () => {
        const built = client.buildCreateDecisionAttestationIx({ payer, authority, fields, expiry: 2_000_000_000 });
        const theirs = sas.getCreateAttestationInstruction({ payer: signerOf(payer), authority: signerOf(authority), credential: kit.address(built.credential), schema: kit.address(built.schema),
            attestation: kit.address(built.attestation), nonce: kit.address(client.decisionNonce(fields).toBase58()), data: client.encodeDecisionPayload(fields), expiry: 2_000_000_000 });
        expect(Buffer.from(built.instruction.data).equals(Buffer.from(theirs.data))).toBe(true);
        expect(metas(built.instruction)).toEqual(kitMetas(theirs));
    });
});
