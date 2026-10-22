// Cross-check of the lens's AgreementDecision-v1 attestation between its issuer side
// (backend/oracle/lens-schemas.js: payload codec, SAS account layout, schema PDAs) and the agreement
// codec the browser and the agents record it with (frontend/js/solana/agreement-client.js:
// readDecisionAttestation, getDecisionSchemaPda, checkDecisionForAttest mirroring the program's attest).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import {
    LENS_SCHEMAS,
    buildSasAttestationAccount,
    decodeLensPayload,
    deriveCredentialPda,
    deriveLensSchemaPdas,
    deriveSchemaPda,
    encodeLensPayload,
    parseLensAttestation
} from '../oracle/lens-schemas.js';
import { cidOfObject } from '../cid.js';
import { agreementAccountBytes } from './fixtures/agreement-account.js';

const require = createRequire(import.meta.url);
const AgreementClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3 });

const key = byte => new web3.PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const LENS = key(3);
const SPONSOR = key(5);
const STRANGER = key(7);
const NONCE = key(9);
const CID = cidOfObject({ schema: 'agreement/v1', title: 'Riverside deal' });
const NOW = 1_790_000_000;
const CREDENTIAL = deriveCredentialPda({ authority: LENS, name: 'LensMember' });
const SCHEMA = deriveSchemaPda({ credential: CREDENTIAL, name: 'AgreementDecision', version: 1 });

const decisionFields = (overrides = {}) => ({
    agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'ab'.repeat(32)}`, sourceObservedAt: NOW - 60, ...overrides
});
// The SAS account the lens member's issuer writes for these fields.
function attestationBytes({ fields = decisionFields(), credential = CREDENTIAL, schema = SCHEMA, authority = LENS, expiry = NOW + 86_400, payload } = {}) {
    return buildSasAttestationAccount({ nonce: NONCE, credential, schema, authority, expiry, payload: payload ?? encodeLensPayload('decision', fields) });
}
const attestation = options => AgreementClient.readDecisionAttestation(attestationBytes(options), key(11));
// The agreement account as the program writes it, read with the codec.
const agreement = (overrides = {}) => AgreementClient.readAgreement(agreementAccountBytes({
    cid: CID, authority: SPONSOR, lens: LENS, deadline: NOW + 3_600, ...overrides
}), key(13));

describe('the AgreementDecision-v1 schema the lens issues under', () => {
    it('is the PDA the codec checks: ["schema", credential, "AgreementDecision", [1]] under SAS', () => {
        expect(LENS_SCHEMAS.decision).toMatchObject({ name: 'AgreementDecision', version: 1, sasLayout: [12, 12, 12, 12, 8] });
        expect(AgreementClient.getDecisionSchemaPda(CREDENTIAL)[0].toBase58()).toBe(SCHEMA);
        expect(deriveLensSchemaPdas({ authority: LENS, credentialName: 'LensMember' })).toMatchObject({ credential: CREDENTIAL, schemas: { decision: SCHEMA } });
        // Another member's credential has its own schema.
        expect(AgreementClient.getDecisionSchemaPda(deriveCredentialPda({ authority: STRANGER, name: 'LensMember' }))[0].toBase58()).not.toBe(SCHEMA);
    });
});

describe('readDecisionAttestation over the issuer\'s bytes', () => {
    it('reads exactly what lens-schemas encoded, as the backend parser does', () => {
        const bytes = attestationBytes();
        const read = AgreementClient.readDecisionAttestation(bytes, key(11));
        expect(read).toEqual({
            address: key(11), nonce: NONCE, credential: CREDENTIAL, schema: SCHEMA, signer: LENS, expiry: NOW + 86_400,
            fields: decisionFields()
        });
        const parsed = parseLensAttestation(bytes);
        expect(parsed).toMatchObject({ nonce: NONCE, credential: CREDENTIAL, schema: SCHEMA, authority: LENS, expiry: BigInt(NOW + 86_400) });
        expect(decodeLensPayload('decision', parsed.payload)).toEqual(read.fields);
    });

    it('refuses trailing payload bytes and accounts that are not SAS attestations, on both sides', () => {
        const padded = Buffer.concat([encodeLensPayload('decision', decisionFields()), Buffer.from([0])]);
        expect(() => attestation({ payload: padded })).toThrow(/trailing bytes/);
        expect(() => decodeLensPayload('decision', padded)).toThrow(/trailing bytes/);
        const notSas = attestationBytes();
        notSas[0] = 1;
        expect(() => AgreementClient.readDecisionAttestation(notSas)).toThrow(/not a SAS attestation/);
        expect(() => parseLensAttestation(notSas)).toThrow(/not a SAS attestation/);
        expect(() => AgreementClient.readDecisionAttestation(attestationBytes().subarray(0, 120))).toThrow(RangeError);
    });
});

describe('checkDecisionForAttest (the program\'s attest checks the two accounts can answer)', () => {
    const check = (agreementOverrides, attestationOptions, nowSeconds = NOW) => AgreementClient.checkDecisionForAttest({
        agreement: agreement(agreementOverrides), attestation: attestation(attestationOptions), nowSeconds
    });

    it('passes the lens\'s satisfied decision for this account\'s CID and sponsor, before the deadline', () => {
        expect(check()).toBeNull();
        // An agreement without a deadline never expires.
        expect(check({ deadline: 0 }, undefined, NOW + 10 * 365 * 86_400)).toBe('attestation-expired');
        expect(check({ deadline: 0 }, { expiry: NOW + 20 * 365 * 86_400 }, NOW + 10 * 365 * 86_400)).toBeNull();
    });

    it('refuses an attestation that does not fit this account: sponsor, CID, lens or schema', () => {
        // Another wallet's account for the same CID can never record the decision: it names another sponsor.
        expect(check({}, { fields: decisionFields({ sponsor: STRANGER }) })).toBe('wrong-sponsor');
        expect(check({ authority: STRANGER })).toBe('wrong-sponsor');
        expect(check({}, { fields: decisionFields({ agreementCid: cidOfObject({ other: true }) }) })).toBe('wrong-cid');
        expect(check({}, { authority: STRANGER })).toBe('wrong-lens');
        expect(check({ lens: STRANGER })).toBe('wrong-lens');
        const otherCredential = deriveCredentialPda({ authority: LENS, name: 'OtherCredential' });
        expect(check({}, { credential: otherCredential })).toBe('wrong-schema');
    });

    it('refuses anything but a satisfied decision (the lens never refuses), and times that do not hold', () => {
        expect(check({}, { fields: decisionFields({ decision: 'refused' }) })).toBe('unknown-decision');
        expect(check({}, { fields: decisionFields({ sourceObservedAt: NOW + 1 }) })).toBe('observed-in-future');
        expect(check({}, { expiry: NOW })).toBe('attestation-expired');
        expect(check({ deadline: NOW - 1 })).toBe('deadline-passed');
    });

    it('refuses once the account left Active or already recorded its decision', () => {
        expect(check({ decision: 1, decisionAttestedAt: NOW - 10 })).toBe('decision-recorded');
        for (const status of [1, 2, 3]) expect(check({ status })).toBe('not-active');
        expect(AgreementClient.checkDecisionForAttest({ agreement: null, attestation: attestation(), nowSeconds: NOW })).toBe('agreement-missing');
        expect(AgreementClient.checkDecisionForAttest({ agreement: agreement(), attestation: null, nowSeconds: NOW })).toBe('attestation-missing');
    });
});
