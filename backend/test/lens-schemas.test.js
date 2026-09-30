// Lens-model SAS schemas: payload codec round trips, byte vectors produced by sas-lib 1.0.10
// serializeAttestationData / deriveCredentialPda / deriveSchemaPda, the account parser against a
// synthetic SAS attestation, and validator rejections.

import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
    buildSasAttestationAccount,
    decodeLensAttestation,
    decodeLensPayload,
    deriveLensSchemaPdas,
    describeLensSchemas,
    encodeLensPayload,
    LENS_SCHEMAS,
    parseLensAttestation,
    sha256Hex,
    validateOwnership,
    validateVerdict
} from '../oracle/lens-schemas.js';

const KEY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const OWNERSHIP = { parcelUid: 'HR-335550-1234/1', owner: KEY, ownerCount: 2, evidenceRef: 'ž-case', sourceObservedAt: 1790000000 };
const VERDICT = { proposalAccount: KEY, verdict: 'expired', evidenceRef: 'x', sourceObservedAt: 1790000001 };

// Hex produced by sas-lib serializeAttestationData for the same values and layouts.
const SAS_LIB_HEX = {
    ownership: '1000000048522d3333353535302d313233342f312c000000414d6273695039463859593279386e3975466471747737794e5a5a48765457464557535147484b746d6b6f510207000000c5be2d63617365803bb16a00000000',
    verdict: '2c000000414d6273695039463859593279386e3975466471747737794e5a5a48765457464557535147484b746d6b6f5107000000657870697265640100000078813bb16a00000000'
};

describe('lens schema definitions', () => {
    it('carry the frozen layout strings and SAS layout bytes', () => {
        expect(LENS_SCHEMAS.ownership.layout).toBe('string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt');
        expect(LENS_SCHEMAS.verdict.layout).toBe('string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt');
        expect(LENS_SCHEMAS.ownership.sasLayout).toEqual([12, 12, 0, 12, 8]);
        expect(LENS_SCHEMAS.verdict.sasLayout).toEqual([12, 12, 12, 8]);
        expect(describeLensSchemas().map(s => s.id)).toEqual(['ParcelOwnership-v1', 'ProposalVerdict-v1']);
    });
});

describe('borsh payload codec', () => {
    it.each([
        ['ownership', OWNERSHIP],
        ['verdict', VERDICT]
    ])('%s encodes to the sas-lib bytes and decodes back', (kind, values) => {
        const bytes = encodeLensPayload(kind, values);
        expect(bytes.toString('hex')).toBe(SAS_LIB_HEX[kind]);
        expect(decodeLensPayload(kind, bytes)).toEqual(values);
    });

    it('keeps ownerCount 2 for each owner of a co-owned parcel', () => {
        const other = Keypair.generate().publicKey.toBase58();
        const decoded = [KEY, other].map(owner => decodeLensPayload('ownership', encodeLensPayload('ownership', { ...OWNERSHIP, owner })));
        expect(decoded.map(d => d.owner)).toEqual([KEY, other]);
        expect(decoded.map(d => d.ownerCount)).toEqual([2, 2]);
    });

    it('rejects truncated and trailing bytes', () => {
        const bytes = encodeLensPayload('verdict', VERDICT);
        expect(() => decodeLensPayload('verdict', bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
        expect(() => decodeLensPayload('verdict', Buffer.concat([bytes, Buffer.from([0])]))).toThrow(/trailing/);
    });

    it('refuses values that do not fit the layout', () => {
        expect(() => encodeLensPayload('ownership', { ...OWNERSHIP, ownerCount: 256 })).toThrow(/uint8/);
        expect(() => encodeLensPayload('ownership', { ...OWNERSHIP, parcelUid: 7 })).toThrow(/string/);
        expect(() => encodeLensPayload('verdict', { ...VERDICT, sourceObservedAt: 1.5 })).toThrow(/integer/);
    });
});

describe('parseLensAttestation', () => {
    const nonce = Keypair.generate().publicKey.toBase58();
    const credential = Keypair.generate().publicKey.toBase58();
    const schema = Keypair.generate().publicKey.toBase58();
    const authority = Keypair.generate().publicKey.toBase58();
    const payload = encodeLensPayload('ownership', OWNERSHIP);
    const account = buildSasAttestationAccount({ nonce, credential, schema, payload, authority, expiry: 1900000000 });

    it('reads every field from the exact SAS byte layout', () => {
        // disc 1 + nonce 32 + credential 32 + schema 32 + len 4 + payload + signer 32 + expiry 8 + token 32
        expect(account.length).toBe(101 + payload.length + 72);
        expect(account[0]).toBe(2);
        expect(account.readUInt32LE(97)).toBe(payload.length);
        const parsed = parseLensAttestation(account);
        expect(parsed).toMatchObject({ nonce, credential, schema, authority, expiry: 1900000000n });
        expect(Buffer.from(parsed.payload).equals(payload)).toBe(true);
    });

    it('decodes and validates in one step with the account hash', () => {
        const decoded = decodeLensAttestation('ownership', account);
        expect(decoded.fields).toEqual(OWNERSHIP);
        expect(decoded.accountHash).toBe(sha256Hex(account));
        expect(decoded.accountHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects non-attestation and truncated accounts', () => {
        const wrong = Buffer.from(account);
        wrong[0] = 1;
        expect(() => parseLensAttestation(wrong)).toThrow(/not a SAS attestation/);
        const lying = Buffer.from(account);
        lying.writeUInt32LE(payload.length + 100, 97);
        expect(() => parseLensAttestation(lying)).toThrow(/truncated/);
    });
});

describe('validators', () => {
    it('accept well-formed payloads', () => {
        expect(validateOwnership(OWNERSHIP)).toBe(OWNERSHIP);
        expect(validateVerdict({ ...VERDICT, verdict: 'executed' })).toBeTruthy();
    });

    it.each([
        [() => validateOwnership({ ...OWNERSHIP, parcelUid: ' ' }), /parcelUid/],
        [() => validateOwnership({ ...OWNERSHIP, owner: 'not-a-key' }), /owner/],
        [() => validateOwnership({ ...OWNERSHIP, ownerCount: 0 }), /ownerCount/],
        [() => validateOwnership({ ...OWNERSHIP, sourceObservedAt: 0 }), /sourceObservedAt/],
        [() => validateOwnership(OWNERSHIP, { nowSeconds: 1700000000 }), /future/],
        [() => validateVerdict({ ...VERDICT, verdict: 'cancelled' }), /verdict/]
    ])('rejects %#', (call, message) => {
        expect(call).toThrow(message);
    });
});

describe('PDA derivation', () => {
    it('matches sas-lib deriveCredentialPda / deriveSchemaPda', () => {
        // Expected values computed with sas-lib 1.0.10 for authority KEY, credential name LensMember.
        expect(deriveLensSchemaPdas({ authority: KEY, credentialName: 'LensMember' })).toEqual({
            credential: '8xXFCwX7ktNopNTi2LxNrNwAUhnpCjzU76V8KetnFAMJ',
            schemas: {
                ownership: 'Hzs9t2CcHVNSJYxrgcBY7sCpr8MoY6VM95Xm5K54m7pv',
                verdict: 'DHvDAKSvUAkPqwhgeaZ9f2KY2hFjRtzeWtGxhKcpBNMe'
            }
        });
    });

    it('refuses names beyond the 32-byte seed limit', () => {
        expect(() => deriveLensSchemaPdas({ authority: KEY, credentialName: 'x'.repeat(33) })).toThrow(/32 bytes/);
    });
});
