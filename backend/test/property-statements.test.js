// Lens members' property statements built in the browser (frontend/js/solana/property-statements.js):
// byte-identical to sas-lib, the schemas restated from backend/oracle/lens-schemas.js, one first-holder
// address per lens member and asset, and the holding payload read back.
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as kit from '@solana/kit';
import * as sas from 'sas-lib';
import { LENS_SCHEMAS, deriveLensSchemaPdas, buildSasAttestationAccount } from '../oracle/lens-schemas.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const S = require('../../frontend/js/solana/property-statements.js');
S.configure({ web3 });
afterAll(() => { S.configure({ web3: null }); });

const authority = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 3)).publicKey.toBase58();
const holder = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 90 - i)).publicKey.toBase58();
const assetHash = 'ab'.repeat(32);
const signerOf = address => ({ address: kit.address(address), signTransactions: async () => [] });
const metas = ix => ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const kitMetas = ix => ix.accounts.map(a => [a.address, a.role >= 2, (a.role & 1) === 1]);

describe('property statements from a lens member’s wallet', () => {
    it('restates the backend schema definitions', () => {
        for (const [kind, backend] of [['holding', LENS_SCHEMAS.holding], ['confirmation', LENS_SCHEMAS.offerConfirmation]]) {
            expect(S.SCHEMAS[kind]).toMatchObject({ name: backend.name, version: backend.version, description: backend.description });
            expect(S.SCHEMAS[kind].fields).toEqual(backend.fields.map(f => f.name));
            expect(S.SCHEMAS[kind].layout).toEqual([...backend.sasLayout]);
        }
    });
    it('derives the credential and schemas as the reference lens member does', () => {
        const { credential, schemas } = deriveLensSchemaPdas({ authority, credentialName: S.constants.CREDENTIAL_NAME });
        expect(S.credentialPda(authority).toBase58()).toBe(credential);
        expect(S.schemaPda(credential, 'holding').toBase58()).toBe(schemas.holding);
        expect(S.schemaPda(credential, 'confirmation').toBase58()).toBe(schemas.offerConfirmation);
    });
    it('builds createSchema, createAttestation and closeAttestation exactly as sas-lib', () => {
        const credential = S.credentialPda(authority).toBase58();
        const ours = S.buildCreateSchemaIx({ payer: authority, authority, kind: 'holding' });
        const theirs = sas.getCreateSchemaInstruction({ payer: signerOf(authority), authority: signerOf(authority), credential: kit.address(credential), schema: kit.address(S.schemaPda(credential, 'holding').toBase58()),
            name: 'PropertyHolding', description: S.SCHEMAS.holding.description, layout: Uint8Array.from(S.SCHEMAS.holding.layout), fieldNames: S.SCHEMAS.holding.fields });
        expect(Buffer.from(ours.data).equals(Buffer.from(theirs.data))).toBe(true);
        expect(metas(ours)).toEqual(kitMetas(theirs));
        const built = S.buildHoldingIx({ payer: authority, authority, assetHash, asset: '["parcel/v1","s","1"]', holder, basis: 'declared', evidence: 'request:1', observedAt: 1_764_000_000 });
        const payload = S.encodeHoldingPayload({ assetHash, asset: '["parcel/v1","s","1"]', holder, basis: 'declared', evidence: 'request:1', observedAt: 1_764_000_000 });
        const att = sas.getCreateAttestationInstruction({ payer: signerOf(authority), authority: signerOf(authority), credential: kit.address(built.credential), schema: kit.address(built.schema),
            attestation: kit.address(built.attestation), nonce: kit.address(new web3.PublicKey(Buffer.from(assetHash, 'hex')).toBase58()), data: payload, expiry: 1_764_000_000 + S.constants.STATEMENT_EXPIRY_SECONDS });
        expect(Buffer.from(built.instruction.data).equals(Buffer.from(att.data))).toBe(true);
        expect(metas(built.instruction)).toEqual(kitMetas(att));
        expect(built.attestation).toBe(S.holdingAddress(authority, assetHash).toBase58());
        const close = S.buildCloseAttestationIx({ payer: authority, authority, attestation: built.attestation });
        const theirClose = sas.getCloseAttestationInstruction({ payer: signerOf(authority), authority: signerOf(authority), credential: kit.address(built.credential), attestation: kit.address(built.attestation) });
        expect(Buffer.from(close.data).equals(Buffer.from(theirClose.data))).toBe(true);
        expect(metas(close)).toEqual(kitMetas(theirClose));
    });
    it('reads a first-holder statement back and refuses an unknown basis', () => {
        const { credential, schemas } = deriveLensSchemaPdas({ authority, credentialName: S.constants.CREDENTIAL_NAME });
        const payload = S.encodeHoldingPayload({ assetHash, asset: 'a', holder, basis: 'developer', observedAt: 5 });
        const account = buildSasAttestationAccount({ nonce: new web3.PublicKey(Buffer.from(assetHash, 'hex')).toBase58(), credential, schema: schemas.holding, payload: Buffer.from(payload), authority, expiry: 9 });
        expect(S.readHolding(new Uint8Array(account)).fields).toEqual({ assetHash, asset: 'a', holder, basis: 'developer', evidence: '', observedAt: 5n });
        expect(() => S.encodeHoldingPayload({ assetHash, asset: 'a', holder, basis: 'rumour', observedAt: 5 })).toThrow(/basis/);
    });
});
