// Lens-model SAS schemas (ParcelOwnership-v1, AgreementDecision-v1, MarketEvidence-v1): payload codec
// round trips, byte vectors produced by sas-lib 1.0.10 serializeAttestationData / deriveCredentialPda /
// deriveSchemaPda, the account parser against a synthetic SAS attestation, and validator rejections.

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
    validateDecision,
    validateOwnership
} from '../oracle/lens-schemas.js';

const KEY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
// An agreement CID (cidOfObject({ schema: 'agreement/v1', title: 'vector' })).
const CID = 'bafkreihnfsdwy3dz4ywcukbiknoixg3acqt7jozxg532gbcj54ymys7ale';
const OWNERSHIP = { parcelUid: 'HR-335550-1234/1', owner: KEY, ownerCount: 2, evidenceRef: 'ž-case', sourceObservedAt: 1790000000 };
const DECISION = { agreementCid: CID, sponsor: KEY, decision: 'satisfied', evidenceRef: `sha256:${'ab'.repeat(32)}`, sourceObservedAt: 1790000001 };

// Hex produced by sas-lib serializeAttestationData for the same values and layouts.
const SAS_LIB_HEX = {
    ownership: '1000000048522d3333353535302d313233342f312c000000414d6273695039463859593279386e3975466471747737794e5a5a48765457464557535147484b746d6b6f510207000000c5be2d63617365803bb16a00000000',
    decision: '3b0000006261666b726569686e667364777933647a34797763756b62696b6e6f6978673361637174376a6f7a78673533326762636a3534796d797337616c652c000000414d6273695039463859593279386e3975466471747737794e5a5a48765457464557535147484b746d6b6f5109000000736174697366696564470000007368613235363a61626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162813bb16a00000000'
};

describe('lens schema definitions', () => {
    it('carry the frozen layout strings and SAS layout bytes', () => {
        expect(LENS_SCHEMAS.ownership.layout).toBe('string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt');
        expect(LENS_SCHEMAS.decision.layout).toBe('string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt');
        expect(LENS_SCHEMAS.ownership.sasLayout).toEqual([12, 12, 0, 12, 8]);
        // programs/agreement/README.md: the agreement program's attest parses exactly this layout.
        expect(LENS_SCHEMAS.decision.sasLayout).toEqual([12, 12, 12, 12, 8]);
        expect(LENS_SCHEMAS.decision).toMatchObject({ id: 'AgreementDecision-v1', name: 'AgreementDecision', version: 1 });
        expect(describeLensSchemas().map(s => s.id)).toEqual(['ParcelOwnership-v1', 'AgreementDecision-v1', 'MarketEvidence-v1']);
    });
});

describe('borsh payload codec', () => {
    it.each([
        ['ownership', OWNERSHIP],
        ['decision', DECISION]
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
        const bytes = encodeLensPayload('decision', DECISION);
        expect(() => decodeLensPayload('decision', bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
        expect(() => decodeLensPayload('decision', Buffer.concat([bytes, Buffer.from([0])]))).toThrow(/trailing/);
    });

    it('refuses values that do not fit the layout', () => {
        expect(() => encodeLensPayload('ownership', { ...OWNERSHIP, ownerCount: 256 })).toThrow(/uint8/);
        expect(() => encodeLensPayload('ownership', { ...OWNERSHIP, parcelUid: 7 })).toThrow(/string/);
        expect(() => encodeLensPayload('decision', { ...DECISION, sourceObservedAt: 1.5 })).toThrow(/integer/);
        expect(() => encodeLensPayload('verdict', DECISION)).toThrow(/unknown lens schema kind/);
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
        expect(validateDecision(DECISION, { nowSeconds: DECISION.sourceObservedAt })).toBe(DECISION);
    });

    it('decodes a decision attestation account and validates it in one step', () => {
        const account = buildSasAttestationAccount({
            nonce: Keypair.generate().publicKey.toBase58(), credential: Keypair.generate().publicKey.toBase58(),
            schema: Keypair.generate().publicKey.toBase58(), payload: encodeLensPayload('decision', DECISION),
            authority: KEY, expiry: 1900000000
        });
        expect(decodeLensAttestation('decision', account).fields).toEqual(DECISION);
        const refused = buildSasAttestationAccount({
            nonce: KEY, credential: KEY, schema: KEY, authority: KEY, expiry: 1900000000,
            payload: encodeLensPayload('decision', { ...DECISION, decision: 'refused' })
        });
        expect(() => decodeLensAttestation('decision', refused)).toThrow(/satisfied/);
    });

    it.each([
        [() => validateOwnership({ ...OWNERSHIP, parcelUid: ' ' }), /parcelUid/],
        [() => validateOwnership({ ...OWNERSHIP, owner: 'not-a-key' }), /owner/],
        [() => validateOwnership({ ...OWNERSHIP, ownerCount: 0 }), /ownerCount/],
        [() => validateOwnership({ ...OWNERSHIP, sourceObservedAt: 0 }), /sourceObservedAt/],
        [() => validateOwnership(OWNERSHIP, { nowSeconds: 1700000000 }), /future/],
        // The lens never refuses (plan-design-agreement.md M3): satisfied is the only decision it states.
        [() => validateDecision({ ...DECISION, decision: 'refused' }), /satisfied/],
        [() => validateDecision({ ...DECISION, decision: 'pending' }), /satisfied/],
        [() => validateDecision({ ...DECISION, decision: 'Satisfied' }), /satisfied/],
        // The program compares the CID byte for byte with the account's: only the canonical bafkrei… spelling.
        [() => validateDecision({ ...DECISION, agreementCid: CID.toUpperCase() }), /agreementCid/],
        [() => validateDecision({ ...DECISION, agreementCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }), /agreementCid/],
        [() => validateDecision({ ...DECISION, sponsor: 'not-a-key' }), /sponsor/],
        [() => validateDecision({ ...DECISION, evidenceRef: ' ' }), /evidenceRef/],
        [() => validateDecision({ ...DECISION, sourceObservedAt: 0 }), /sourceObservedAt/],
        [() => validateDecision(DECISION, { nowSeconds: DECISION.sourceObservedAt - 1 }), /future/]
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
                decision: '7JfxNayp1sLAWjpUvvQnbnSmiPLsKHrMv6BpPPyhjP3T',
                evidence: 'C9Cyyr5HcjUdbBBjsY84Tm1gvPsCrsprc2SPk2EoVjTD'
            }
        });
    });

    it('refuses names beyond the 32-byte seed limit', () => {
        expect(() => deriveLensSchemaPdas({ authority: KEY, credentialName: 'x'.repeat(33) })).toThrow(/32 bytes/);
    });
});
