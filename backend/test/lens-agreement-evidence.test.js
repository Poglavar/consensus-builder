import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { buildSasAttestationAccount, deriveCredentialPda, deriveSchemaPda, encodeLensPayload } from '../oracle/lens-schemas.js';
import { createRequire } from 'node:module';
import Evidence from '../../frontend/js/lens-agreement-evidence.js';

const require = createRequire(import.meta.url);
const RealClient = require('../../frontend/js/solana/agreement-client.js').configure({ web3: { PublicKey } });

const sponsor = Keypair.generate().publicKey.toBase58();
const lens = Keypair.generate().publicKey.toBase58();
const credential = Keypair.generate().publicKey.toBase58();
const attestation = Keypair.generate().publicKey.toBase58();
const cid = 'bafkreihnfsdwy3dz4ywcukbiknoixg3acqt7jozxg532gbcj54ymys7ale';
const sas = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
const record = { cid, content: { sponsor }, onchain: { cluster: 'devnet', programId: 'AgreementProgram' } };
const baseClient = {
    constants: { AGREEMENT_PROGRAM_ID: 'AgreementProgram', SAS_PROGRAM_ID: sas, DECISION_PENDING: 0 },
    getAgreementPda: () => [new PublicKey(Keypair.generate().publicKey)],
    fetchAgreement: async () => ({ cid, authority: sponsor, lenses: [lens], decisionCode: 1, decisionAttestation: attestation, decisionHash: 'aa'.repeat(32) }),
    readDecisionAttestation: () => ({ address: attestation, credential, schema: 'schema', signer: lens, fields: { agreementCid: cid, sponsor, decision: 'satisfied' } }),
    getDecisionSchemaPda: () => [new PublicKey('11111111111111111111111111111111')]
};
const connection = { getAccountInfo: async key => key.toBase58() === attestation ? { owner: new PublicKey(sas), data: new Uint8Array([1]) } : { owner: new PublicKey(sas), data: Uint8Array.from([0, ...new PublicKey(lens).toBytes()]) } };

describe('LensAgreementEvidence.readChain', () => {
    it('reads an absent chain account without inventing a statement', async () => {
        const result = await Evidence.readChain({ record, connection, client: { ...baseClient, fetchAgreement: async () => null }, web3: { PublicKey } });
        expect(result).toEqual({ account: null, statement: null });
    });
    it('preserves a later expired chain outcome when statement proof fails', async () => {
        const result = await Evidence.readChain({ record, connection, client: baseClient, web3: { PublicKey }, crypto: { sha256Hex: async () => 'bb'.repeat(32) } });
        expect(result.account.decisionAttestation).toBe(attestation);
        expect(result.statement).toBeNull();
        expect(result.statementError).toMatch(/decisionHash/);
    });
    it('rejects indexed production network and program mismatches', async () => {
        await expect(Evidence.readChain({ record: { ...record, onchain: { ...record.onchain, cluster: 'mainnet-beta' } }, connection, client: baseClient, web3: { PublicKey } })).rejects.toThrow(/unsupported/);
        await expect(Evidence.readChain({ record: { ...record, onchain: { ...record.onchain, programId: 'other' } }, connection, client: baseClient, web3: { PublicKey } })).rejects.toThrow(/program/);
    });

    it('verifies authentic AgreementDecision bytes even after the agreement expires', async () => {
        const realCid = cid;
        const realSponsor = sponsor;
        const realLens = lens;
        const realCredential = deriveCredentialPda({ authority: realLens, name: 'LensMember' });
        const realSchema = deriveSchemaPda({ credential: realCredential, name: 'AgreementDecision', version: 1 });
        const bytes = buildSasAttestationAccount({
            nonce: Keypair.generate().publicKey.toBase58(), credential: realCredential, schema: realSchema, authority: realLens,
            expiry: 1_900_000_000,
            payload: encodeLensPayload('decision', { agreementCid: realCid, sponsor: realSponsor, decision: 'satisfied', evidenceRef: 'case-1', sourceObservedAt: 1_790_000_000 })
        });
        const address = Keypair.generate().publicKey.toBase58();
        const hash = createHash('sha256').update(bytes).digest('hex');
        const realClient = {
            ...RealClient,
            constants: { ...RealClient.constants, DECISION_PENDING: 0, AGREEMENT_PROGRAM_ID: RealClient.constants.AGREEMENT_PROGRAM_ID },
            fetchAgreement: async () => ({ cid: realCid, authority: realSponsor, lenses: [realLens], status: 'Expired', decisionCode: 1, decisionAttestation: address, decisionHash: hash }),
            getAgreementPda: (...args) => RealClient.getAgreementPda(...args)
        };
        const realConnection = { getAccountInfo: async key => key.toBase58() === address
            ? { owner: new PublicKey(realClient.constants.SAS_PROGRAM_ID), data: bytes }
            : { owner: new PublicKey(realClient.constants.SAS_PROGRAM_ID), data: Uint8Array.from([0, ...new PublicKey(realLens).toBytes()]) } };
        const result = await Evidence.readChain({ record: { cid: realCid, content: { sponsor: realSponsor }, onchain: { cluster: 'devnet', programId: realClient.constants.AGREEMENT_PROGRAM_ID } }, connection: realConnection, client: realClient, web3: { PublicKey }, crypto: { sha256Hex: async value => createHash('sha256').update(value).digest('hex') } });
        expect(result.account.status).toBe('Expired');
        expect(result.statement.verified).toBe(true);
        expect(result.statement.fields.decision).toBe('satisfied');
    });

    it('preserves chain outcome when signer or credential owner is forged', async () => {
        const forged = { ...baseClient, fetchAgreement: async () => ({ cid, authority: sponsor, lenses: [lens], status: 'Executed', decisionCode: 1, decisionAttestation: attestation, decisionHash: 'aa'.repeat(32) }), readDecisionAttestation: () => ({ address: attestation, credential, schema: 'schema', signer: sponsor, fields: { agreementCid: cid, sponsor, decision: 'satisfied' } }) };
        const result = await Evidence.readChain({ record, connection: { getAccountInfo: async () => ({ owner: new PublicKey(sponsor), data: Uint8Array.from([1]) }) }, client: forged, web3: { PublicKey }, crypto: { sha256Hex: async () => 'aa'.repeat(32) } });
        expect(result.account.status).toBe('Executed');
        expect(result.statement).toBeNull();
        expect(result.statementError).toMatch(/SAS|signer/);
    });
});
