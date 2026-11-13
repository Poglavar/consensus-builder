// The lens member's EVM issuer (lens/evm-issuer.js, docs/blockchain-flows.md R4): the AgreementDecision-v1
// data Agreement.sol decodes, the uid taken from the receipt's Attested log, and the attest flow over a
// fake EAS contract: the request it sends, the attestation it reads back, and every refusal.
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
    DECISION_DATA_TYPES, DECISION_SCHEMA_TEXT, EAS_ABI, attestedUidOf, createEvmIssuer, encodeDecisionData, lensEvmKeyOf
} from '../lens/evm-issuer.js';
import { loadAddressBook } from '../chain/evm.js';

const PRIVATE_KEY = `0x${'5a'.repeat(32)}`;
const LENS = new ethers.Wallet(PRIVATE_KEY).address;
const SPONSOR = new ethers.Wallet(`0x${'11'.repeat(32)}`).address;
const CHAIN_ID = '84532';
const BOOK = loadAddressBook();
const EAS = BOOK[CHAIN_ID].EAS;
const SCHEMA = BOOK[CHAIN_ID].AgreementDecisionSchema;
const CID = 'bafkreihnfsdwy3dz4ywcukbiknoixg3acqt7jozxg532gbcj54ymys7ale';
const FIELDS = { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'ab'.repeat(32)}`, sourceObservedAt: 1790000001 };
const UID = `0x${'c1'.repeat(32)}`;
const TX = `0x${'d2'.repeat(32)}`;
const iface = new ethers.Interface(EAS_ABI);

// An Attested log as EAS emits it: recipient, attester and schema indexed, the uid in the data.
const attestedLog = ({ address = EAS, attester = LENS, uid = UID, schema = SCHEMA } = {}) => {
    const { topics, data } = iface.encodeEventLog('Attested', [ethers.ZeroAddress, attester, uid, schema]);
    return { address, topics, data };
};

describe('AgreementDecision-v1 data', () => {
    it('is abi.encode(string, address, string, string, uint64) of the five fields, in the schema\'s order', () => {
        expect(DECISION_SCHEMA_TEXT).toBe('string agreementCid, address sponsor, string decision, string evidenceRef, uint64 sourceObservedAt');
        expect(DECISION_DATA_TYPES).toEqual(DECISION_SCHEMA_TEXT.split(', ').map(part => part.split(' ')[0]));
        const data = encodeDecisionData(FIELDS);
        // The same bytes as a call with those argument types, without its 4-byte selector.
        const call = new ethers.Interface(['function f(string, address, string, string, uint64)']).encodeFunctionData('f', [CID, SPONSOR, 'satisfied', FIELDS.evidenceRef, FIELDS.sourceObservedAt]);
        expect(data).toBe(`0x${call.slice(10)}`);
        // The head: three string offsets around the address word, then the uint64 as the fifth word.
        const word = index => data.slice(2 + index * 64, 2 + (index + 1) * 64);
        expect(word(1)).toBe(SPONSOR.slice(2).toLowerCase().padStart(64, '0'));
        expect(BigInt(`0x${word(4)}`)).toBe(1790000001n);
        expect(ethers.AbiCoder.defaultAbiCoder().decode(DECISION_DATA_TYPES, data).toArray())
            .toEqual([CID, SPONSOR, 'satisfied', FIELDS.evidenceRef, 1790000001n]);
    });
});

describe('the uid of an attestation', () => {
    it('is the Attested log of the EAS contract for this attester and schema', () => {
        const receipt = { hash: TX, logs: [attestedLog({ address: SPONSOR, uid: `0x${'01'.repeat(32)}` }), attestedLog({ attester: SPONSOR, uid: `0x${'02'.repeat(32)}` }),
            attestedLog({ schema: `0x${'03'.repeat(32)}`, uid: `0x${'04'.repeat(32)}` }), { address: EAS, topics: [ethers.ZeroHash], data: '0x' }, attestedLog()] };
        expect(attestedUidOf(receipt, { eas: EAS.toLowerCase(), attester: LENS, schemaUid: SCHEMA })).toBe(UID);
    });

    it('refuses a receipt without it, or with two', () => {
        expect(() => attestedUidOf({ hash: TX, logs: [attestedLog({ attester: SPONSOR })] }, { eas: EAS, attester: LENS, schemaUid: SCHEMA }))
            .toThrowError(expect.objectContaining({ code: 'attestation-not-logged' }));
        expect(() => attestedUidOf({ hash: TX, logs: [attestedLog(), attestedLog({ uid: TX })] }, { eas: EAS, attester: LENS, schemaUid: SCHEMA }))
            .toThrowError(expect.objectContaining({ code: 'attestation-ambiguous' }));
    });
});

describe('createEvmIssuer', () => {
    // A fake EAS contract: records the attest request, answers with `receipt` and stores `stored`.
    function fakeEas({ receiptStatus = 1, logs = [attestedLog()], stored = null } = {}) {
        const calls = { attest: [], get: [] };
        const eas = {
            async attest(request) {
                calls.attest.push(request);
                return { hash: TX, wait: async () => ({ hash: TX, status: receiptStatus, logs }) };
            },
            async getAttestation(uid) {
                calls.get.push(uid);
                const request = calls.attest[0];
                return stored ?? { uid, schema: request.schema, time: 1790000100n, expirationTime: request.data.expirationTime, revocationTime: 0n,
                    refUID: ethers.ZeroHash, recipient: ethers.ZeroAddress, attester: LENS, revocable: true, data: request.data.data };
            }
        };
        return { eas, calls };
    }
    const issuerWith = fake => createEvmIssuer({ privateKey: PRIVATE_KEY, env: {}, easFor: ({ config, wallet }) => {
        expect([config.addresses.EAS, wallet.address]).toEqual([EAS, LENS]);
        return fake.eas;
    } });
    const request = { chainId: CHAIN_ID, schemaUid: SCHEMA, data: encodeDecisionData(FIELDS), expirationTime: 1821536001 };

    it('attests through EAS, takes the uid from the log and the time from the attestation read back', async () => {
        const fake = fakeEas();
        const issuer = issuerWith(fake);
        expect(issuer.address).toBe(LENS);
        expect(await issuer.attest(request)).toEqual({ uid: UID, txHash: TX, issuedAt: 1790000100 });
        const [sent] = fake.calls.attest;
        expect(sent).toEqual({ schema: SCHEMA, data: { recipient: ethers.ZeroAddress, expirationTime: 1821536001n, revocable: true, refUID: ethers.ZeroHash, data: request.data, value: 0n } });
        // The request is exactly what the attest ABI encodes (the registered schema is revocable).
        expect(iface.decodeFunctionData('attest', iface.encodeFunctionData('attest', [sent]))[0].schema).toBe(SCHEMA);
        expect(fake.calls.get).toEqual([UID]);
    });

    it('refuses a failed transaction, an attestation that does not carry the request, and another schema', async () => {
        await expect(issuerWith(fakeEas({ receiptStatus: 0 })).attest(request)).rejects.toMatchObject({ code: 'attest-failed' });
        await expect(issuerWith(fakeEas({ logs: [] })).attest(request)).rejects.toMatchObject({ code: 'attestation-not-logged' });
        const tampered = { uid: UID, schema: SCHEMA, time: 1n, expirationTime: 1821536001n, attester: LENS, data: encodeDecisionData({ ...FIELDS, decision: 'refused' }) };
        await expect(issuerWith(fakeEas({ stored: tampered })).attest(request)).rejects.toMatchObject({ code: 'attestation-mismatch' });
        await expect(issuerWith(fakeEas({ stored: { ...tampered, data: request.data, attester: SPONSOR } })).attest(request)).rejects.toMatchObject({ code: 'attestation-mismatch' });
        const other = fakeEas();
        await expect(issuerWith(other).attest({ ...request, schemaUid: `0x${'03'.repeat(32)}` })).rejects.toMatchObject({ code: 'wrong-schema' });
        expect(other.calls.attest).toEqual([]);
        await expect(issuerWith(fakeEas()).attest({ ...request, chainId: '1' })).rejects.toMatchObject({ code: 'unknown-chain' });
    });

    it('needs a valid key, and never names it in an error', () => {
        expect(() => createEvmIssuer({ privateKey: null })).toThrowError(expect.objectContaining({ code: 'no-evm-key' }));
        const secret = `0x${'zz'.repeat(32)}`;
        let error = null;
        try { createEvmIssuer({ privateKey: secret }); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: 'invalid-evm-key' });
        expect(error.message).not.toContain('zz');
    });

    it('reads LENS_EVM_PRIVATE_KEY, else UGT_AGENT_EVM_PRIVATE_KEY', () => {
        expect(lensEvmKeyOf({ LENS_EVM_PRIVATE_KEY: 'a', UGT_AGENT_EVM_PRIVATE_KEY: 'b' })).toBe('a');
        expect(lensEvmKeyOf({ UGT_AGENT_EVM_PRIVATE_KEY: ' b ' })).toBe('b');
        expect(lensEvmKeyOf({ LENS_EVM_PRIVATE_KEY: ' ' })).toBeNull();
    });
});
